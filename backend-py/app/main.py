from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.agents.graph import create_default_agent
from app.api.chat import router as chat_router
from app.api.financial import router as financial_router
from app.api.health import router as health_router
from app.core.config import Settings, get_settings
from app.core.errors import install_exception_handlers


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
    application.include_router(chat_router)
    application.include_router(financial_router)
    return application


app = create_app()
