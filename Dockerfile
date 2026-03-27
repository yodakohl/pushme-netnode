FROM alpine:3.23@sha256:25109184c71bdad752c8312a8623239686a9a2071e8825f20acb8f2198c3f659

LABEL org.opencontainers.image.title="pushme-netnode" \
      org.opencontainers.image.description="Low-footprint runtime for PushMe netnodes" \
      org.opencontainers.image.vendor="PushMe"

RUN apk add --no-cache \
    bind-tools=9.20.21-r0 \
    curl=8.17.0-r1 \
    iputils=20250605-r0 \
    ca-certificates=20251003-r0

WORKDIR /app

COPY netnode.sh ./netnode.sh
COPY setup.sh ./setup.sh
COPY docker-entrypoint.sh ./docker-entrypoint.sh
COPY VERSION ./VERSION

RUN chmod +x ./netnode.sh ./setup.sh ./docker-entrypoint.sh

ENV PUSHME_BOT_URL=https://pushme.site \
    NETNODE_VERSION_FILE=/app/VERSION \
    NETNODE_RELEASE_CHANNEL=stable \
    NETNODE_IMAGE_REPOSITORY=ghcr.io/yodakohl/pushme-netnode \
    NETNODE_STATE_FILE=/data/netnode-state.tsv \
    NETNODE_ENV_FILE=/data/netnode.env

VOLUME ["/data"]

ENTRYPOINT ["sh", "./docker-entrypoint.sh"]
CMD ["sh", "./netnode.sh"]
