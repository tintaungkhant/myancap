FROM oven/bun:1-slim

# ffmpeg + python3 (yt-dlp is a python zipapp). yt-dlp itself is the latest
# standalone binary — Debian's package lags and breaks on YouTube changes
# (nsig/SABR extraction failures).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 ca-certificates curl \
 && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production
COPY . .
RUN mkdir -p /data

ENV DATABASE_PATH=/data/myancap.db \
    WORK_DIR=/tmp/myancap \
    PORT=3000

VOLUME ["/data"]
EXPOSE 3000
CMD ["bun", "run", "src/index.ts"]
