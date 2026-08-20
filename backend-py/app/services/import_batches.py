"""账单导入批次服务：创建批次（解析预览+重复检测）/ 确认入库 / 回滚撤销 / 历史查询。

对齐旧 Node 后端 server/src/services/import/importService.js：
- 重复检测：对用户近 90 天交易做相似度比对，≥0.85 标记重复（默认不选中）
- 确认：仅导入 selected=1（或显式 selectedIds）的 pending 明细，写入 transactions
- 回滚：仅 imported 状态且 24 小时内可回滚，删除对应交易
- 序列化统一 camelCase，匹配前端 ImportPage 契约
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from decimal import Decimal
import json
import logging

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_or_create_default_ledger
from app.models import Transaction
from app.models.support import ImportBatch, ImportRecord
from app.services.importers.bill_batch import calculate_similarity

logger = logging.getLogger(__name__)

DUPLICATE_THRESHOLD = 0.85
ROLLBACK_WINDOW_HOURS = 24


# ========= 序列化（前端 camelCase 契约） =========


def _serialize_batch(batch: ImportBatch) -> dict:
    return {
        "id": batch.id,
        "sourceType": batch.source_type,
        "fileName": batch.file_name,
        "status": batch.status,
        "totalCount": batch.total_count,
        "validCount": batch.valid_count,
        "duplicateCount": batch.duplicate_count,
        "errorCount": batch.error_count,
        "importedCount": batch.imported_count,
        "createdAt": batch.created_at.isoformat() if batch.created_at else None,
        "importedAt": batch.imported_at.isoformat() if batch.imported_at else None,
    }


def _serialize_record(record: ImportRecord) -> dict:
    return {
        "id": record.id,
        "type": record.mapped_type,
        "amount": float(record.mapped_amount),
        "category": record.mapped_category,
        "date": record.mapped_date,
        "description": record.mapped_description,
        "merchant": record.mapped_merchant,
        "status": record.status,
        "isDuplicate": bool(record.is_duplicate),
        "similarity": float(record.duplicate_similarity),
        "selected": bool(record.selected),
        "recordId": record.record_id,
    }


# ========= 重复检测 =========


async def _existing_records_for_comparison(
    db: AsyncSession, user_id: int
) -> list[dict]:
    cutoff = datetime.now() - timedelta(days=90)
    rows = (
        await db.scalars(
            select(Transaction)
            .where(Transaction.user_id == user_id, Transaction.occurred_at >= cutoff)
            .order_by(Transaction.occurred_at.desc())
        )
    ).all()
    return [
        {
            "id": row.id,
            "type": row.type,
            "amount": str(row.amount),
            "category": row.category,
            "date": row.occurred_at.date().isoformat(),
            "description": row.note or "",
            "merchant": "",
        }
        for row in rows
    ]


def _detect_duplicates(
    new_records: list[dict], existing_records: list[dict]
) -> tuple[list[dict], int]:
    duplicate_count = 0
    enriched: list[dict] = []
    for record in new_records:
        max_sim = 0.0
        duplicate_of = None
        for existing in existing_records:
            if existing["type"] != record["type"]:
                continue
            similarity = calculate_similarity(
                {
                    "amount": existing["amount"],
                    "category": existing["category"],
                    "date": existing["date"],
                    "merchant": existing["merchant"],
                    "description": existing["description"],
                },
                {
                    "amount": str(record["amount"]),
                    "category": record["category"],
                    "date": record["date"],
                    "merchant": record.get("merchant") or "",
                    "description": record.get("description") or "",
                },
            )
            if similarity > max_sim:
                max_sim = similarity
                duplicate_of = existing["id"]
        is_duplicate = max_sim >= DUPLICATE_THRESHOLD
        if is_duplicate:
            duplicate_count += 1
        enriched.append(
            {
                **record,
                "is_duplicate": is_duplicate,
                "similarity": max_sim,
                "duplicate_of": duplicate_of,
            }
        )
    return enriched, duplicate_count


# ========= 创建批次 =========


async def create_batch(
    db: AsyncSession,
    user_id: int,
    ledger_id: int | None,
    source_type: str,
    file_name: str,
    records: list[dict],
    total_count: int,
) -> dict:
    existing = await _existing_records_for_comparison(db, user_id)
    enriched, duplicate_count = _detect_duplicates(records, existing)
    valid_count = sum(1 for r in enriched if r["amount"] > 0 and r["date"])
    error_count = total_count - valid_count

    batch = ImportBatch(
        user_id=user_id,
        ledger_id=ledger_id,
        source_type=source_type,
        file_name=file_name or "import.csv",
        total_count=total_count,
        valid_count=valid_count,
        duplicate_count=duplicate_count,
        error_count=error_count,
        imported_count=0,
        status="preview",
        preview_data=json.dumps(
            [
                {
                    "type": r["type"],
                    "amount": str(r["amount"]),
                    "date": r["date"],
                    "category": r["category"],
                    "merchant": r.get("merchant") or "",
                    "description": r.get("description") or "",
                    "isDuplicate": r["is_duplicate"],
                    "similarity": r["similarity"],
                }
                for r in enriched[:200]
            ],
            ensure_ascii=False,
        ),
    )
    db.add(batch)
    await db.flush()

    detail_rows = [
        ImportRecord(
            batch_id=batch.id,
            user_id=user_id,
            original_row=json.dumps(r.get("raw") or {}, ensure_ascii=False, default=str),
            mapped_type=r["type"],
            mapped_amount=r["amount"],
            mapped_category=r["category"],
            mapped_date=r["date"],
            mapped_description=r.get("description") or None,
            mapped_merchant=r.get("merchant") or None,
            status="pending",
            is_duplicate=r["is_duplicate"],
            duplicate_similarity=Decimal(str(r["similarity"])),
            duplicate_of_record_id=r["duplicate_of"],
            selected=not r["is_duplicate"],
        )
        for r in enriched
    ]
    db.add_all(detail_rows)
    await db.commit()
    return await get_batch_detail(db, batch.id, user_id)


# ========= 查询 =========


async def get_batch_list(
    db: AsyncSession, user_id: int, page: int = 1, page_size: int = 20
) -> dict:
    offset = (page - 1) * page_size
    total = await db.scalar(
        select(func.count())
        .select_from(ImportBatch)
        .where(ImportBatch.user_id == user_id)
    )
    rows = (
        await db.scalars(
            select(ImportBatch)
            .where(ImportBatch.user_id == user_id)
            .order_by(ImportBatch.created_at.desc(), ImportBatch.id.desc())
            .offset(offset)
            .limit(page_size)
        )
    ).all()
    return {
        "list": [_serialize_batch(batch) for batch in rows],
        "total": total or 0,
        "page": page,
        "pageSize": page_size,
    }


async def get_batch_detail(
    db: AsyncSession, batch_id: int, user_id: int
) -> dict | None:
    batch = await db.scalar(
        select(ImportBatch).where(
            ImportBatch.id == batch_id, ImportBatch.user_id == user_id
        )
    )
    if batch is None:
        return None
    records = (
        await db.scalars(
            select(ImportRecord)
            .where(ImportRecord.batch_id == batch_id)
            .order_by(ImportRecord.id.asc())
        )
    ).all()
    return {
        **_serialize_batch(batch),
        "records": [_serialize_record(record) for record in records],
    }


# ========= 预览编辑 =========

_UPDATE_FIELD_MAP = {
    "category": "mapped_category",
    "amount": "mapped_amount",
    "date": "mapped_date",
    "description": "mapped_description",
    "merchant": "mapped_merchant",
    "type": "mapped_type",
    "selected": "selected",
}


async def update_record(
    db: AsyncSession,
    batch_id: int,
    record_id: int,
    user_id: int,
    updates: dict,
) -> dict:
    batch = await db.scalar(
        select(ImportBatch).where(
            ImportBatch.id == batch_id, ImportBatch.user_id == user_id
        )
    )
    if batch is None:
        raise ValueError("批次不存在")
    if batch.status != "preview":
        raise ValueError("仅预览状态可编辑")

    mapped = {}
    for key, value in updates.items():
        if key in _UPDATE_FIELD_MAP and value is not None:
            mapped[_UPDATE_FIELD_MAP[key]] = value
    if mapped:
        await db.execute(
            ImportRecord.__table__.update()
            .where(
                ImportRecord.id == record_id,
                ImportRecord.batch_id == batch_id,
                ImportRecord.user_id == user_id,
            )
            .values(**mapped)
        )
        await db.commit()
    return await get_batch_detail(db, batch_id, user_id)


async def select_records(
    db: AsyncSession,
    batch_id: int,
    record_ids: list[int],
    selected: bool,
    user_id: int,
) -> dict:
    batch = await db.scalar(
        select(ImportBatch).where(
            ImportBatch.id == batch_id, ImportBatch.user_id == user_id
        )
    )
    if batch is None:
        raise ValueError("批次不存在")
    if batch.status != "preview":
        raise ValueError("仅预览状态可操作")

    await db.execute(
        ImportRecord.__table__.update()
        .where(
            ImportRecord.batch_id == batch_id,
            ImportRecord.user_id == user_id,
            ImportRecord.id.in_(record_ids),
        )
        .values(selected=selected)
    )
    await db.commit()
    return await get_batch_detail(db, batch_id, user_id)


# ========= 确认导入 =========


async def confirm_import(
    db: AsyncSession,
    batch_id: int,
    user_id: int,
    selected_ids: list[int] | None = None,
) -> dict:
    batch = await db.scalar(
        select(ImportBatch).where(
            ImportBatch.id == batch_id, ImportBatch.user_id == user_id
        )
    )
    if batch is None:
        raise ValueError("批次不存在")
    if batch.status == "imported":
        raise ValueError("该批次已导入")
    if batch.status == "rolled_back":
        raise ValueError("该批次已回滚")

    query = (
        select(ImportRecord)
        .where(
            ImportRecord.batch_id == batch_id,
            ImportRecord.user_id == user_id,
            ImportRecord.status == "pending",
        )
        .order_by(ImportRecord.id.asc())
    )
    if selected_ids:
        query = query.where(ImportRecord.id.in_(selected_ids))
    else:
        query = query.where(ImportRecord.selected.is_(True))
    to_import = (await db.scalars(query)).all()
    if not to_import:
        raise ValueError("没有可导入的记录")

    ledger_id = batch.ledger_id
    if ledger_id is None:
        ledger = await get_or_create_default_ledger(db, user_id)
        ledger_id = ledger.id

    now = datetime.now()
    imported_ids: list[int] = []
    for item in to_import:
        record = Transaction(
            user_id=user_id,
            ledger_id=ledger_id,
            type=item.mapped_type,
            category=item.mapped_category,
            amount=item.mapped_amount,
            currency="CNY",
            note=item.mapped_description or item.mapped_category,
            occurred_at=datetime.combine(
                date.fromisoformat(item.mapped_date), time.min
            ),
        )
        db.add(record)
        await db.flush()
        imported_ids.append(record.id)
        item.status = "imported"
        item.record_id = record.id
        item.imported_at = now

    batch.status = "imported"
    batch.imported_count = len(imported_ids)
    batch.imported_at = now
    await db.commit()
    return {
        "success": True,
        "batchId": batch_id,
        "importedCount": len(imported_ids),
        "recordIds": imported_ids,
    }


# ========= 回滚 =========


async def rollback_batch(db: AsyncSession, batch_id: int, user_id: int) -> dict:
    batch = await db.scalar(
        select(ImportBatch).where(
            ImportBatch.id == batch_id, ImportBatch.user_id == user_id
        )
    )
    if batch is None:
        raise ValueError("批次不存在")
    if batch.status != "imported":
        raise ValueError("仅已导入的批次可回滚")
    if batch.imported_at is None:
        raise ValueError("仅已导入的批次可回滚")

    hours_passed = (datetime.now() - batch.imported_at).total_seconds() / 3600
    if hours_passed > ROLLBACK_WINDOW_HOURS:
        raise ValueError("导入超过 24 小时，无法回滚")

    imported_records = (
        await db.scalars(
            select(ImportRecord).where(
                ImportRecord.batch_id == batch_id,
                ImportRecord.status == "imported",
                ImportRecord.record_id.is_not(None),
            )
        )
    ).all()
    record_ids = [r.record_id for r in imported_records if r.record_id]

    if record_ids:
        await db.execute(
            Transaction.__table__.delete().where(
                Transaction.id.in_(record_ids),
                Transaction.user_id == user_id,
            )
        )
    for item in imported_records:
        item.status = "rolled_back"
        item.record_id = None

    batch.status = "rolled_back"
    batch.imported_count = 0
    batch.rolled_back_at = datetime.now()
    await db.commit()
    return {
        "success": True,
        "batchId": batch_id,
        "rolledBackCount": len(record_ids),
    }
