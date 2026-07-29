FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The transcoder is pure Node built-ins (http/https/fs/path/crypto/child_process) plus FFmpeg
# from apt above — it imports NO npm packages. The repo's package.json is the browser/desktop
# app's manifest (Electron/Capacitor/hls.js), which the server never uses; running `npm install`
# on it was both unnecessary and the step that failed the Render build (exit 254). So we copy
# only server.js and run it directly — nothing to install. (sqlite3 for the optional licensing
# routes is not required; the server disables those routes gracefully when it's absent.)
# admin.html is the activation dashboard, served by the transcoder itself (same origin as the
# /api routes) so the admin key never leaves your browser cross-origin. server.js is the app.
COPY server.js ./
COPY admin.html ./

ENV NODE_ENV=production
ENV PORT=8080
ENV MEDIA_ROOT=/tmp/smarter-iptv-hls

EXPOSE 8080

ENTRYPOINT ["tini", "--"]
CMD ["node", "server.js"]
