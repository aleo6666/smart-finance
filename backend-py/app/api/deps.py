"""Shared FastAPI dependencies: JWT auth and resource-resolution helpers."""

from datetime import datetime, timedelta

import bcrypt as _bcrypt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models import Ledger

DEFAULT_LEDGER_NAME = "我的账本"
DEFAULT_CURRENCY = "CNY"

_bearer_scheme = HTTPBearer(auto_error=False)


def create_access_token(user_id: int) -> str:
    settings = get_settings()
    expire = datetime.utcnow() + timedelta(minutes=settings.jwt_expire_minutes)
    return jwt.encode(
        {"user_id": user_id, "exp": expire},
        settings.jwt_secret.get_secret_value(),
        algorithm=settings.jwt_algorithm,
    )


def get_password_hash(password: str) -> str:
    """Hash with native bcrypt (compatible 3.x/4.x/5.x), truncating to 72 bytes.

    Note: passlib 1.7.4 is incompatible with bcrypt>=4.1 (missing __about__),
    so we call the native API directly with explicit 72-byte truncation.
    """
    pw = password.encode("utf-8")[:72]
    return _bcrypt.hashpw(pw, _bcrypt.gensalt()).decode("utf-8")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    try:
        return _bcrypt.checkpw(
            plain_password.encode("utf-8")[:72],
            hashed_password.encode("utf-8"),
        )
    except ValueError:
        return False


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer_scheme),
) -> int:
    if credentials is None:
        raise HTTPException(status_code=401, detail="未登录")
    settings = get_settings()
    try:
        payload = jwt.decode(
            credentials.credentials,
            settings.jwt_secret.get_secret_value(),
            algorithms=[settings.jwt_algorithm],
        )
    except JWTError:
        raise HTTPException(status_code=401, detail="登录已过期") from None
    user_id = payload.get("user_id")
    if user_id is None:
        raise HTTPException(status_code=401, detail="登录已过期")
    return int(user_id)


async def get_or_create_default_ledger(
    db: AsyncSession, user_id: int
) -> Ledger:
    """Return the user's first ledger, creating the default one if none exist."""
    ledger = await db.scalar(
        select(Ledger)
        .where(Ledger.user_id == user_id)
        .order_by(Ledger.id.asc())
        .limit(1)
    )
    if ledger is None:
        ledger = Ledger(
            user_id=user_id,
            name=DEFAULT_LEDGER_NAME,
            base_currency=DEFAULT_CURRENCY,
        )
        db.add(ledger)
        await db.flush()
    return ledger


async def get_owned_ledger(
    db: AsyncSession, user_id: int, ledger_id: int
) -> Ledger | None:
    return await db.scalar(
        select(Ledger).where(
            Ledger.id == ledger_id,
            Ledger.user_id == user_id,
        )
    )
