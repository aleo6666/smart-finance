"""外部数据导入 API：银行账单 PDF / 支付宝微信 CSV / 发票 OCR 记账。

全部遵循 preview → confirm 两段式：预览只解析并返回交易建议，绝不入库；
确认接口才批量写入 records（归属当前 token 用户）。发票凭证上传保存到
uploads/ 目录，确认后把 receipt_path 落到 Transaction 上。
"""

from datetime import date, datetime, time
from decimal import Decimal, ROUND_HALF_UP
import hashlib
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, ConfigDict, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_or_create_default_ledger
from app.api.ocr import get_ocr_engine
from app.core.config import Settings, get_settings
from app.core.database import get_db
from app.models import Transaction
from app.services.importers.bank_statement import (
    BankStatementError,
    extract_pdf_text,
    parse_bank_statement,
)
from app.services.importers.csv_bill import CsvBillError, decode_bytes, parse_csv_bill
from app.services.ocr import OcrEngine, OcrUnavailable, extract_receipt_fields

router = APIRouter(prefix="/api/import", tags=["import"])

MONEY = Decimal("0.01")
_ALLOWED_IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"}


class ImportTransaction(BaseModel):
    """确认导入的单条交易。"""

    model_config = ConfigDict(extra="ignore")

    date: str
    description: str = ""
    amount: Decimal
    type: str
    category: str

    @field_validator("type")
    @classmethod
    def _validate_type(cls, value: str) -> str:
        if value not in {"income", "expense"}:
            raise ValueError("type must be income or expense")
        return value

    @field_validator("amount")
    @classmethod
    def _validate_amount(cls, value: Decimal) -> Decimal:
        quantized = value.quantize(MONEY, rounding=ROUND_HALF_UP)
        if quantized <= 0:
            raise ValueError("amount must be positive")
        return quantized

    @field_validator("date")
    @classmethod
    def _validate_date(cls, value: str) -> str:
        try:
            return date.fromisoformat(value).isoformat()
        except ValueError:
            raise ValueError("invalid date, expected YYYY-MM-DD") from None


class ImportConfirmPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")

    bank_name: str | None = None
    platform: str | None = None
    transactions: list[ImportTransaction]


class ReceiptConfirmPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")

    receipt_path: str | None = None
    type: str = "expense"
    category: str
    amount: Decimal
    date: str | None = None
    note: str | None = None

    @field_validator("type")
    @classmethod
    def _validate_type(cls, value: str) -> str:
        if value not in {"income", "expense"}:
            raise ValueError("type must be income or expense")
        return value

    @field_validator("amount")
    @classmethod
    def _validate_amount(cls, value: Decimal) -> Decimal:
        quantized = value.quantize(MONEY, rounding=ROUND_HALF_UP)
        if quantized <= 0:
            raise ValueError("amount must be positive")
        return quantized

    @field_validator("date")
    @classmethod
    def _validate_date(cls, value: str | None) -> str | None:
        if value is None:
            return None
        try:
            return date.fromisoformat(value).isoformat()
        except ValueError:
            raise ValueError("invalid date, expected YYYY-MM-DD") from None


def _serialize_txn(transaction: dict) -> dict:
    return {
        "date": transaction["date"],
        "description": transaction["description"],
        "amount": str(transaction["amount"]),
        "type": transaction["type"],
        "category": transaction["category"],
    }


def _serialize_created(record: Transaction) -> dict:
    return {
        "id": record.id,
        "ledger_id": record.ledger_id,
        "type": record.type,
        "category": record.category,
        "amount": str(record.amount),
        "currency": record.currency,
        "note": record.note,
        "receipt_path": record.receipt_path,
        "occurred_at": record.occurred_at.isoformat() if record.occurred_at else None,
    }


async def _create_records(
    db: AsyncSession, user_id: int, transactions: list[ImportTransaction]
) -> int:
    if not transactions:
        raise HTTPException(status_code=400, detail="没有可导入的交易")
    ledger = await get_or_create_default_ledger(db, user_id)
    records = [
        Transaction(
            user_id=user_id,
            ledger_id=ledger.id,
            type=item.type,
            category=item.category,
            amount=item.amount,
            currency="CNY",
            note=item.description or None,
            occurred_at=datetime.combine(date.fromisoformat(item.date), time.min),
        )
        for item in transactions
    ]
    db.add_all(records)
    await db.commit()
    return len(records)


