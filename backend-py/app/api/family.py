"""Family sharing (``/api/family``).

Teams group users; members can share ledgers with the team. Shared ledgers
stay owned by their creator and are readable by any team member through
``/api/family/ledgers/{ledger_id}/records`` (existing /api/records queries
are untouched, keeping the change surgical).
"""

import secrets
import string
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models import Ledger, LedgerMember, Team, Transaction, User

router = APIRouter(prefix="/api/family", tags=["family"])

_ALPHABET = string.ascii_uppercase + string.digits


def _make_invite_code() -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(8))


def _serialize_team(team: Team, role: str, member_count: int) -> dict:
    return {
        "id": team.id,
        "name": team.name,
        "owner_id": team.owner_id,
        "invite_code": team.invite_code,
        "role": role,
        "member_count": member_count,
        "created_at": team.created_at.isoformat() if team.created_at else None,
    }


def _serialize_member(row: LedgerMember, user: User) -> dict:
    return {
        "id": row.id,
        "user_id": user.id,
        "email": user.email,
        "nickname": user.nickname,
        "role": row.role,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


async def _team_role(db: AsyncSession, user_id: int, team_id: int) -> str | None:
    """Return 'owner' / 'member' if the user belongs to the team, else None."""
    team = await db.get(Team, team_id)
    if team is None:
        return None
    if team.owner_id == user_id:
        return "owner"
    row = await db.scalar(
        select(LedgerMember).where(
            LedgerMember.team_id == team_id,
            LedgerMember.user_id == user_id,
            LedgerMember.ledger_id.is_(None),
        )
    )
    return "member" if row is not None else None


async def _team_member_ids(db: AsyncSession, team_id: int) -> list[int]:
    rows = await db.scalars(
        select(LedgerMember.user_id).where(
            LedgerMember.team_id == team_id,
            LedgerMember.ledger_id.is_(None),
        )
    )
    ids = set(rows.all())
    team = await db.get(Team, team_id)
    if team is not None:
        ids.add(team.owner_id)
    return sorted(ids)


class TeamCreate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str


class MemberAdd(BaseModel):
    model_config = ConfigDict(extra="ignore")

    email: str


class JoinRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    invite_code: str


class LedgerShare(BaseModel):
    model_config = ConfigDict(extra="ignore")

    team_id: int
    ledger_id: int


@router.post("/teams")
async def create_team(
    payload: TeamCreate,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if not payload.name:
        raise HTTPException(status_code=400, detail="缺少家庭名称")
    team = Team(name=payload.name, owner_id=user_id, invite_code=_make_invite_code())
    db.add(team)
    await db.flush()
    db.add(
        LedgerMember(team_id=team.id, ledger_id=None, user_id=user_id, role="owner")
    )
    await db.commit()
    await db.refresh(team)
    return {"success": True, "data": _serialize_team(team, "owner", 1)}


@router.get("/teams")
async def list_teams(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    owned = list(
        (await db.scalars(select(Team).where(Team.owner_id == user_id))).all()
    )
    member_rows = list(
        (
            await db.scalars(
                select(LedgerMember).where(
                    LedgerMember.user_id == user_id,
                    LedgerMember.ledger_id.is_(None),
                    LedgerMember.role == "member",
                )
            )
        ).all()
    )
    joined = []
    for row in member_rows:
        team = await db.get(Team, row.team_id)
        if team is not None and team.owner_id != user_id:
            joined.append(team)

    result = []
    for team in owned:
        members = await _team_member_ids(db, team.id)
        result.append(_serialize_team(team, "owner", len(members)))
    for team in joined:
        members = await _team_member_ids(db, team.id)
        result.append(_serialize_team(team, "member", len(members)))
    return {"success": True, "data": result}


@router.post("/teams/join")
async def join_team(
    payload: JoinRequest,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    code = (payload.invite_code or "").strip().upper()
    team = await db.scalar(select(Team).where(Team.invite_code == code))
    if team is None:
        raise HTTPException(status_code=404, detail="邀请码无效")
    if team.owner_id == user_id:
        raise HTTPException(status_code=400, detail="您是该家庭的创建者")
    existing = await db.scalar(
        select(LedgerMember).where(
            LedgerMember.team_id == team.id,
            LedgerMember.user_id == user_id,
            LedgerMember.ledger_id.is_(None),
        )
    )
    if existing is None:
        db.add(
            LedgerMember(
                team_id=team.id, ledger_id=None, user_id=user_id, role="member"
            )
        )
        await db.commit()
    return {"success": True, "data": _serialize_team(team, "member", len(await _team_member_ids(db, team.id)))}


@router.get("/teams/{team_id}")
async def team_detail(
    team_id: int,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    role = await _team_role(db, user_id, team_id)
    if role is None:
        raise HTTPException(status_code=403, detail="您不属于该家庭")
    team = await db.get(Team, team_id)
    assert team is not None

    # owner 通过 team.owner_id 唯一识别，其余成员来自 ledger_members
    rows = list(
        (
            await db.scalars(
                select(LedgerMember).where(
                    LedgerMember.team_id == team_id,
                    LedgerMember.ledger_id.is_(None),
                    LedgerMember.user_id != team.owner_id,
                )
            )
        ).all()
    )
    member_ids = [r.user_id for r in rows]
    users = {
        u.id: u
        for u in (
            await db.scalars(select(User).where(User.id.in_(member_ids)))
        ).all()
    }
    members = [
        _serialize_member(row, users[row.user_id])
        for row in rows
        if row.user_id in users
    ]
    owner = users.get(team.owner_id) or await db.get(User, team.owner_id)
    if owner is not None:
        members.append(
            {
                "id": -team.owner_id,
                "user_id": owner.id,
                "email": owner.email,
                "nickname": owner.nickname,
                "role": "owner",
                "created_at": team.created_at.isoformat() if team.created_at else None,
            }
        )
    return {
        "success": True,
        "data": {
            "team": _serialize_team(team, role, len(members)),
            "members": members,
        },
    }


@router.post("/teams/{team_id}/members")
async def add_member(
    team_id: int,
    payload: MemberAdd,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    role = await _team_role(db, user_id, team_id)
    if role != "owner":
        raise HTTPException(status_code=403, detail="仅家庭创建者可添加成员")
    email = (payload.email or "").strip().lower()
    user = await db.scalar(select(User).where(User.email == email))
    if user is None:
        raise HTTPException(status_code=404, detail="该邮箱用户不存在")
    existing = await db.scalar(
        select(LedgerMember).where(
            LedgerMember.team_id == team_id,
            LedgerMember.user_id == user.id,
            LedgerMember.ledger_id.is_(None),
        )
    )
    if existing is not None:
        raise HTTPException(status_code=400, detail="该用户已是家庭成员")
    row = LedgerMember(team_id=team_id, ledger_id=None, user_id=user.id, role="member")
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return {"success": True, "data": _serialize_member(row, user)}


@router.delete("/teams/{team_id}/members/{member_id}")
async def remove_member(
    team_id: int,
    member_id: int,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    role = await _team_role(db, user_id, team_id)
    if role != "owner":
        raise HTTPException(status_code=403, detail="仅家庭创建者可移除成员")
    row = await db.scalar(
        select(LedgerMember).where(
            LedgerMember.id == member_id,
            LedgerMember.team_id == team_id,
            LedgerMember.ledger_id.is_(None),
        )
    )
    if row is None:
        raise HTTPException(status_code=404, detail="成员不存在")
    if row.role == "owner":
        raise HTTPException(status_code=400, detail="不能移除家庭创建者")
    await db.delete(row)
    await db.commit()
    return {"success": True, "message": "已移除成员"}


@router.delete("/teams/{team_id}")
async def disband_team(
    team_id: int,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    role = await _team_role(db, user_id, team_id)
    if role != "owner":
        raise HTTPException(status_code=403, detail="仅家庭创建者可解散家庭")
    await db.execute(
        delete(LedgerMember).where(LedgerMember.team_id == team_id)
    )
    team = await db.get(Team, team_id)
    if team is not None:
        await db.delete(team)
    await db.commit()
    return {"success": True, "message": "家庭已解散"}


@router.get("/ledgers")
async def list_shared_ledgers(
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Ledgers shared into any team the user belongs to."""
    teams = []
    owned_ids = (await db.scalars(select(Team.id).where(Team.owner_id == user_id))).all()
    teams.extend(owned_ids)
    member_rows = (
        await db.scalars(
            select(LedgerMember.team_id).where(
                LedgerMember.user_id == user_id,
                LedgerMember.ledger_id.is_(None),
            )
        )
    ).all()
    teams.extend(member_rows)
    teams = sorted(set(teams))
    if not teams:
        return {"success": True, "data": []}

    shares = list(
        (
            await db.scalars(
                select(LedgerMember).where(
                    LedgerMember.team_id.in_(teams),
                    LedgerMember.ledger_id.is_not(None),
                )
            )
        ).all()
    )
    ledger_ids = [s.ledger_id for s in shares if s.ledger_id is not None]
    ledgers = {
        lg.id: lg
        for lg in (
            await db.scalars(select(Ledger).where(Ledger.id.in_(ledger_ids)))
        ).all()
    }
    result = []
    for share in shares:
        ledger = ledgers.get(share.ledger_id) if share.ledger_id else None
        if ledger is None:
            continue
        team = await db.get(Team, share.team_id)
        result.append(
            {
                "member_id": share.id,
                "team_id": share.team_id,
                "team_name": team.name if team else "",
                "ledger_id": ledger.id,
                "ledger_name": ledger.name,
                "shared_by": share.user_id,
            }
        )
    return {"success": True, "data": result}


@router.post("/ledgers")
async def share_ledger(
    payload: LedgerShare,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    role = await _team_role(db, user_id, payload.team_id)
    if role is None:
        raise HTTPException(status_code=403, detail="您不属于该家庭")
    ledger = await db.scalar(
        select(Ledger).where(Ledger.id == payload.ledger_id, Ledger.user_id == user_id)
    )
    if ledger is None:
        raise HTTPException(status_code=404, detail="账本不存在或无权共享")
    existing = await db.scalar(
        select(LedgerMember).where(
            LedgerMember.team_id == payload.team_id,
            LedgerMember.ledger_id == payload.ledger_id,
        )
    )
    if existing is not None:
        raise HTTPException(status_code=400, detail="该账本已共享")
    row = LedgerMember(
        team_id=payload.team_id,
        ledger_id=payload.ledger_id,
        user_id=user_id,
        role="owner",
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return {"success": True, "data": {"id": row.id, "team_id": row.team_id, "ledger_id": row.ledger_id}}


@router.delete("/ledgers/{member_id}")
async def unshare_ledger(
    member_id: int,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    row = await db.scalar(
        select(LedgerMember).where(
            LedgerMember.id == member_id,
            LedgerMember.ledger_id.is_not(None),
        )
    )
    if row is None:
        raise HTTPException(status_code=404, detail="共享记录不存在")
    role = await _team_role(db, user_id, row.team_id)
    if role is None or (row.user_id != user_id and role != "owner"):
        raise HTTPException(status_code=403, detail="无权取消该共享")
    await db.delete(row)
    await db.commit()
    return {"success": True, "message": "已取消共享"}


@router.get("/ledgers/{ledger_id}/records")
async def shared_ledger_records(
    ledger_id: int,
    user_id: int = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    limit: int = 100,
) -> dict:
    """Read transactions of a ledger shared into a team the user belongs to."""
    share = await db.scalar(
        select(LedgerMember).where(LedgerMember.ledger_id == ledger_id)
    )
    if share is None:
        raise HTTPException(status_code=404, detail="账本未共享")
    role = await _team_role(db, user_id, share.team_id)
    if role is None:
        raise HTTPException(status_code=403, detail="您不属于该家庭")

    transactions = list(
        (
            await db.scalars(
                select(Transaction)
                .where(Transaction.ledger_id == ledger_id)
                .order_by(Transaction.occurred_at.desc(), Transaction.id.desc())
                .limit(limit)
            )
        ).all()
    )
    return {
        "success": True,
        "data": [
            {
                "id": t.id,
                "type": t.type,
                "category": t.category,
                "amount": str(t.amount),
                "note": t.note,
                "occurred_at": t.occurred_at.isoformat() if t.occurred_at else None,
            }
            for t in transactions
        ],
    }
