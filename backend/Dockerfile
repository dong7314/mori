FROM python:3.12-slim-bookworm AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

FROM base AS builder
RUN pip install --no-cache-dir uv==0.12.15
WORKDIR /app
ENV UV_PYTHON_DOWNLOADS=never UV_COMPILE_BYTECODE=1
COPY pyproject.toml uv.lock ./
COPY src ./src
RUN uv sync --frozen --no-dev --no-editable

FROM base AS runtime
RUN groupadd --gid 10001 mori && useradd --uid 10001 --gid mori --no-create-home mori
WORKDIR /app
COPY --from=builder /app/.venv /app/.venv
COPY alembic.ini ./
COPY migrations ./migrations
ENV PATH="/app/.venv/bin:$PATH"
USER 10001:10001
EXPOSE 8000
# OAuth callback query strings contain short-lived credentials; do not log request URLs.
CMD ["uvicorn", "mori.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
