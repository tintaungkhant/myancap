FROM oven/bun:1-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg yt-dlp ca-certificates \
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
