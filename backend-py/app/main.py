from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.agents.graph import create_default_agent
from app.api.analysis import router as analysis_router
from app.api.auth import router as auth_router
from app.api.budgets import router as budgets_router
from app.api.chat import router as chat_router
from app.api.financial import router as financial_router
from app.api.goals import router as goals_router
from app.api.health import router as health_router
from app.api.knowledge import router as knowledge_router
from app.api.ledgers import router as ledgers_router
from app.api.ocr import router as ocr_router
from app.api.records import router as records_router
from app.api.reports import router as reports_router
from app.api.speech import router as speech_router
from app.core.config import Settings, get_settings
from app.core.errors import install_exception_handlers
from app.tasks.scheduler import mount_scheduler


def create_app(
    settings: Settings | None = None,
    *,
    chat_agent: object | None = None,
) -> FastAPI:
    app_settings = settings or get_settings()
    application = FastAPI(title=app_settings.app_name)
    application.add_middleware(
        CORSMiddleware,
        allow_origins=app_settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    install_exception_handlers(application)
    application.state.chat_agent = chat_agent or create_default_agent(app_settings)
    application.include_router(health_router)
    application.include_router(auth_router)
    application.include_router(records_router)
    application.include_router(ledgers_router)
    application.include_router(budgets_router)
    application.include_router(goals_router)
    application.include_router(chat_router)
    application.include_router(financial_router)
    application.include_router(analysis_router)
    application.include_router(reports_router)
    application.include_router(knowledge_router)
    application.include_router(speech_router)
    application.include_router(ocr_router)
    mount_scheduler(application, app_settings)
    return application


app = create_app()
