# syntax=docker/dockerfile:1

FROM rust:1.89-slim-bookworm AS builder
WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY backend ./backend

RUN cargo build --locked --release -p server

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home compralo \
    && mkdir -p /data \
    && chown compralo:compralo /data

COPY --from=builder /app/target/release/server /usr/local/bin/compralo-server
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh

USER compralo
ENV BIND_ADDR=0.0.0.0:8080 \
    DATABASE_URL=sqlite:///data/buy-agent.sqlite?mode=rwc \
    RUST_LOG=server=info,tower_http=info
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl --fail --silent http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
