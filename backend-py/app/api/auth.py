"""Email password authentication (register-simple / login / me).

Response envelope matches the legacy Node backend so the Vue client can switch
base URL without changes: ``{success: true, data: {...}}`` on success and
``{success: false, error: "..."}`` on failure.
"""

import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import (
    create_access_token,
    get_current_user,
    get_or_create_default_ledger,
    get_password_hash,
    verify_password,
)
from app.core.database import get_db
from app.models import Ledger, User

router = APIRouter(prefix="/api/auth", tags=["auth"])

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _validate_email(email: str) -> str:
    normalized = (email or "").strip().lower()
    if not _EMAIL_RE.match(normalized):
        raise HTTPException(status_code=400, detail="邮箱格式不正确")
    return normalized


def _validate_password(password: str | None, *, register: bool) -> None:
    if not isinstance(password, str) or not password:
        raise HTTPException(status_code=400, detail="请输入密码")
    if register and len(password) < 6:
        raise HTTPException(status_code=400, detail="密码至少6位")


def _serialize_user(user: User) -> dict:
    return {
        "id": user.id,
        "email": user.email,
        "nickname": user.nickname,
        "username": user.nickname or user.email,
    }


def _serialize_ledger(ledger: Ledger) -> dict:
    return {
        "id": ledger.id,
        "user_id": ledger.user_id,
        "name": ledger.name,
        "icon": ledger.icon,
        "color": ledger.color,
        "base_currency": ledger.base_currency,
        "created_at": ledger.created_at.isoformat() if ledger.created_at else None,
    }


class EmailPasswordRequest(BaseModel):
    email: str
    password: str = Field(min_length=1)


@router.post("/email/register-simple")
async def register_simple(
    payload: EmailPasswordRequest,
    db: AsyncSession = Depends(get_db),
) -> dict:
    email = _validate_email(payload.email)
    _validate_password(payload.password, register=True)

    existing = await db.scalar(select(User).where(User.email == email))
    if existing is not None:
        raise HTTPException(status_code=409, detail="该邮箱已注册，请直接登录")

    nickname = email.split("@", 1)[0]
    user = User(
        email=email,
        password_hash=get_password_hash(payload.password),
        nickname=nickname,
    )
    db.add(user)
    await db.flush()
    await get_or_create_default_ledger(db, user.id)
    await db.commit()

    token = create_access_token(user.id)
    return {"success": True, "data": {"token": token, "userId": user.id}}


@router.post("/email/login")
async def email_login(
    payload: EmailPasswordRequest,
    db: AsyncSession = Depends(get_db),
) -> dict:
    email = _validate_email(payload.email)
    _validate_password(payload.password, register=False)

    user = await db.scalar(select(User).where(User.email == email))
    if user is None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="邮箱或密码错误")

    token = create_access_token(user.id)
    return {"success": True, "data": {"token": token, "userId": user.id}}


@router.get("/me")
async def me(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="登录已过期")

    ledgers = list(
        (
            await db.scalars(
                select(Ledger)
                .where(Ledger.user_id == user_id)
                .order_by(Ledger.created_at.asc(), Ledger.id.asc())
            )
        ).all()
    )
    return {
        "success": True,
        "data": {
            "user": _serialize_user(user),
            "ledgers": [_serialize_ledger(ledger) for ledger in ledgers],
        },
    }
