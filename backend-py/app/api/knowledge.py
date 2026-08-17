from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from qdrant_client import AsyncQdrantClient
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.datastructures import UploadFile

from app.agents.tools.search_similar_records import Embedder
from app.core.config import Settings, get_settings
from app.core.database import get_db
from app.core.llm import embed_text
from app.services.knowledge import (
    delete_knowledge_document,
    extract_text_file,
    ingest_knowledge_document,
    list_knowledge_documents,
)
from app.services.knowledge_seed import seed_public_knowledge


router = APIRouter(prefix="/api/knowledge", tags=["knowledge"])


async def get_qdrant_client() -> AsyncIterator[AsyncQdrantClient]:
    client = AsyncQdrantClient(url=get_settings().qdrant_url)
    try:
        yield client
    finally:
        await client.close()


def get_knowledge_embedder() -> Embedder:
    return embed_text


def _integer_field(
    value: Any,
    name: str,
    *,
    default: int | None = None,
) -> int:
    if value is None and default is not None:
        return default
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=f"invalid {name}") from exc
    if parsed < 0 or (name == "user_id" and parsed == 0):
        raise HTTPException(status_code=422, detail=f"invalid {name}")
    return parsed


@router.post("/upload")
async def upload_knowledge(
    request: Request,
    db: AsyncSession = Depends(get_db),
    qdrant: AsyncQdrantClient = Depends(get_qdrant_client),
    settings: Settings = Depends(get_settings),
    embedder: Embedder = Depends(get_knowledge_embedder),
) -> dict[str, object]:
    if request.headers.get("content-type", "").startswith("application/json"):
        payload = await request.json()
        if not isinstance(payload, dict):
            raise HTTPException(status_code=422, detail="invalid upload payload")
        user_id = _integer_field(payload.get("user_id"), "user_id")
        space_id = _integer_field(
            payload.get("space_id"), "space_id", default=user_id
        )
        title = str(payload.get("title") or "语音转写").strip()
        text = str(payload.get("transcript_text") or "")
        source_type = "audio_transcript"
        file_path = None
    else:
        form = await request.form()
        user_id = _integer_field(form.get("user_id"), "user_id")
        space_id = _integer_field(form.get("space_id"), "space_id", default=user_id)
        uploaded = form.get("file")
        transcript_text = form.get("transcript_text")
        if transcript_text is not None:
            text = str(transcript_text)
            source_type = "audio_transcript"
            file_path = None
            default_title = "语音转写"
        elif isinstance(uploaded, UploadFile):
            file_path = uploaded.filename or "document.txt"
            text, source_type = extract_text_file(file_path, await uploaded.read())
            default_title = Path(file_path).stem
        else:
            raise HTTPException(status_code=400, detail="file or transcript_text required")
        title = str(form.get("title") or default_title).strip()

    try:
        document = await ingest_knowledge_document(
            db,
            qdrant,
            settings,
            user_id=user_id,
            space_id=space_id,
            title=title,
            source_type=source_type,
            file_path=file_path,
            text=text,
            embedder=embedder,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "document_id": document.id,
        "chunk_count": document.chunk_count,
        "status": "indexed",
    }


@router.get("/documents")
async def knowledge_documents(
    user_id: int = Query(gt=0),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, object]]:
    return await list_knowledge_documents(db, user_id)


@router.delete("/documents/{document_id}")
async def delete_document(
    document_id: int,
    db: AsyncSession = Depends(get_db),
    qdrant: AsyncQdrantClient = Depends(get_qdrant_client),
) -> dict[str, object]:
    if not await delete_knowledge_document(db, qdrant, document_id):
        raise HTTPException(status_code=404, detail="knowledge document not found")
    return {"document_id": document_id, "status": "deleted"}


@router.post("/seed-public")
async def seed_public(
    db: AsyncSession = Depends(get_db),
    qdrant: AsyncQdrantClient = Depends(get_qdrant_client),
    settings: Settings = Depends(get_settings),
    embedder: Embedder = Depends(get_knowledge_embedder),
) -> dict[str, int]:
    return await seed_public_knowledge(
        db,
        qdrant,
        settings,
        embedder=embedder,
    )
