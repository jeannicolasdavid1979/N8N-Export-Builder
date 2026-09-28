FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml README.md ./
COPY n8n_builder ./n8n_builder
RUN pip install --no-cache-dir . && useradd -r -u 10001 builder && mkdir /data && chown builder /data
USER builder
ENV N8NB_DATA=/data N8NB_HOST=0.0.0.0 N8NB_PORT=8790
EXPOSE 8790
VOLUME /data
CMD ["n8n-export-builder"]
