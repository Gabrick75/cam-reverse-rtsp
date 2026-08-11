# GStreamer Transcoding

The RTSP server uses GStreamer to transcode JPEG frames from the camera into H.264 for maximum NVR compatibility.

## Pipeline

```
fdsrc fd=0               -- reads JPEG from stdin
  ! jpegdec              -- decode JPEG to raw video
  ! videoconvert         -- color space conversion
  ! openh264enc          -- H.264 software encoder
      complexity=low     -- fastest encoding
      bitrate=300000     -- 300 kbps (adjust per device CPU)
      gop-size=15        -- keyframe every 15 frames (~1s at 15fps)
      usage-type=camera  -- optimized for camera content
  ! video/x-h264,stream-format=byte-stream,profile=constrained-baseline
  ! h264parse            -- parse H.264 stream
  ! rtph264pay           -- RTP packetization
      config-interval=-1 -- SPS/PPS with every IDR frame
      pt=96              -- payload type 96
  ! udpsink host=127.0.0.1 port=<dynamic>  -- UDP loopback output
```

## How it works

Each camera gets its own transcoder instance (`transcoder.ts`):

1. A UDP socket is bound to `127.0.0.1` on an OS-assigned port
2. GStreamer is spawned with the pipeline above, outputting RTP to that socket
3. JPEG frames from the camera are written to GStreamer's stdin
4. RTP packets are received on the UDP socket and emitted via EventEmitter
5. SPS (NAL type 7) and PPS (NAL type 8) NAL units are extracted for inline delivery
6. If GStreamer crashes, the transcoder emits an `exit` event and the server creates a new instance

## Requirements

| Plugin         | Package (Ubuntu/Debian)     | Purpose                |
| -------------- | --------------------------- | ---------------------- |
| `fdsrc`        | `gstreamer1.0`              | Read JPEG from stdin   |
| `jpegdec`      | `gstreamer1.0-plugins-good` | Decode JPEG            |
| `videoconvert` | `gstreamer1.0-plugins-good` | Color space conversion |
| `openh264enc`  | `gstreamer1.0-plugins-bad`  | H.264 encoder          |
| `h264parse`    | `gstreamer1.0-plugins-bad`  | Parse H.264            |
| `rtph264pay`   | `gstreamer1.0-plugins-good` | RTP packetization      |
| `udpsink`      | `gstreamer1.0-plugins-good` | UDP output             |

### Install on Ubuntu/Debian

```bash
sudo apt install gstreamer1.0-tools \
  gstreamer1.0-plugins-base \
  gstreamer1.0-plugins-good \
  gstreamer1.0-plugins-bad
```

### Verify installation

```bash
gst-launch-1.0 --version
```

If GStreamer is not installed, the RTSP server falls back to JPEG/RTP mode automatically.

## Encoder parameters

| Parameter         | Value                  | Effect                                                     |
| ----------------- | ---------------------- | ---------------------------------------------------------- |
| `complexity`      | `low`                  | Fastest encoding, minimal CPU                              |
| `bitrate`         | `300000`               | 300 kbps target bitrate (see Tuning for per-device values) |
| `gop-size`        | `15`                   | Keyframe every 15 frames (~1s)                             |
| `usage-type`      | `camera`               | Optimized for camera content                               |
| `profile`         | `constrained-baseline` | Maximum client compatibility                               |
| `config-interval` | `-1`                   | SPS/PPS with every IDR frame                               |

## Tuning

All encoder parameters are in `transcoder.ts`, inside the GStreamer args array (line ~90):

```typescript
const args = [
  "fdsrc",
  "fd=0",
  "!",
  "jpegdec",
  "!",
  "videoconvert",
  "!",
  "openh264enc",
  "complexity=low", // ← encoding speed
  "bitrate=300000", // ← change this value
  "gop-size=15", // ← keyframe interval
  "usage-type=camera",
  "!",
  "video/x-h264,stream-format=byte-stream,profile=constrained-baseline",
  "!",
  "h264parse",
  "!",
  "rtph264pay",
  "config-interval=-1",
  "pt=96",
  "!",
  "udpsink",
  "host=127.0.0.1",
  `port=${port}`,
];
```

| Goal                | Parameter to change                  | Effect                                                |
| ------------------- | ------------------------------------ | ----------------------------------------------------- |
| **Lower bandwidth** | `bitrate=300000`                     | Reduces quality but uses less CPU and bandwidth       |
| **Higher quality**  | `bitrate=500000` or `bitrate=700000` | Better image, more CPU and bandwidth                  |
| **Faster encoding** | `complexity=low` (already set)       | Fastest, use `medium` or `high` only on fast machines |
| **Lower latency**   | `gop-size=10`                        | More frequent keyframes, slightly more bandwidth      |

Recommended values by device:

| Device                       | `bitrate`          | `complexity`   | Notes                            |
| ---------------------------- | ------------------ | -------------- | -------------------------------- |
| ARM 1GHz (msm8916, RPi Zero) | `200000`–`300000`  | `low`          | openh264enc is slow on weak CPUs |
| ARM 2GHz+ (RPi 4, SBC)       | `300000`–`500000`  | `low`          | comfortable headroom             |
| x86 notebook/desktop         | `500000`–`1000000` | `low`–`medium` | plenty of CPU                    |

Typical end-to-end latency: 100-300ms depending on network.

## NAL unit extraction

The transcoder extracts SPS and PPS from the RTP stream by parsing NAL unit types:

- NAL type 7 (`& 0x1f == 7`): SPS (Sequence Parameter Set)
- NAL type 8 (`& 0x1f == 8`): PPS (Picture Parameter Set)

For FU-A fragmented NALs (type 28), the start bit (`S` flag in FU header) is checked before extracting the type from the FU header.

These are stored and can be accessed via `transcoder.getSps()` and `transcoder.getPps()`.
