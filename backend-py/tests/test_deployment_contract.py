from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[1]


def read_file(name: str) -> str:
    return (BACKEND_ROOT / name).read_text(encoding="utf-8")


def test_compose_pins_qdrant_and_preserves_host_port_contract() -> None:
    compose = read_file("docker-compose.yml")

    assert "qdrant/qdrant:v1.11.3" in compose
    assert "qdrant/qdrant:latest" not in compose
    assert '"127.0.0.1:${BACKEND_PORT:-3000}:8000"' in compose
    assert "mysql:8.4" in compose


def test_python_dependencies_use_asyncmy_not_aiomysql() -> None:
    requirements = read_file("requirements.txt")

    assert "asyncmy" in requirements
    assert "aiomysql" not in requirements


def test_python_qdrant_client_matches_pinned_server() -> None:
    requirements = read_file("requirements.txt").splitlines()

    assert "qdrant-client==1.11.3" in requirements


def test_dockerfile_runs_as_non_root_python_311_user() -> None:
    dockerfile = read_file("Dockerfile")

    assert dockerfile.startswith("FROM python:3.11-slim")
    assert "USER app" in dockerfile
    assert 'CMD ["uvicorn", "app.main:app"' in dockerfile


def test_environment_example_lists_required_phase_one_settings() -> None:
    keys = {
        line.split("=", 1)[0]
        for line in read_file(".env.example").splitlines()
        if line and not line.startswith("#") and "=" in line
    }

    assert {
        "DATABASE_URL",
        "QDRANT_URL",
        "REDIS_URL",
        "LLM_API_KEY",
        "EMBEDDING_API_KEY",
        "RERANK_API_KEY",
        "JWT_SECRET",
        "RAG_TOP_K",
        "RAG_RERANK_TOP_K",
        "RAG_MAX_CONTEXT_CHARS",
        "EMBEDDING_DIMENSION",
        "AGENT_MAX_ITERATIONS",
    } <= keys


def test_compose_forwards_agent_vector_configuration() -> None:
    compose = read_file("docker-compose.yml")

    assert "EMBEDDING_DIMENSION: ${EMBEDDING_DIMENSION:-1024}" in compose
    assert "AGENT_MAX_ITERATIONS: ${AGENT_MAX_ITERATIONS:-8}" in compose
