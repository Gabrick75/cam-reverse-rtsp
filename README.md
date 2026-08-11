<p align="center">
  <img src="pics/front.jpg" width="300" alt="X5 Camera">
</p>

<h1 align="center">cam-reverse-rtsp</h1>

<p align="center">
  Reverse-engineered RTSP/HTTP server for ultra-cheap iLnkP2P IP cameras (X5, A9, A7)
</p>

---

Re-implementation of the **iLnkP2P/PPPP** protocol used on cheap (<$5) IP cameras with the **TXW817** chip. Streams camera video directly to NVRs, VLC, Blue Iris, Home Assistant, or any RTSP/MJPEG client -- no cloud, no app, no intermediaries.

Tested with [X5](https://www.aliexpress.com/item/1005006287788979.html), [A9](https://www.aliexpress.com/item/1005006117593880.html), and [A7 1080p](http://pt.aliexpress.com/item/1005011735155071.html). App: [YsxLite](https://play.google.com/store/apps/details?id=com.ysxlite.cam).

## Features

- **RTSP server** -- H.264 (via GStreamer) or JPEG/RTP, TCP and UDP transport
- **HTTP server** -- MJPEG streaming + web UI dashboard
- Multi-camera support, audio & video
- Rotation / mirroring, friendly names
- WiFi camera configuration (pairing)
- Single frame capture

## Known Limitations

- **RTSP multi-camera:** Currently all cameras share a single RTSP endpoint (`/camera`). Each camera needs its own path (`/camera/<devId>`). Workaround: run one RTSP server instance per camera with different ports. Fix planned.

## Quick start

```bash
npm install && npm run build

# RTSP (for NVR / VLC / Blue Iris)
node dist/bin.cjs rtsp_server --discovery_ip 192.168.1.255

# HTTP (for browser)
node dist/bin.cjs http_server --discovery_ip 192.168.1.255
```

Connect to `rtsp://<your-ip>:8554/camera` or open `http://localhost:5000`.

## Documentation

|                                              |                                                     |
| -------------------------------------------- | --------------------------------------------------- |
| [Architecture](docs/architecture.md)         | Project structure, data flow, source files          |
| [Initial Setup](docs/guide-initial-setup.md) | Building, pairing cameras, running, config          |
| [RTSP Server](docs/rtsp.md)                  | RTSP/RTP streaming, H.264/JPEG modes, compatibility |
| [HTTP Server](docs/http_server.md)           | MJPEG streaming, web UI, routes                     |
| [iLnkP2P Protocol](docs/protocol.md)         | Reverse-engineered camera protocol                  |
| [GStreamer](docs/gstreamer.md)               | JPEG-to-H.264 transcoding pipeline                  |
| [Reverse Engineering](docs/reversing.md)     | Ghidra, Frida, Wireshark dissector                  |

## Camera PCB

<p align="center">
  <img src="pics/pcb.jpg" width="400" alt="X5 PCB">
</p>

Per pictures of the [X5](https://github.com/DavidVentura/cam-reverse/blob/master/pics/pcb.jpg?raw=true) and [A9](https://github.com/DavidVentura/cam-reverse/blob/master/pics/pcb_a9.jpg?raw=true), the main chip is TXW817 ([chinese](https://www.taixin-semi.com/Product/ProductDetail?productId=306), [english](https://www-taixin--semi-com.translate.goog/Product/ProductDetail?productId=306&_x_tr_sl=auto&_x_tr_tl=en&_x_tr_hl=en&_x_tr_pto=wapp)).

## Cloud / spyware

The cameras connect to Tencent cloud servers on boot. **Block outbound internet access** on your router. Both servers work fully offline. See [Protocol docs](docs/protocol.md) for details on the spyware IPs.

## Firmware alternatives

[OpenBK7231T](https://github.com/openshwprojects/OpenBK7231T_App) provides open firmware for XR872, but the camera driver is not yet implemented. cam-reverse-rtsp is the current best option for local streaming.

## Building

```bash
npm run build     # esbuild -> dist/bin.cjs
npm run typecheck # TypeScript type checking
npm test          # Mocha tests
```

Pre-built binaries: [CI results](https://github.com/DavidVentura/cam-reverse/actions) | [Releases](https://github.com/DavidVentura/cam-reverse/releases/)

## License

See repository for license details. This is a fork of [DavidVentura/cam-reverse](https://github.com/DavidVentura/cam-reverse).
