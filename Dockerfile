FROM node:22-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── runtime ──────────────────────────────────────────────
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    gstreamer1.0-tools \
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app/dist/bin.cjs ./dist/bin.cjs

RUN useradd -r -s /usr/sbin/nologin cam
USER cam

EXPOSE 8554/udp
EXPOSE 8554/tcp

ENTRYPOINT ["node", "dist/bin.cjs", "rtsp_server"]
CMD ["--discovery_ip", "192.168.1.255"]
