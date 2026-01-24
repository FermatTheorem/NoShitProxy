FROM python:3.13-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends proxychains4 && \
    rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir uv

WORKDIR /app

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen

COPY noshitproxy ./noshitproxy
COPY start-proxy.sh docker-entrypoint.sh ./
RUN chmod +x start-proxy.sh docker-entrypoint.sh

ENV PYTHONUNBUFFERED=1
ENV BACKEND_HOST=0.0.0.0
ENV BACKEND_PORT=8000
ENV PROXY_HOST=0.0.0.0
ENV PROXY_PORT=8080
ENV UPSTREAM_PROXY=

EXPOSE 8000 8080

CMD ["./docker-entrypoint.sh"]
