from types import SimpleNamespace
import asyncio
import json
import sys

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.config import Settings, get_settings
from app.core.database import get_db
from app.main import create_app
from app.models import Base, KnowledgeDocument


def make_settings() -> Settings:
    return Settings(
        _env_file=None,
        database_url="sqlite+aiosqlite:///:memory:",
        qdrant_url="http://127.0.0.1:6333",
        jwt_secret="test-secret-that-is-long-enough",
        embedding_dimension=3,
    )


class FakeQdrantClient:
    def __init__(self) -> None:
        self.exists = False
        self.created: list[dict[str, object]] = []
        self.upserts: list[dict[str, object]] = []
        self.deletes: list[dict[str, object]] = []
        self.searches: list[dict[str, object]] = []
        self.points: dict[str, object] = {}

    async def collection_exists(self, collection_name: str) -> bool:
        return self.exists

    async def create_collection(self, **kwargs: object) -> None:
        self.created.append(kwargs)
        self.exists = True

    async def upsert(self, **kwargs: object) -> None:
        self.upserts.append(kwargs)
        for point in kwargs["points"]:
            self.points[point.id] = point

    async def delete(self, **kwargs: object) -> None:
        self.deletes.append(kwargs)

    async def search(self, **kwargs: object) -> list[SimpleNamespace]:
        self.searches.append(kwargs)
        return [
            SimpleNamespace(id=point.id, score=0.9, payload=point.payload)
            for point in self.points.values()
        ]


async def fake_embedder(text: str, settings: Settings) -> list[float]:
    assert text
    assert settings.embedding_dimension == 3
    return [0.1, 0.2, 0.3]


@pytest_asyncio.fixture
async def knowledge_store():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield sessions
    await engine.dispose()


def test_split_knowledge_text_merges_paragraphs_without_exceeding_limit() -> None:
    from app.services.knowledge import split_knowledge_text

    text = "A" * 3000 + "\n\n" + "B" * 3000 + "\n\n" + "C" * 3000

    chunks = split_knowledge_text(text)

    assert chunks == ["A" * 3000 + "\n\n" + "B" * 3000, "C" * 3000]
    assert all(len(chunk) <= 8000 for chunk in chunks)


def test_split_knowledge_text_splits_a_single_oversized_paragraph() -> None:
    from app.services.knowledge import split_knowledge_text

    chunks = split_knowledge_text("长" * 16001)

    assert [len(chunk) for chunk in chunks] == [8000, 8000, 1]


def test_extract_text_file_reads_pdf_pages(monkeypatch) -> None:
    from app.services.knowledge import extract_text_file

    pages = [
        SimpleNamespace(extract_text=lambda: "第一页"),
        SimpleNamespace(extract_text=lambda: "第二页"),
    ]
    monkeypatch.setitem(
        sys.modules,
        "pypdf",
        SimpleNamespace(PdfReader=lambda _stream: SimpleNamespace(pages=pages)),
    )

    text, source_type = extract_text_file("guide.pdf", b"fake-pdf")

    assert text == "第一页\n\n第二页"
    assert source_type == "pdf"


def test_knowledge_document_model_has_required_metadata() -> None:
    from app.models import KnowledgeDocument

    assert KnowledgeDocument.__tablename__ == "knowledge_documents"
    assert set(KnowledgeDocument.__table__.columns.keys()) == {
        "id",
        "user_id",
        "space_id",
        "title",
        "source_type",
        "file_path",
        "chunk_count",
        "created_at",
    }
    assert set(KnowledgeDocument.__table__.c.source_type.type.enums) == {
        "pdf",
        "txt",
        "audio_transcript",
        "chat_memory",
        "report",
        "seed",
    }
    assert ("user_id",) in {
        tuple(column.name for column in index.columns)
        for index in KnowledgeDocument.__table__.indexes
    }


def test_public_seed_contains_nine_nonempty_multi_paragraph_documents() -> None:
    from app.services.knowledge_seed import PUBLIC_KNOWLEDGE_DOCUMENTS

    assert len(PUBLIC_KNOWLEDGE_DOCUMENTS) == 9
    assert len({document["title"] for document in PUBLIC_KNOWLEDGE_DOCUMENTS}) == 9
    for document in PUBLIC_KNOWLEDGE_DOCUMENTS:
        paragraphs = document["content"].split("\n\n")
        assert 2 <= len(paragraphs) <= 6
        assert all(paragraph.strip() for paragraph in paragraphs)

    combined = "\n".join(
        document["content"] for document in PUBLIC_KNOWLEDGE_DOCUMENTS
    )
    for expected in (
        "3—6个月",
        "4321",
        "5000元",
        "专项附加扣除",
        "双十原则",
        "不推荐具体产品",
        "40%",
        "50/30/20",
        "复利",
    ):
        assert expected in combined


