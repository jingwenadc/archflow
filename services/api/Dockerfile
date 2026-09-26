FROM python:3.12-slim AS builder

ENV PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /build
COPY services/api/pyproject.toml ./pyproject.toml
COPY services/api/src ./src
RUN pip wheel --no-cache-dir --wheel-dir /wheels .

FROM python:3.12-slim AS runner

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV ARCHFLOW_UPLOAD_DIR=/data/uploads
ENV ARCHFLOW_PROJECT_DIR=/data/projects
ENV ARCHFLOW_CASE_UPLOAD_DIR=/data/cases
ENV ARCHFLOW_DATABASE_PATH=/data/archflow.sqlite3
ENV ARCHFLOW_REPOSITORY_ROOT=/app

RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 archflow \
  && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin archflow

WORKDIR /app
COPY --from=builder /wheels /wheels
RUN pip install --no-cache-dir /wheels/*.whl && rm -rf /wheels
COPY skills ./skills
COPY deploy/api/entrypoint.sh /usr/local/bin/archflow-entrypoint
RUN chmod 0755 /usr/local/bin/archflow-entrypoint

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3).read()"

ENTRYPOINT ["archflow-entrypoint"]
CMD ["uvicorn", "archflow_api.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips=*"]
