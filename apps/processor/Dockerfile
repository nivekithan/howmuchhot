FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:0.9.22 /uv /bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project --python /usr/local/bin/python
COPY grid.py weather.py job.py server.py ./
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1
USER 10001:10001
EXPOSE 8080
CMD ["python", "server.py"]
