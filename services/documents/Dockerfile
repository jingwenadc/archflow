FROM node:22-bookworm-slim AS node
FROM python:3.12-slim-bookworm
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 HOME=/tmp/archflow-documents
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libreoffice-impress libreoffice-writer libreoffice-calc poppler-utils tesseract-ocr tesseract-ocr-chi-sim fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/* && groupadd --gid 10001 archflow && useradd --uid 10001 --gid 10001 --no-create-home archflow
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm
COPY services/documents/package.json services/documents/package-lock.json ./documents/
RUN cd documents && npm ci --omit=dev
COPY services/api/pyproject.toml ./pyproject.toml
COPY services/api/src ./src
RUN pip install --no-cache-dir .
COPY services/documents/render-slides.mjs ./documents/
USER 10001:10001
CMD ["python", "-m", "archflow_api.document_worker"]
