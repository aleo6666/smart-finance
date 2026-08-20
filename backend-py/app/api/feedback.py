"""用户反馈 API：提交（含截图）/ 查询 / 状态 / 满意度调研 / 管理端。

对齐旧 Node 后端 server/src/routes/feedback.js：
- 截图 ≤5MB，仅 jpg/png/gif/webp，sha1 命名保存到 uploads/
- 内容自动分级：bug→P0、建议/UX→P1、其余 P2
- 旧后端按 deviceId 隔离，Python 侧统一按 user_id 归属
- /admin/* 与 Node 一致仅要求登录（无独立角色体系）
"""

from __future__ import annotations

import hashlib
from datetime import datetime
from pathlib import Path
import re

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, ConfigDict, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.config import Settings, get_settings
from app.core.database import get_db
from app.models.support import Feedback

router = APIRouter(prefix="/api/feedback", tags=["feedback"])

MAX_IMAGE_BYTES = 5 * 1024 * 1024
_ALLOWED_IMAGE_EXT = {".jpg", ".jpeg", ".png", ".gif", ".webp"}
_ALLOWED_MIME = {"image/jpeg", "image/png", "image/gif", "image/webp"}

_BUG_RE = re.compile(r"bug|错误|报错|崩溃|失败|异常")
_SUGGESTION_RE = re.compile(r"建议|希望|增加|添加")
_UX_RE = re.compile(r"难用|不方便|卡|慢|体验|界面")


def classify_feedback(type_: str, content: str) -> tuple[str, str]:
    text = str(content or "").lower()
    if _BUG_RE.search(text):
        return "bug", "P0"
    if _SUGGESTION_RE.search(text):
        return "suggestion", "P1"
    if _UX_RE.search(text):
        return "ux", "P1"
    return (type_ or "suggestion") or "suggestion", "P2"


def _serialize(feedback: Feedback) -> dict:
    return {
        "id": feedback.id,
        "user_id": feedback.user_id,
        "type": feedback.type,
        "content": feedback.content,
        "image_path": feedback.image_path,
        "priority": feedback.priority,
        "status": feedback.status,
        "admin_reply": feedback.admin_reply,
        "created_at": feedback.created_at.isoformat() if feedback.created_at else None,
        "updated_at": feedback.updated_at.isoformat() if feedback.updated_at else None,
    }


def _save_screenshot(upload_dir: str, user_id: int, filename: str | None, data: bytes) -> str:
    suffix = Path(filename or "").suffix.lower()
    if suffix not in _ALLOWED_IMAGE_EXT:
        suffix = ".png"
    directory = Path(upload_dir)
    directory.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha1(data).hexdigest()[:12]
    name = f"feedback_{user_id}_{datetime.now().strftime('%Y%m%d%H%M%S')}_{digest}{suffix}"
    target = directory / name
    target.write_bytes(data)
    return target.as_posix()


class SurveyPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")

    rating: int
    comment: str | None = None

    @field_validator("rating")
    @classmethod
    def _validate_rating(cls, value: int) -> int:
        if value < 1 or value > 5:
            raise ValueError("rating must be 1..5")
        return value


class FeedbackUpdatePayload(BaseModel):
    model_config = ConfigDict(extra="ignore")

    status: str | None = None
    admin_reply: str | None = None
    priority: str | None = None

    @field_validator("priority")
    @classmethod
    def _validate_priority(cls, value: str | None) -> str | None:
        if value is not None and value not in {"P0", "P1", "P2"}:
            raise ValueError("priority must be P0/P1/P2")
        return value


@router.post("")
async def submit_feedback(
    content: str = Form(...),
    type: str = Form("suggestion"),
    screenshot: UploadFile | None = File(None),
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> dict:
    if not content.strip():
        raise HTTPException(status_code=400, detail="反馈内容不能为空")

    fb_type, priority = classify_feedback(type, content)
    image_path = None
    if screenshot is not None and screenshot.filename:
        data = await screenshot.read()
        if len(data) > MAX_IMAGE_BYTES:
            raise HTTPException(status_code=400, detail="截图不能超过 5MB")
        if screenshot.content_type not in _ALLOWED_MIME:
            raise HTTPException(status_code=400, detail="仅支持 jpg/png/gif/webp 图片")
        image_path = _save_screenshot(settings.upload_dir, user_id, screenshot.filename, data)

    feedback = Feedback(
        user_id=user_id,
        type=fb_type,
        content=content.strip(),
        image_path=image_path,
        priority=priority,
    )
    db.add(feedback)
    await db.commit()
    await db.refresh(feedback)
    return {
        "success": True,
        "data": _serialize(feedback),
        "message": f"感谢你的反馈！反馈编号: #{feedback.id}",
    }


@router.get("")
async def list_feedback(
    status: str | None = None,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    query = (
        select(Feedback)
        .where(Feedback.user_id == user_id)
        .order_by(Feedback.created_at.desc(), Feedback.id.desc())
        .limit(50)
    )
    if status:
        query = query.where(Feedback.status == status)
    rows = (await db.scalars(query)).all()
    return {"success": True, "data": [_serialize(f) for f in rows]}


@router.get("/status/{feedback_id}")
async def feedback_status(
    feedback_id: int,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    feedback = await db.scalar(
        select(Feedback).where(
            Feedback.id == feedback_id, Feedback.user_id == user_id
        )
    )
    if feedback is None:
        raise HTTPException(status_code=404, detail="反馈不存在")
    return {"success": True, "data": _serialize(feedback)}


@router.get("/survey")
async def check_survey() -> dict:
    return {"success": True, "data": {"showSurvey": False}}


@router.post("/survey")
async def submit_survey(
    payload: SurveyPayload,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    feedback = Feedback(
        user_id=user_id,
        type="survey",
        content=f"评分: {payload.rating}/5 | {payload.comment or '无附加意见'}",
        priority="P1",
    )
    db.add(feedback)
    await db.commit()
    return {"success": True, "message": "感谢你的评价！"}


@router.get("/admin/all")
async def admin_all(
    priority: str | None = None,
    type: str | None = None,
    status: str | None = None,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    query = select(Feedback)
    if priority:
        query = query.where(Feedback.priority == priority)
    if type:
        query = query.where(Feedback.type == type)
    if status:
        query = query.where(Feedback.status == status)
    rows = (
        await db.scalars(
            query.order_by(
                # P0 优先
                Feedback.priority.asc(),  # P0 < P1 < P2 字典序恰好一致
                Feedback.created_at.desc(),
                Feedback.id.desc(),
            ).limit(100)
        )
    ).all()
    return {"success": True, "data": [_serialize(f) for f in rows]}


@router.put("/admin/{feedback_id}")
async def admin_update(
    feedback_id: int,
    payload: FeedbackUpdatePayload,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    feedback = await db.get(Feedback, feedback_id)
    if feedback is None:
        raise HTTPException(status_code=404, detail="反馈不存在")
    updates = payload.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status_code=400, detail="无更新字段")
    for key, value in updates.items():
        setattr(feedback, key, value)
    await db.commit()
    await db.refresh(feedback)
    return {"success": True, "data": _serialize(feedback)}