@pytest.mark.asyncio
async def test_upsert_knowledge_chunks_has_stable_ids_and_public_payload() -> None:
    from app.services.knowledge import upsert_knowledge_chunks

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    client = FakeQdrantClient()
    async with AsyncSession(engine, expire_on_commit=False) as session:
        document = KnowledgeDocument(
            user_id=0,
            space_id=0,
            title="公共指南",
            source_type="seed",
            file_path=None,
            chunk_count=2,
        )
        session.add(document)
        await session.flush()

        await upsert_knowledge_chunks(
            client,
            make_settings(),
            document,
            ["第一段", "第二段"],
            embedder=fake_embedder,
        )
        await upsert_knowledge_chunks(
            client,
            make_settings(),
            document,
            ["第一段", "第二段"],
            embedder=fake_embedder,
        )

    assert client.created[0]["collection_name"] == "knowledge_chunks_v1"
    assert list(client.points) == [f"{document.id}:0", f"{document.id}:1"]
    assert len(client.points) == 2
    payloads = [point.payload for point in client.points.values()]
    assert [payload["chunk_index"] for payload in payloads] == [0, 1]
    assert payloads[0] == {
        "user_id": 0,
        "document_id": document.id,
        "chunk_index": 0,
        "title": "公共指南",
        "source_type": "seed",
        "content": "第一段",
    }
    assert client.upserts[-1]["wait"] is True
    await engine.dispose()


def test_txt_upload_route_persists_lists_and_indexes_document(knowledge_store) -> None:
    from app.agents.tools.search_knowledge_base import (
        create_search_knowledge_base_tool,
    )
    from app.api.knowledge import get_knowledge_embedder, get_qdrant_client

    client = FakeQdrantClient()
    application = create_app(chat_agent=object())

    async def override_get_db():
        async with knowledge_store() as session:
            yield session

    async def override_qdrant():
        yield client

    application.dependency_overrides[get_db] = override_get_db
    application.dependency_overrides[get_settings] = make_settings
    application.dependency_overrides[get_qdrant_client] = override_qdrant
    application.dependency_overrides[get_knowledge_embedder] = lambda: fake_embedder

    with TestClient(application) as api:
        uploaded = api.post(
            "/api/knowledge/upload",
            data={"user_id": "7", "title": "应急资金指南"},
            files={
                "file": (
                    "emergency.md",
                    "应急备用金应覆盖三到六个月必要开支。\n\n资金应保持高流动性。",
                    "text/markdown",
                )
            },
        )
        assert uploaded.status_code == 200
        assert uploaded.json() == {
            "document_id": 1,
            "chunk_count": 1,
            "status": "indexed",
        }

        documents = api.get("/api/knowledge/documents?user_id=7")
        assert documents.status_code == 200
        assert documents.json()[0] == {
            "id": 1,
            "user_id": 7,
            "space_id": 7,
            "title": "应急资金指南",
            "source_type": "txt",
            "file_path": "emergency.md",
            "chunk_count": 1,
            "created_at": documents.json()[0]["created_at"],
        }

        assert api.get("/api/knowledge/documents?user_id=8").json() == []

    point = client.points["1:0"]
    assert point.payload["user_id"] == 7
    assert point.payload["document_id"] == 1
    assert point.payload["source_type"] == "txt"

    async def keep_order(query, documents, settings):
        return documents

    tool = create_search_knowledge_base_tool(
        client,
        make_settings(),
        embedder=fake_embedder,
        reranker=keep_order,
    )
    result = json.loads(
        asyncio.run(tool.ainvoke({"query": "应急备用金", "user_id": 7}))
    )
    assert result["dataset_refs"] == [
        {"source": "知识库", "document_id": 1, "chunk_index": 0}
    ]


