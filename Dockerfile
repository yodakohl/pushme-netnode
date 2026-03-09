FROM node:20-alpine

RUN apk add --no-cache iputils

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY docker-entrypoint.sh ./docker-entrypoint.sh

RUN chmod +x ./docker-entrypoint.sh

ENV PUSHME_BOT_URL=https://pushme.site \
    NETNODE_STATE_FILE=/data/netnode-state.json

VOLUME ["/data"]

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "./src/index.mjs"]