def _is_safe_path(path: str) -> bool:
    if not path:
        return False
    if path.startswith("/") or path.startswith("\\"):
        return False
    if ".." in path or ":" in path:
        return False
    return True


def _save_receipt(
    upload_dir: str, user_id: int, filename: str | None, data: bytes
) -> str:
    suffix = Path(filename or "").suffix.lower()
    if suffix not in _ALLOWED_IMAGE_EXT:
        suffix = ".jpg"
    directory = Path(upload_dir)
    directory.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha1(data).hexdigest()[:12]
    name = (
        f"receipt_{user_id}_{datetime.now().strftime('%Y%m%d%H%M%S')}_{digest}{suffix}"
    )
    target = directory / name
    target.write_bytes(data)
    return target.as_posix()


@router.post("/bank-statement/preview")
async def preview_bank_statement(
    file: UploadFile = File(...),
    bank_name: str = Form(...),
    user_id: int = Depends(get_current_user),
) -> dict:
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="PDF 文件为空")
    try:
        text = extract_pdf_text(data)
        transactions = parse_bank_statement(text, bank_name)
    except BankStatementError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "success": True,
        "data": {
            "bank_name": bank_name,
            "count": len(transactions),
            "transactions": [_serialize_txn(t) for t in transactions],
        },
    }


@router.post("/bank-statement/confirm")
async def confirm_bank_statement(
    payload: ImportConfirmPayload,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    created = await _create_records(db, user_id, payload.transactions)
    return {"success": True, "data": {"created": created}}


@router.post("/csv-bill/preview")
async def preview_csv_bill(
    file: UploadFile = File(...),
    platform: str = Form(...),
    user_id: int = Depends(get_current_user),
) -> dict:
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="CSV 文件为空")
    try:
        text = decode_bytes(data)
        transactions = parse_csv_bill(text, platform)
    except CsvBillError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "success": True,
        "data": {
            "platform": platform,
            "count": len(transactions),
            "transactions": [_serialize_txn(t) for t in transactions],
        },
    }


@router.post("/csv-bill/confirm")
async def confirm_csv_bill(
    payload: ImportConfirmPayload,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    created = await _create_records(db, user_id, payload.transactions)
    return {"success": True, "data": {"created": created}}


@router.post("/receipt")
async def preview_receipt(
    image: UploadFile = File(...),
    user_id: int = Depends(get_current_user),
    engine: OcrEngine = Depends(get_ocr_engine),
    settings: Settings = Depends(get_settings),
) -> dict:
    data = await image.read()
    if not data:
        raise HTTPException(status_code=400, detail="请上传发票或收据图片")
    try:
        text = engine.recognize(data)
    except OcrUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    fields = extract_receipt_fields(text or "")
    receipt_path = _save_receipt(settings.upload_dir, user_id, image.filename, data)
    return {"success": True, "data": {"text": text, **fields, "receipt_path": receipt_path}}


@router.post("/receipt/confirm")
async def confirm_receipt(
    payload: ReceiptConfirmPayload,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    receipt_path = payload.receipt_path
    if receipt_path is not None and not _is_safe_path(receipt_path):
        raise HTTPException(status_code=400, detail="凭证路径不合法")
    ledger = await get_or_create_default_ledger(db, user_id)
    occurred_at = (
        datetime.combine(date.fromisoformat(payload.date), time.min)
        if payload.date
        else datetime.now()
    )
    record = Transaction(
        user_id=user_id,
        ledger_id=ledger.id,
        type=payload.type,
        category=payload.category,
        amount=payload.amount,
        currency="CNY",
        note=payload.note,
        receipt_path=receipt_path,
        occurred_at=occurred_at,
    )
    db.add(record)
    await db.commit()
    await db.refresh(record)
    return {"success": True, "data": _serialize_created(record)}