def test_transcript_json_upload_is_indexed_as_audio_transcript(
    knowledge_store,
) -> None:
    from app.api.knowledge import get_knowledge_embedder, get_qdrant_client

    client = FakeQdrantClient()
    application = create_app(chat_agent=object())

    async def override_get_db():
        async with knowledge_store() as session:
            yield session

    async def override_qdrant():
        yield client

    application.dependency_overrides[get_db] = override_get_db
    application.dependency_overrides[get_settings] = make_settings
    application.dependency_overrides[get_qdrant_client] = override_qdrant
    application.dependency_overrides[get_knowledge_embedder] = lambda: fake_embedder

    with TestClient(application) as api:
        uploaded = api.post(
            "/api/knowledge/upload",
            json={
                "user_id": 7,
                "title": "语音转写",
                "transcript_text": "本月应先补足应急备用金。",
            },
        )
        assert uploaded.status_code == 200

        document = api.get("/api/knowledge/documents?user_id=7").json()[0]
        assert document["source_type"] == "audio_transcript"
        assert document["file_path"] is None

    assert client.points["1:0"].payload["source_type"] == "audio_transcript"


def test_delete_route_removes_document_with_qdrant_document_filter(
    knowledge_store,
) -> None:
    from app.api.knowledge import get_knowledge_embedder, get_qdrant_client

    client = FakeQdrantClient()
    application = create_app(chat_agent=object())

    async def override_get_db():
        async with knowledge_store() as session:
            yield session

    async def override_qdrant():
        yield client

    application.dependency_overrides[get_db] = override_get_db
    application.dependency_overrides[get_settings] = make_settings
    application.dependency_overrides[get_qdrant_client] = override_qdrant
    application.dependency_overrides[get_knowledge_embedder] = lambda: fake_embedder

    with TestClient(application) as api:
        assert (
            api.post(
                "/api/knowledge/upload",
                data={"user_id": "7"},
                files={"file": ("notes.txt", "需要删除的内容", "text/plain")},
            ).status_code
            == 200
        )

        deleted = api.delete("/api/knowledge/documents/1")

        assert deleted.status_code == 200
        assert deleted.json() == {"document_id": 1, "status": "deleted"}
        assert api.get("/api/knowledge/documents?user_id=7").json() == []

    call = client.deletes[0]
    assert call["collection_name"] == "knowledge_chunks_v1"
    assert call["wait"] is True
    condition = call["points_selector"].filter.must[0]
    assert condition.key == "document_id"
    assert condition.match.value == 1


def test_seed_public_route_is_idempotent_and_searchable_by_any_user(
    knowledge_store,
) -> None:
    from app.agents.tools.search_knowledge_base import (
        create_search_knowledge_base_tool,
    )
    from app.api.knowledge import get_knowledge_embedder, get_qdrant_client
    from app.services.knowledge_seed import PUBLIC_KNOWLEDGE_DOCUMENTS

    client = FakeQdrantClient()
    application = create_app(chat_agent=object())

    async def override_get_db():
        async with knowledge_store() as session:
            yield session

    async def override_qdrant():
        yield client

    async def keep_order(query, documents, settings):
        return documents

    application.dependency_overrides[get_db] = override_get_db
    application.dependency_overrides[get_settings] = make_settings
    application.dependency_overrides[get_qdrant_client] = override_qdrant
    application.dependency_overrides[get_knowledge_embedder] = lambda: fake_embedder

    seed_count = len(PUBLIC_KNOWLEDGE_DOCUMENTS)
    with TestClient(application) as api:
        first = api.post("/api/knowledge/seed-public")
        second = api.post("/api/knowledge/seed-public")
        documents = api.get("/api/knowledge/documents?user_id=88").json()

    assert first.status_code == 200
    assert first.json() == {"created": seed_count, "skipped": 0, "total": seed_count}
    assert second.json() == {"created": 0, "skipped": seed_count, "total": seed_count}
    assert len(documents) == seed_count
    assert all(document["user_id"] == 0 for document in documents)
    assert all(document["space_id"] == 0 for document in documents)

    tool = create_search_knowledge_base_tool(
        client,
        make_settings(),
        embedder=fake_embedder,
        reranker=keep_order,
    )
    result = json.loads(
        asyncio.run(tool.ainvoke({"query": "应急备用金", "user_id": 88}))
    )
    query_filter = client.searches[-1]["query_filter"]
    assert [condition.match.value for condition in query_filter.should] == [88, 0]
    assert result["results"]
    assert all(item["user_id"] == 0 for item in result["results"])
