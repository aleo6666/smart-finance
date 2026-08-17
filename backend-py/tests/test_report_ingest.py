from datetime import datetime
from decimal import Decimal

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import Settings
from app.models import Base, KnowledgeDocument, Ledger, Transaction, User
from app.services.knowledge import chunk_point_id, ingest_knowledge_document
from app.services.report_generator import generate_monthly_report


@pytest_asyncio.fixture
async def report_store():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with sessions() as session:
        session.add(User(id=1, email="ingest@example.com", password_hash="hash"))
        session.add(Ledger(id=1, user_id=1, name="Report ingest"))
        session.add(
            Transaction(
                user_id=1,
                ledger_id=1,
                type="income",
                category="工资",
                amount=Decimal("10000"),
                occurred_at=datetime(2026, 3, 1),
            )
        )
        await session.commit()
    yield sessions
    await engine.dispose()


@pytest.mark.asyncio
async def test_monthly_report_calls_knowledge_ingest_with_text_analysis(
    report_store,
) -> None:
    calls: list[dict[str, object]] = []

    async def ingest_report(db, **kwargs) -> None:
        calls.append(kwargs)

    async with report_store() as session:
        result = await generate_monthly_report(
            session,
            1,
            2026,
            3,
            report_ingester=ingest_report,
        )

    assert result["period"] == "2026-03"
    assert calls[0]["user_id"] == 1
    assert calls[0]["space_id"] == 1
    assert calls[0]["title"] == "月度报告 2026-03"
    assert calls[0]["source_type"] == "report"
    assert "当前储蓄率不低于 20%" in calls[0]["text"]
    assert "summary" not in calls[0]["text"]


@pytest.mark.asyncio
async def test_report_ingest_failure_does_not_block_report_result(report_store) -> None:
    async def failing_ingest(db, **kwargs) -> None:
        raise RuntimeError("Qdrant unavailable")

    async with report_store() as session:
        result = await generate_monthly_report(
            session,
            1,
            2026,
            3,
            report_ingester=failing_ingest,
        )

    assert result["period"] == "2026-03"


@pytest.mark.asyncio
async def test_monthly_report_persists_report_knowledge_document(report_store) -> None:
    class FakeQdrant:
        def __init__(self) -> None:
            self.exists = False
            self.points: dict[str, object] = {}

        async def collection_exists(self, collection_name: str) -> bool:
            return self.exists

        async def create_collection(self, **kwargs) -> None:
            self.exists = True

        async def upsert(self, **kwargs) -> None:
            for point in kwargs["points"]:
                self.points[point.id] = point

    async def embed(text: str, settings: Settings) -> list[float]:
        return [0.1, 0.2, 0.3]

    qdrant = FakeQdrant()
    settings = Settings(
        _env_file=None,
        database_url="sqlite+aiosqlite:///:memory:",
        qdrant_url="http://fake-qdrant",
        jwt_secret="test-secret-that-is-long-enough",
        embedding_dimension=3,
    )

    async def ingest_report(db, **kwargs) -> None:
        await ingest_knowledge_document(
            db,
            qdrant,
            settings,
            file_path=None,
            embedder=embed,
            **kwargs,
        )

    async with report_store() as session:
        await generate_monthly_report(
            session, 1, 2026, 3, report_ingester=ingest_report
        )
        document = await session.scalar(
            select(KnowledgeDocument).where(
                KnowledgeDocument.user_id == 1,
                KnowledgeDocument.source_type == "report",
            )
        )

    assert document is not None
    assert document.title == "月度报告 2026-03"
    assert document.space_id == 1
    assert qdrant.points[chunk_point_id(document.id, 0)].payload["source_type"] == "report"
