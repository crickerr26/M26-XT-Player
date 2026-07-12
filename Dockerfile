FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

ENV NODE_ENV=production
ENV PORT=8080
ENV MEDIA_ROOT=/tmp/smarter-iptv-hls

EXPOSE 8080

ENTRYPOINT ["tini", "--"]
CMD ["node", "server.js"]
