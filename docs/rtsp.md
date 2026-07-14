# RTSP Server

Native RTSP server for streaming camera video to NVRs, Blue Iris, Home Assistant, VLC, and any RTSP-compatible client.

## Quick start

```bash
node dist/bin.cjs rtsp_server --discovery_ip 192.168.1.255
```

Connect to `rtsp://<your-machine-ip>:8554/camera`. No credentials required.

## Installing GStreamer (H.264 mode)

The H.264 transcoding mode requires GStreamer and the `openh264enc` encoder. If GStreamer is not installed, the server falls back to JPEG/RTP automatically.

### Ubuntu / Debian

```bash
sudo apt install gstreamer1.0-tools \
  gstreamer1.0-plugins-base \
  gstreamer1.0-plugins-good \
  gstreamer1.0-plugins-bad
```

### Fedora

```bash
sudo dnf install gstreamer1-plugins-base \
  gstreamer1-plugins-good \
  gstreamer1-plugins-bad-free
```

### Arch Linux

```bash
sudo pacman -S gst-plugins-base gst-plugins-good gst-plugins-bad
```

### Verify

```bash
gst-launch-1.0 --version
```

If this prints a version number, the RTSP server will automatically use H.264 mode.

## Streaming modes

The server selects a mode automatically at startup based on GStreamer availability.

### H.264 mode (GStreamer, recommended)

When GStreamer is installed, JPEG frames from the camera are transcoded to H.264. This mode is compatible with virtually all NVRs.

```
Camera (iLnkP2P/UDP)
  -> JPEG frames (1028-byte fragments)
  -> handlers.ts (frame assembly)
  -> GStreamer (transcoder.ts): JPEG -> openh264enc -> rtph264pay
  -> RTP/AVP/TCP or RTP/AVP/UDP
  -> NVR / VLC / Android
```

### JPEG/RTP mode (no GStreamer)

Without GStreamer, JPEG is streamed directly via RTP/JPEG (RFC 2435). Works with VLC and Android, but not all NVRs support JPEG/RTP.

```
Camera (iLnkP2P/UDP)
  -> JPEG frames (1028-byte fragments)
  -> handlers.ts (frame assembly)
  -> RTP/JPEG packetization (RFC 2435)
  -> RTP/AVP/TCP or RTP/AVP/UDP
  -> NVR / VLC / Android
```

## Transport modes

The server supports both TCP interleaved and UDP unicast, auto-detected from the client's SETUP request.

### TCP interleaved (RFC 2326)

```
Transport: RTP/AVP/TCP;unicast;interleaved=0-1
```

- RTP on channel 0, RTCP on channel 1
- Framed as `$<channel><2-byte-length><data>`
- More reliable, works through firewalls/NAT
- Default for most RTSP clients

### UDP unicast

```
Transport: RTP/AVP/UDP;unicast;client_port=50000-50001
```

- RTP to `client_ip:50000`, RTCP to `client_ip:50001`
- Server responds with `server_port=<port>-<port+1>`

## SDP

### H.264 SDP

```
v=0
o=- 0 0 IN IP4 <server-ip>
s=cam-reverse
c=IN IP4 <server-ip>
t=0 0
a=control:*
m=video 0 RTP/AVP 96
a=rtpmap:96 H264/90000
a=fmtp:96 packetization-mode=1; profile-level-id=42C01E
a=control:trackID=0
```

- Payload type 96 (dynamic)
- H.264 Constrained Baseline Profile, Level 3.0
- Non-interleaved packetization mode (single NAL + FU-A)
- SPS/PPS sent inline with every IDR frame (`config-interval=-1`)

### JPEG SDP

```
v=0
o=- 0 0 IN IP4 <server-ip>
s=cam-reverse
c=IN IP4 <server-ip>
t=0 0
a=control:*
m=video 0 RTP/AVP 26
a=rtpmap:26 JPEG/90000
a=fmtp:26 quantization=255; width=640; height=480
a=control:trackID=0
```

- Payload type 26 (static, RFC 2435)
- Quantization tables embedded in first RTP fragment

## RTSP methods

| Method | Description |
|--------|-------------|
| `OPTIONS` | Returns supported methods |
| `DESCRIBE` | Returns SDP |
| `SETUP` | Negotiates transport (TCP or UDP) |
| `PLAY` | Starts streaming |
| `GET_PARAMETER` | Keepalive response (LIVE555 clients) |
| `SET_PARAMETER` | Keepalive response |
| `TEARDOWN` | Stops stream, closes session |

## RTCP Sender Reports

Sent every 5 seconds on the RTCP channel per RFC 3550 section 6.4.1. Required by many NVRs for stream liveness detection and timing synchronization.

Contents: NTP timestamp, RTP timestamp, packet count, octet count.

## RTP packetization

### RTP/JPEG (RFC 2435)

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|V=2|P|X|  CC   |M|     PT      |       Sequence Number         |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                           Timestamp                           |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                             SSRC                              |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
| Type-specific |              Fragment Offset                  |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
| Type  |       Q       |     Width     |     Height            |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
| Quantization Table (if Q=255, first fragment only)            |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
| Scan Data                                                   |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

- Type: 1, Q: 255 (tables present), Width/Height: divided by 8
- Fragment offset: 24-bit, max 16 MB
- MAX_RTP_PAYLOAD: 1400 bytes per fragment

### RTP/H.264 (RFC 6184)

Generated by GStreamer's `rtph264pay`:

- **Single NAL**: Small NAL units in one RTP packet
- **FU-A fragmentation**: Large NALs split across packets (FU indicator: `F|NRI|Type=28`, FU header: `S|E|R|Type`)
- **STAP-A**: SPS/PPS aggregation
- SPS/PPS sent with every IDR frame

## Client compatibility

| Client | H.264 | JPEG | Notes |
|--------|-------|------|-------|
| VLC | Yes | Yes | Set RTP over RTSP (TCP) in preferences |
| Android (YsxLite) | Yes | Yes | -- |
| Generic NVR | Yes | Maybe | Most NVRs require H.264 |
| Blue Iris | Yes | Yes | Add as Generic RTSP |
| Home Assistant | Yes | Yes | Generic camera integration |

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--port` | `8554` | RTSP port |
| `--discovery_ip` | from config | Camera discovery IP |
| `--config_file` | -- | YAML config path |
| `--log_level` | `info` | `debug`, `info`, `warning` |

## Troubleshooting

- **No video in NVR**: Check H.264 support; use `--log_level debug`
- **GStreamer not detected**: Run `gst-launch-1.0 --version`; falls back to JPEG mode
- **High latency**: openh264enc configured for low latency; typical 100-300ms
- **Black screen in VLC**: Enable RTP over RTSP (TCP) in codec preferences
- **Connection refused**: Check port, firewall rules, UDP port range for UDP mode
