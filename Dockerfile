FROM alpine:3.20@sha256:a4f4213abb84c497377b8544c81b3564f313746700372ec4fe84653e4fb03805

LABEL org.opencontainers.image.title="pushme-netnode" \
      org.opencontainers.image.description="Low-footprint runtime for PushMe netnodes" \
      org.opencontainers.image.vendor="PushMe"

RUN apk add --no-cache bind-tools curl iputils ca-certificates

WORKDIR /app

COPY netnode.sh ./netnode.sh
COPY setup.sh ./setup.sh
COPY docker-entrypoint.sh ./docker-entrypoint.sh

RUN chmod +x ./netnode.sh ./setup.sh ./docker-entrypoint.sh

ENV PUSHME_BOT_URL=https://pushme.site \
    NETNODE_VERSION=0.3.1 \
    NETNODE_RELEASE_CHANNEL=stable \
    NETNODE_IMAGE_REPOSITORY=ghcr.io/yodakohl/pushme-netnode \
    NETNODE_STATE_FILE=/data/netnode-state.tsv \
    NETNODE_ENV_FILE=/data/netnode.env

VOLUME ["/data"]

ENTRYPOINT ["sh", "./docker-entrypoint.sh"]
CMD ["sh", "./netnode.sh"]
