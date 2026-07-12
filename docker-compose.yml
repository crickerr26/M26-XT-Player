services:
  transcoder:
    build: .
    container_name: smarter-iptv-transcoder
    restart: unless-stopped
    environment:
      NODE_ENV: production
      PORT: "8080"
      PUBLIC_BASE_URL: "${PUBLIC_BASE_URL}"
      CORS_ORIGIN: "${CORS_ORIGIN:-*}"
      ACCESS_TOKEN: "${ACCESS_TOKEN}"
      MEDIA_ROOT: /tmp/smarter-iptv-hls
      SESSION_TTL_MS: "1800000"
    ports:
      - "8080:8080"
    tmpfs:
      - /tmp/smarter-iptv-hls:size=4096m
