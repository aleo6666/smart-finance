"""OCR 票据识别 API。

只返回识别文本与结构化建议，绝不直接入库——前端确认后再调
``POST /api/records`` 记账。
"""

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from app.api.deps import get_current_user
from app.services.ocr import (
    OcrEngine,
    OcrUnavailable,
    PaddleOcrEngine,
    extract_receipt_fields,
)

router = APIRouter(prefix="/api/ocr", tags=["ocr"])

_engine: OcrEngine | None = None


def get_ocr_engine() -> OcrEngine:
    global _engine
    if _engine is None:
        _engine = PaddleOcrEngine()
    return _engine


@router.post("/receipt")
async def recognize_receipt(
    image: UploadFile = File(...),
    user_id: int = Depends(get_current_user),
    engine: OcrEngine = Depends(get_ocr_engine),
) -> dict:
    data = await image.read()
    if not data:
        raise HTTPException(status_code=400, detail="请上传一张购物小票或收据的截图")
    if len(data) < 200:
        raise HTTPException(
            status_code=400, detail="图片文件过小，请上传清晰完整的截图"
        )
    try:
        text = engine.recognize(data)
    except OcrUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    fields = extract_receipt_fields(text or "")
    return {"success": True, "data": {"text": text, **fields}}
