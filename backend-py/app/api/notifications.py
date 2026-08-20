"""Notification center (``/api/notifications``) over the reminders table.

Also exposes the legacy ``/api/reminders`` aliases the Vue topbar calls
(``/count``, ``/highlights``, ``/read-all``), which previously 404'd
against the Python backend.
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import Reminder

router = APIRouter(prefix="/api/notifications", tags=["notifications"])
legacy_router = APIRouter(prefix="/api/reminders", tags=["reminders"])


def _serialize(item: Reminder) -> dict:
    return {
        "id": item.id,
        "type": item.type,
        "title": item.title,
        "message": item.message,
        "status": item.status,
        "read": 1 if item.read_at is not None else 0,
        "created_at": item.created_at.isoformat() if item.created_at else None,
    }


async def _list_reminders(
    db: AsyncSession, user_id: int, *, limit: int | None = None, unread_only: bool = False
) -> list[Reminder]:
    statement = select(Reminder).where(Reminder.user_id == user_id)
    if unread_only:
        statement = statement.where(Reminder.read_at.is_(None))
    statement = statement.order_by(Reminder.created_at.desc(), Reminder.id.desc())
    if limit is not None:
        statement = statement.limit(limit)
    return list((await db.scalars(statement)).all())


@router.get("")
async def list_notifications(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    limit: int = Query(default=50, ge=1, le=200),
) -> dict:
    items = await _list_reminders(db, user_id, limit=limit)
    return {"success": True, "data": [_serialize(item) for item in items]}


@router.get("/count")
async def unread_count(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    unread = await _list_reminders(db, user_id, unread_only=True)
    return {"success": True, "data": {"count": len(unread)}}


@router.get("/highlights")
async def highlights(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    limit: int = Query(default=5, ge=1, le=20),
) -> dict:
    items = await _list_reminders(db, user_id, limit=limit)
    return {"success": True, "data": [_serialize(item) for item in items]}


@router.put("/{notification_id}/read")
async def mark_read(
    notification_id: int,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    result = await db.execute(
        update(Reminder)
        .where(
            Reminder.id == notification_id,
            Reminder.user_id == user_id,
            Reminder.read_at.is_(None),
        )
        .values(read_at=func.now())
    )
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="通知不存在或已读")
    await db.commit()
    return {"success": True, "message": "已标记为已读"}


@router.put("/read-all")
async def mark_all_read(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    await db.execute(
        update(Reminder)
        .where(Reminder.user_id == user_id, Reminder.read_at.is_(None))
        .values(read_at=func.now())
    )
    await db.commit()
    return {"success": True, "message": "全部已读"}


@router.delete("/{notification_id}")
async def delete_notification(
    notification_id: int,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    item = await db.scalar(
        select(Reminder).where(
            Reminder.id == notification_id, Reminder.user_id == user_id
        )
    )
    if item is None:
        raise HTTPException(status_code=404, detail="通知不存在")
    await db.delete(item)
    await db.commit()
    return {"success": True, "message": "已删除"}


# ---- 兼容旧前端 /api/reminders 路径 ----

@legacy_router.get("")
async def legacy_list(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    items = await _list_reminders(db, user_id, limit=50)
    return {"success": True, "data": [_serialize(item) for item in items]}


@legacy_router.get("/count")
async def legacy_count(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    unread = await _list_reminders(db, user_id, unread_only=True)
    return {"success": True, "data": {"count": len(unread)}}


@legacy_router.get("/highlights")
async def legacy_highlights(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    limit: int = Query(default=5, ge=1, le=20),
) -> dict:
    items = await _list_reminders(db, user_id, limit=limit)
    return {"success": True, "data": [_serialize(item) for item in items]}


@legacy_router.put("/{notification_id}/read")
async def legacy_mark_read(
    notification_id: int,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    return await mark_read(notification_id, user_id, db)


@legacy_router.put("/read-all")
async def legacy_mark_all_read(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    return await mark_all_read(user_id, db)
