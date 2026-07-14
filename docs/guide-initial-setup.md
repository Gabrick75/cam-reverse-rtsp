# Initial Setup

## Requirements

- Node.js >= 16
- npm
- (Optional) GStreamer for H.264 transcoding -- see [GStreamer docs](gstreamer.md)

## Building

```bash
npm install
npm run build
```

This produces `dist/bin.cjs` via esbuild.

Pre-built binaries may be available in [CI results](https://github.com/DavidVentura/cam-reverse/actions) or [releases](https://github.com/DavidVentura/cam-reverse/releases/).

## Pairing a new camera

1. Put the camera in access point mode -- the blue LED blinks slowly. Press the MODE button for 5s if needed.
2. Connect your computer to the camera's AP (e.g., `FTYC811847AGFDZ`).
3. Run:

```bash
node dist/bin.cjs pair --ssid <YOUR_WIFI_SSID> --password <YOUR_WIFI_PASSWORD>
```

The camera will join your WiFi network. Its LED will indicate connection status.

## Running the servers

### HTTP server (MJPEG + web UI)

```bash
node dist/bin.cjs http_server --discovery_ip 192.168.1.255
```

Open `http://localhost:5000` in a browser. See [HTTP Server docs](http_server.md).

### RTSP server (NVR / VLC / Blue Iris)

```bash
node dist/bin.cjs rtsp_server --discovery_ip 192.168.1.255
```

Point your NVR or player to `rtsp://<your-machine-ip>:8554/camera`. See [RTSP Server docs](rtsp.md).

### Single frame capture

```bash
node dist/bin.cjs frame --discovery_ip 192.168.1.255 --out snapshot.jpg
```

## CLI options

### http_server

| Option | Default | Description |
|--------|---------|-------------|
| `--port` | `5000` | HTTP port |
| `--discovery_ip` | `192.168.1.255` | Camera discovery IP (broadcast or unicast) |
| `--config_file` | -- | Path to YAML config |
| `--log_level` | `info` | `debug`, `info`, `warning` |
| `--audio` | `false` | Enable audio streaming |

### rtsp_server

| Option | Default | Description |
|--------|---------|-------------|
| `--port` | `8554` | RTSP port |
| `--discovery_ip` | `192.168.1.255` | Camera discovery IP |
| `--config_file` | -- | Path to YAML config |
| `--log_level` | `info` | `debug`, `info`, `warning` |

### pair

| Option | Required | Description |
|--------|----------|-------------|
| `--ssid` | Yes | WiFi network name |
| `--password` | Yes | WiFi password |
| `--discovery_ip` | No | Camera discovery IP |

### frame

| Option | Default | Description |
|--------|---------|-------------|
| `--out` | -- | Output file path (required) |
| `--discovery_ip` | `192.168.1.255` | Camera discovery IP |

## Config file

```yml
http_server:
  port: 5000

logging:
  level: info
  use_color: true

cameras:
  FTYC477360FAWUK:
    alias: "A9"
    rotate: 1
    mirror: false
    audio: true
    fix_packet_loss: yes
  BATC609531EXLVS:
    alias: "X5"

# Use broadcast for same subnet, individual IPs for VLANs
discovery_ips:
  - 192.168.1.255

blacklisted_ips:
  - 192.168.0.100
```

Pass with `--config_file config.yml`. Restart the server for changes to take effect.

## Cloud / spyware

The cameras connect to Tencent cloud servers on boot. Block outbound internet access on your router. Both servers work fully offline.
