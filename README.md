# Smarter IPTV Transcoder

This is the server component for streams that browsers cannot decode, especially MKV, HEVC/H.265, odd audio/video tracks, and unstable live MPEG-TS streams.

It uses FFmpeg to output browser-friendly HLS:

- video: H.264, 720p max, yuv420p
- audio: AAC stereo
- HLS segment length: 2 seconds

## Run Locally

Install FFmpeg on the server, then:

```bash
npm start
```

Environment variables:

```bash
PORT=8080
PUBLIC_BASE_URL=https://your-transcoder-domain.com
CORS_ORIGIN=*
MEDIA_ROOT=/tmp/smarter-iptv-hls
ACCESS_TOKEN=change-this-long-random-token
```

Health check:

```bash
curl https://your-transcoder-domain.com/health
```

Transcode URL format:

```text
https://your-transcoder-domain.com/hls?profile=live&url=ENCODED_STREAM_URL
https://your-transcoder-domain.com/hls?profile=vod&url=ENCODED_STREAM_URL
```

When `ACCESS_TOKEN` is set:

```text
https://your-transcoder-domain.com/hls?profile=vod&token=TOKEN&url=ENCODED_STREAM_URL
```

Live uses a small rolling playlist for fast startup. VOD/Series uses a full HLS playlist so the browser has a better chance of showing normal seeking controls while FFmpeg converts the file.

## Docker Deploy

This folder includes a Dockerfile with FFmpeg already installed.

```bash
docker build -t smarter-iptv-transcoder .
docker run -p 8080:8080 \
  -e PUBLIC_BASE_URL=https://your-transcoder-domain.com \
  -e CORS_ORIGIN='*' \
  -e ACCESS_TOKEN=change-this-long-random-token \
  smarter-iptv-transcoder
```

For a VPS with Docker Compose, copy `.env.example` to `.env`, edit the values, then run:

```bash
docker compose up -d --build
```

For Render, use `render.yaml` and set `PUBLIC_BASE_URL` after the first deploy to the Render service URL or your custom domain.

## Recommended Hosting

Use a small VPS first. Render/Railway/Fly can work, but FFmpeg video transcoding needs CPU and long-running processes. A $6-$12/month VPS is usually more reliable for IPTV.
