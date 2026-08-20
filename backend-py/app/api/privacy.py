"""Privacy center (``/api/privacy``).

Consent records for privacy policy / data analysis, plus a data-export
summary endpoint for transparency (GDPR-style "download my data").
Account deletion lives at ``DELETE /api/auth/account``.
"""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import (
    PrivacyConsent,
    Transaction,
    User,
)

router = APIRouter(prefix="/api/privacy", tags=["privacy"])

CONSENT_TYPES = {"privacy_policy", "data_analysis"}


def _serialize(item: PrivacyConsent) -> dict:
    return {
        "id": item.id,
        "consent_type": item.consent_type,
        "version": item.version,
        "granted": bool(item.granted),
        "granted_at": item.granted_at.isoformat() if item.granted_at else None,
        "revoked_at": item.revoked_at.isoformat() if item.revoked_at else None,
    }


class ConsentRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    consent_type: str
    version: str = "v1"
    granted: bool = True


@router.get("/consents")
async def get_consents(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    items = list(
        (
            await db.scalars(
                select(PrivacyConsent)
                .where(PrivacyConsent.user_id == user_id)
                .order_by(PrivacyConsent.granted_at.desc())
            )
        ).all()
    )
    return {"success": True, "data": [_serialize(item) for item in items]}


@router.post("/consents")
async def upsert_consent(
    payload: ConsentRequest,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if payload.consent_type not in CONSENT_TYPES:
        raise HTTPException(status_code=400, detail="不支持的同意类型")
    existing = await db.scalar(
        select(PrivacyConsent).where(
            PrivacyConsent.user_id == user_id,
            PrivacyConsent.consent_type == payload.consent_type,
        )
    )
    if existing is not None:
        existing.version = payload.version
        existing.granted = payload.granted
        existing.granted_at = func.now()
        existing.revoked_at = None if payload.granted else datetime.utcnow()
    else:
        existing = PrivacyConsent(
            user_id=user_id,
            consent_type=payload.consent_type,
            version=payload.version,
            granted=payload.granted,
            revoked_at=None if payload.granted else datetime.utcnow(),
        )
        db.add(existing)
    await db.commit()
    await db.refresh(existing)
    return {"success": True, "data": _serialize(existing)}


@router.get("/data")
async def export_data(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Summary of the user's stored data (privacy transparency)."""
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="登录已过期")
    transaction_count = await db.scalar(
        select(func.count(Transaction.id)).where(Transaction.user_id == user_id)
    )
    consents = list(
        (
            await db.scalars(
                select(PrivacyConsent).where(PrivacyConsent.user_id == user_id)
            )
        ).all()
    )
    return {
        "success": True,
        "data": {
            "user": {
                "email": user.email,
                "nickname": user.nickname,
                "created_at": user.created_at.isoformat() if user.created_at else None,
            },
            "statistics": {
                "transaction_count": transaction_count or 0,
                "consent_count": len(consents),
            },
            "consents": [_serialize(item) for item in consents],
            "note": "完整明细可通过各功能页面导出；如需彻底删除请使用「注销账号」。",
        },
    }
