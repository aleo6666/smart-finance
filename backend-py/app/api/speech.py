"""语音转写 API（讯飞 IAT）。

只返回转写文本，不直接写库——前端按用户选择调记账或知识库
（``POST /api/knowledge/ingest-text``）入库。
"""

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile

from app.api.deps import get_current_user
from app.core.config import Settings, get_settings
from app.services.speech import SpeechError, transcribe_upload

router = APIRouter(prefix="/api/speech", tags=["speech"])


@router.post("/transcribe")
async def transcribe_audio(
    audio: UploadFile = File(...),
    user_id: int = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> dict:
    data = await audio.read()
    if not data:
        raise HTTPException(status_code=400, detail="音频文件为空")
    try:
        text = await transcribe_upload(
            data, audio.content_type or "", audio.filename or "", settings
        )
    except SpeechError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.message) from exc
    return {"success": True, "data": {"text": text}}
