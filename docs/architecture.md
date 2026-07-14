# Architecture

## Project overview

cam-reverse-rtsp is a reverse-engineered re-implementation of the **iLnkP2P/PPPP** protocol used by ultra-cheap (<$5) IP cameras (branded as X5, A9, A7). It provides two streaming modes: an HTTP/MJPEG server with web UI, and a native RTSP server for NVR integration.

Main chip: **TXW817** (Taixin Semiconductor). Companion app: **YsxLite**.

## Data flow

```
Camera (iLnkP2P/UDP, port 32108)
       |
       v
 discovery.ts  -- UDP broadcast LanSearch, receive PunchPkt
       |
       v
 session.ts    -- P2PRdy -> ConnectUser -> login -> StartVideo
                 Keepalive loop (P2PAlive/Ack every 400ms, 5s timeout)
       |
       v
 handlers.ts   -- Drw packets -> JPEG frame assembly / audio extraction
       |
       +--------> http_server.ts   (MJPEG HTTP streaming + web UI)
       |
       +--------> rtsp_server.ts   (RTSP/RTP streaming)
                    |
                    +--- JPEG mode  (RFC 2435, no transcoding)
                    |
                    +--- H.264 mode (GStreamer transcoder.ts)
                           JPEG -> openh264enc -> rtph264pay -> UDP -> RTP forwarding
```

## Source files

| File | Purpose |
|------|---------|
| `bin.ts` / `cmd/bin.ts` | CLI entry point (yargs). Commands: `http_server`, `rtsp_server`, `pair`, `frame` |
| `rtsp_server.ts` | RTSP server -- protocol handling, RTP/JPEG and RTP/H.264 packetization, SDP, TCP/UDP transport, RTCP SR, session management |
| `transcoder.ts` | GStreamer JPEG-to-H.264 transcoder -- subprocess management, UDP socket, SPS/PPS extraction |
| `http_server.ts` | HTTP server -- MJPEG streaming, WebSocket, web UI dashboard (dark/light theme) |
| `session.ts` | Camera session lifecycle -- UDP socket, packet dispatch, keepalive, timeout, retransmission |
| `handlers.ts` | Protocol command handlers -- JPEG frame assembly, audio extraction, control command dispatch |
| `impl.ts` | Protocol command construction -- Drw packet builder, login, video start, WiFi config |
| `datatypes.ts` | Command constants and protocol type definitions |
| `discovery.ts` | UDP broadcast device discovery (port 32108) |
| `settings.ts` | YAML config file loading |
| `exif.ts` | EXIF orientation insertion for JPEG rotation |
| `shim.ts` | DataView convenience methods extension |
| `logger.ts` | Winston logging setup |
| `pair.ts` | WiFi pairing workflow |
| `capture_single.ts` | Single frame capture |
| `dissector.lua` | Wireshark protocol dissector |
| `func_replacements.js` | Frida function replacement hooks |

## Network ports

| Port | Protocol | Purpose |
|------|----------|---------|
| 32108 | UDP | iLnkP2P discovery and camera communication |
| 5000 | TCP | HTTP server (default) |
| 8554 | TCP | RTSP server (default) |
| Dynamic | UDP | GStreamer RTP output (127.0.0.1 loopback) |
| Dynamic | UDP | Per-camera session socket |
| Dynamic | UDP | RTP/RTCP to RTSP clients (UDP transport mode) |

## Configuration

Config file format (YAML):

```yml
http_server:
  port: 5000

rtsp_server:
  port: 8554

logging:
  level: info        # debug, info, warning
  use_color: true

cameras:
  FTYC477360FAWUK:
    alias: "A9"
    rotate: 1         # 0=0deg, 1=90deg, 2=180deg, 3=270deg
    mirror: false
    audio: true
    fix_packet_loss: yes

discovery_ips:
  - 192.168.1.255    # broadcast address, or individual IPs for VLANs

blacklisted_ips:
  - 192.168.0.100
```

All keys are optional. See [Initial Setup](guide-initial-setup.md) for details.
