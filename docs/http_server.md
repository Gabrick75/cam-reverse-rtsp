# HTTP Server

HTTP server for MJPEG streaming with a built-in web UI dashboard.

## Quick start

```bash
node dist/bin.cjs http_server --discovery_ip 192.168.1.255
```

Open `http://localhost:5000` in a browser.

## Routes

| Route | Description |
|-------|-------------|
| `/` | Dashboard -- camera grid with dark/light theme, search/filter |
| `/camera/<devId>` | MJPEG stream (`multipart/x-mixed-replace`) |
| `/ui/<devId>` | Per-camera UI page |
| `/audio/<devId>` | Audio stream via Server-Sent Events (SSE) |
| `/rotate/<devId>` | Rotate camera 90 degrees (cycles 0-3) |
| `/mirror/<devId>` | Toggle mirror |
| `/favicon.ico` | Favicon |

## MJPEG streaming

Each camera's stream is served as `multipart/x-mixed-replace` with JPEG frames. EXIF orientation headers are inserted based on `rotate`/`mirror` config.

Multiple clients can connect simultaneously per camera.

## Web UI

- Dark/light theme toggle
- Responsive grid layout
- Camera search/filter
- FPS and signal quality indicators
- Audio streaming controls

### Screenshots

**Mobile:**

| Dashboard | Camera View |
|-----------|-------------|
| ![](../pics/mobileAll.png?raw=true) | ![](../pics/mobileCam.png?raw=true) |

**Desktop:**

| Dashboard | Camera View |
|-----------|-------------|
| ![](../pics/pcAll.png?raw=true) | ![](../pics/pcCam.png?raw=true) |

## Latency

MJPEG roundtrip delay is [~350ms](../pics/delay.jpg?raw=true).

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `--port` | `5000` | HTTP port |
| `--discovery_ip` | `192.168.1.255` | Camera discovery IP |
| `--config_file` | -- | YAML config path |
| `--log_level` | `info` | `debug`, `info`, `warning` |
| `--audio` | `false` | Enable audio streaming |

## Config

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
```

All keys are optional. Restart the server for changes to take effect.

### Camera options

| Key | Type | Description |
|-----|------|-------------|
| `alias` | string | Custom name displayed in UI |
| `rotate` | 0-3 | Rotation: 0=0deg, 1=90deg, 2=180deg, 3=270deg |
| `mirror` | bool | Horizontal mirror |
| `audio` | bool | Enable audio for this camera |
| `fix_packet_loss` | bool | Attempt to fix JPEG packet loss artifacts |
