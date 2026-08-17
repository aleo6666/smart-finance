import re
import uuid
from io import BytesIO
from pathlib import Path

from qdrant_client import AsyncQdrantClient
from qdrant_client.http import models
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.tools.search_knowledge_base import COLLECTION_NAME
from app.agents.tools.search_similar_records import Embedder, ensure_collection
from app.core.config import Settings
from app.core.llm import embed_text
from app.models import KnowledgeDocument


MAX_CHUNK_CHARS = 8000

_NAMESPACE = uuid.NAMESPACE_URL


def chunk_point_id(document_id: int, chunk_index: int) -> str:
    """Deterministic Qdrant point id (UUID5) — idempotent, valid for Qdrant.

    Qdrant rejects string ids like "3:0" (only uint or UUID accepted), so we
    derive a stable UUID from (document_id, chunk_index) instead.
    """
    return str(uuid.uuid5(_NAMESPACE, f"knowledge:{document_id}:{chunk_index}"))


def split_knowledge_text(
    text: str,
    max_chars: int = MAX_CHUNK_CHARS,
) -> list[str]:
    paragraphs = [
        paragraph.strip()
        for paragraph in re.split(r"\n\s*\n|\n", text.replace("\r\n", "\n"))
        if paragraph.strip()
    ]
    chunks: list[str] = []
    current = ""
    for paragraph in paragraphs:
        pieces = [
            paragraph[index : index + max_chars]
            for index in range(0, len(paragraph), max_chars)
        ]
        for piece in pieces:
            candidate = f"{current}\n\n{piece}" if current else piece
            if len(candidate) <= max_chars:
                current = candidate
                continue
            chunks.append(current)
            current = piece
    if current:
        chunks.append(current)
    return chunks


async def upsert_knowledge_chunks(
    client: AsyncQdrantClient,
    settings: Settings,
    document: KnowledgeDocument,
    chunks: list[str],
    *,
    embedder: Embedder = embed_text,
    extra_payload: dict[str, object] | None = None,
) -> None:
    await ensure_collection(client, COLLECTION_NAME, settings.embedding_dimension)
    points = []
    payload_user_id = 0 if document.space_id == 0 else document.user_id
    for chunk_index, content in enumerate(chunks):
        payload = {
            **(extra_payload or {}),
            "user_id": payload_user_id,
            "document_id": document.id,
            "chunk_index": chunk_index,
            "title": document.title,
            "source_type": document.source_type,
            "content": content,
        }
        points.append(
            models.PointStruct(
                id=chunk_point_id(document.id, chunk_index),
                vector=await embedder(content, settings),
                payload=payload,
            )
        )
    await client.upsert(
        collection_name=COLLECTION_NAME,
        points=points,
        wait=True,
    )


def extract_text_file(filename: str, content: bytes) -> tuple[str, str]:
    suffix = Path(filename).suffix.lower()
    if suffix == ".pdf":
        from pypdf import PdfReader

        try:
            pages = PdfReader(BytesIO(content)).pages
            return "\n\n".join(page.extract_text() or "" for page in pages), "pdf"
        except Exception as exc:
            raise ValueError("could not extract PDF text") from exc
    if suffix not in {".txt", ".md", ".markdown"}:
        raise ValueError("unsupported knowledge file type")
    try:
        return content.decode("utf-8-sig"), "txt"
    except UnicodeDecodeError as exc:
        raise ValueError("text file must be UTF-8 encoded") from exc


async def ingest_knowledge_document(
    db: AsyncSession,
    client: AsyncQdrantClient,
    settings: Settings,
    *,
    user_id: int,
    space_id: int,
    title: str,
    source_type: str,
    file_path: str | None,
    text: str,
    embedder: Embedder = embed_text,
    extra_payload: dict[str, object] | None = None,
    chunk_text: bool = True,
) -> KnowledgeDocument:
    stripped_text = text.strip()
    chunks = split_knowledge_text(stripped_text) if chunk_text else [stripped_text]
    chunks = [chunk for chunk in chunks if chunk]
    if not chunks:
        raise ValueError("knowledge document has no text content")
    document = KnowledgeDocument(
        user_id=0 if space_id == 0 else user_id,
        space_id=space_id,
        title=title,
        source_type=source_type,
        file_path=file_path,
        chunk_count=len(chunks),
    )
    db.add(document)
    try:
        await db.flush()
        await upsert_knowledge_chunks(
            client,
            settings,
            document,
            chunks,
            embedder=embedder,
            extra_payload=extra_payload,
        )
        await db.commit()
    except Exception:
        await db.rollback()
        raise
    return document


def serialize_knowledge_document(document: KnowledgeDocument) -> dict[str, object]:
    return {
        "id": document.id,
        "user_id": document.user_id,
        "space_id": document.space_id,
        "title": document.title,
        "source_type": document.source_type,
        "file_path": document.file_path,
        "chunk_count": document.chunk_count,
        "created_at": document.created_at,
    }


async def list_knowledge_documents(
    db: AsyncSession,
    user_id: int,
) -> list[dict[str, object]]:
    documents = (
        await db.scalars(
            select(KnowledgeDocument)
            .where(
                or_(
                    KnowledgeDocument.user_id == user_id,
                    KnowledgeDocument.space_id == 0,
                )
            )
            .order_by(KnowledgeDocument.id.desc())
        )
    ).all()
    return [serialize_knowledge_document(document) for document in documents]


async def delete_knowledge_document(
    db: AsyncSession,
    client: AsyncQdrantClient,
    document_id: int,
) -> bool:
    document = await db.get(KnowledgeDocument, document_id)
    if document is None:
        return False
    await client.delete(
        collection_name=COLLECTION_NAME,
        points_selector=models.FilterSelector(
            filter=models.Filter(
                must=[
                    models.FieldCondition(
                        key="document_id",
                        match=models.MatchValue(value=document_id),
                    )
                ]
            )
        ),
        wait=True,
    )
    await db.delete(document)
    await db.commit()
    return True
