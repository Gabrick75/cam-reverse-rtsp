import * as net from "node:net";
import * as os from "node:os";
import * as dgram from "node:dgram";
import { RemoteInfo } from "dgram";

import { logger } from "./logger.js";
import { config } from "./settings.js";
import { discoverDevices } from "./discovery.js";
import { DevSerial } from "./impl.js";
import { Handlers, makeSession, Session, startVideoStream } from "./session.js";
import { isGStreamerAvailable, createTranscoder, Transcoder } from "./transcoder.js";

// RTP payload type 26 = JPEG (RFC 2435)
const MAX_RTP_PAYLOAD = 1400;
// 90kHz clock, ~15fps increment
const TIMESTAMP_INCREMENT = 6000;
// NTP epoch offset: seconds between 1900-01-01 and 1970-01-01
const NTP_EPOCH_OFFSET = 2208988800;
// RTCP Sender Report interval (ms)
const RTCP_SR_INTERVAL_MS = 5000;

type TransportMode = "tcp" | "udp";

type RtspSession = {
  socket: net.Socket;
  clientIp: string;
  sessionId: string;
  playing: boolean;
  seqNum: number;
  timestamp: number;
  ssrc: number;
  rtpChannel: number;
  rtcpChannel: number;
  packetCount: number;
  octetCount: number;
  rtcpTimer: ReturnType<typeof setInterval> | null;
  transport: TransportMode;
  udpSocket: dgram.Socket | null;
  clientRtpPort: number;
  clientRtcpPort: number;
  serverRtpPort: number;
};

// Get the primary local IP (non-loopback)
function getLocalIp(): string {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] ?? []) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
}

// Parse JPEG SOF0 marker to extract width/height
function parseJpegDimensions(jpeg: Buffer): { width: number; height: number } {
  for (let i = 0; i < jpeg.length - 8; i++) {
    if (jpeg[i] === 0xff && jpeg[i + 1] === 0xc0) {
      return {
        height: jpeg.readUInt16BE(i + 5),
        width: jpeg.readUInt16BE(i + 7),
      };
    }
  }
  return { width: 640, height: 480 };
}

// Extract DQT quantization tables from JPEG
function extractQTables(jpeg: Buffer): Buffer | null {
  const tables: Buffer[] = [];
  let i = 0;
  while (i < jpeg.length - 4) {
    if (jpeg[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = jpeg[i + 1];
    if (marker === 0xd8) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const segLen = jpeg.readUInt16BE(i + 2);
    if (marker === 0xdb) {
      tables.push(jpeg.slice(i + 5, i + 2 + segLen));
    }
    i += 2 + segLen;
  }
  return tables.length > 0 ? Buffer.concat(tables) : null;
}

// Build a single RTP packet (RFC 2435 JPEG payload)
function buildRtpPacket(
  chunk: Buffer,
  fragmentOffset: number,
  isLast: boolean,
  isFirst: boolean,
  seqNum: number,
  timestamp: number,
  ssrc: number,
  width: number,
  height: number,
  qTable: Buffer | null,
): Buffer {
  let qHeader: Buffer | null = null;
  if (isFirst && qTable) {
    qHeader = Buffer.alloc(4 + qTable.length);
    qHeader[0] = 0;
    qHeader[1] = 0;
    qHeader.writeUInt16BE(qTable.length, 2);
    qTable.copy(qHeader, 4);
  }

  const headerSize = 12 + 8 + (qHeader ? qHeader.length : 0);
  const pkt = Buffer.alloc(headerSize + chunk.length);
  let off = 0;

  // RTP fixed header (12 bytes)
  pkt[off++] = 0x80;
  pkt[off++] = (isLast ? 0x80 : 0x00) | 26; // M bit + PT=26 (JPEG)
  pkt.writeUInt16BE(seqNum & 0xffff, off);
  off += 2;
  pkt.writeUInt32BE(timestamp >>> 0, off);
  off += 4;
  pkt.writeUInt32BE(ssrc >>> 0, off);
  off += 4;

  // JPEG RTP header (8 bytes, RFC 2435 §3.1)
  pkt[off++] = 0;
  pkt[off++] = (fragmentOffset >> 16) & 0xff;
  pkt[off++] = (fragmentOffset >> 8) & 0xff;
  pkt[off++] = fragmentOffset & 0xff;
  pkt[off++] = 1; // type = YUV 4:2:2
  pkt[off++] = qTable ? 255 : 10;
  pkt[off++] = Math.min(255, Math.floor(width / 8));
  pkt[off++] = Math.min(255, Math.floor(height / 8));

  if (isFirst && qHeader) {
    qHeader.copy(pkt, off);
    off += qHeader.length;
  }

  chunk.copy(pkt, off);
  return pkt;
}

// Wrap RTP in RTSP interleaved framing: $ | channel(1) | length(2) | data
function interleavedFrame(channel: number, data: Buffer): Buffer {
  const frame = Buffer.alloc(4 + data.length);
  frame[0] = 0x24; // '$'
  frame[1] = channel;
  frame.writeUInt16BE(data.length, 2);
  data.copy(frame, 4);
  return frame;
}

// Build RTCP Sender Report (RFC 3550 §6.4.1)
function buildRtcpSr(ssrc: number, rtpTimestamp: number, packetCount: number, octetCount: number): Buffer {
  const now = Date.now() / 1000;
  const ntpSec = Math.floor(now) + NTP_EPOCH_OFFSET;
  const ntpFrac = Math.floor((now % 1) * 0x100000000);

  const pkt = Buffer.alloc(28);
  pkt[0] = 0x80; // V=2, P=0, RC=0
  pkt[1] = 200; // PT = SR (200)
  pkt.writeUInt16BE(6, 2); // Length = 6 (28 bytes / 4 - 1)
  pkt.writeUInt32BE(ssrc >>> 0, 4);
  pkt.writeUInt32BE(ntpSec >>> 0, 8);
  pkt.writeUInt32BE(ntpFrac >>> 0, 12);
  pkt.writeUInt32BE(rtpTimestamp >>> 0, 16);
  pkt.writeUInt32BE(packetCount >>> 0, 20);
  pkt.writeUInt32BE(octetCount >>> 0, 24);
  return pkt;
}

// Send periodic RTCP Sender Report on the RTCP interleaved channel
function sendRtcpSr(sess: RtspSession): void {
  if (!sess.playing || sess.socket.destroyed) return;
  const sr = buildRtcpSr(sess.ssrc, sess.timestamp, sess.packetCount, sess.octetCount);
  try {
    if (sess.transport === "udp" && sess.udpSocket) {
      sess.udpSocket.send(sr, sess.clientRtcpPort, sess.clientIp);
    } else {
      const frame = interleavedFrame(sess.rtcpChannel, sr);
      sess.socket.write(frame);
    }
  } catch (e) {
    logger.debug(`RTCP write error: ${e}`);
  }
}

// Send one JPEG frame as RTP over TCP (interleaved) or UDP
function sendFrameOverTcp(sess: RtspSession, jpeg: Buffer): void {
  if (!sess.playing || sess.socket.destroyed) return;

  const { width, height } = parseJpegDimensions(jpeg);
  const qTable = extractQTables(jpeg);

  // Find SOS marker — RFC 2435 carries scan data only
  let dataStart = 0;
  for (let i = 0; i < jpeg.length - 1; i++) {
    if (jpeg[i] === 0xff && jpeg[i + 1] === 0xda) {
      const sosLen = jpeg.readUInt16BE(i + 2);
      dataStart = i + 2 + sosLen;
      break;
    }
  }
  const payload = dataStart > 0 ? jpeg.slice(dataStart) : jpeg;

  let fragmentOffset = 0;
  let isFirst = true;

  while (fragmentOffset < payload.length) {
    const chunkSize = Math.min(MAX_RTP_PAYLOAD, payload.length - fragmentOffset);
    const chunk = payload.slice(fragmentOffset, fragmentOffset + chunkSize);
    const isLast = fragmentOffset + chunkSize >= payload.length;

    const rtp = buildRtpPacket(
      chunk,
      fragmentOffset,
      isLast,
      isFirst,
      sess.seqNum,
      sess.timestamp,
      sess.ssrc,
      width,
      height,
      isFirst ? qTable : null,
    );

    try {
      if (sess.transport === "udp" && sess.udpSocket) {
        sess.udpSocket.send(rtp, sess.clientRtpPort, sess.clientIp);
      } else {
        const frame = interleavedFrame(sess.rtpChannel, rtp);
        sess.socket.write(frame);
      }
    } catch (e) {
      logger.debug(`RTP write error: ${e}`);
      return;
    }

    sess.seqNum = (sess.seqNum + 1) & 0xffff;
    sess.packetCount++;
    sess.octetCount += chunk.length;
    fragmentOffset += chunkSize;
    isFirst = false;
  }

  sess.timestamp = (sess.timestamp + TIMESTAMP_INCREMENT) >>> 0;
}

export const serveRtsp = async (port: number) => {
  const localIp = getLocalIp();
  const rtspSessions = new Map<string, RtspSession>();
  const ssrc = Math.floor(Math.random() * 0xffffffff);

  const useH264 = await isGStreamerAvailable();
  if (useH264) {
    logger.info("GStreamer detected — serving H.264 via openh264enc");
  } else {
    logger.info("GStreamer not available — serving JPEG (RFC 2435)");
  }

  const buildJpegSdp = (): string => {
    return [
      "v=0",
      `o=- 0 0 IN IP4 ${localIp}`,
      "s=cam-reverse",
      `c=IN IP4 ${localIp}`,
      "t=0 0",
      "a=control:*",
      "m=video 0 RTP/AVP 26",
      "a=rtpmap:26 JPEG/90000",
      "a=fmtp:26 quantization=255; width=640; height=480",
      "a=control:trackID=0",
      "",
    ].join("\r\n");
  };

  const buildH264Sdp = (): string => {
    return [
      "v=0",
      `o=- 0 0 IN IP4 ${localIp}`,
      "s=cam-reverse",
      `c=IN IP4 ${localIp}`,
      "t=0 0",
      "a=control:*",
      "m=video 0 RTP/AVP 96",
      "a=rtpmap:96 H264/90000",
      "a=fmtp:96 packetization-mode=1; profile-level-id=42C01E",
      "a=control:trackID=0",
      "",
    ].join("\r\n");
  };

  const buildSdp = (): string => (useH264 ? buildH264Sdp() : buildJpegSdp());

  const parseHeaders = (raw: string): Record<string, string> => {
    const headers: Record<string, string> = {};
    for (const line of raw.split("\r\n").slice(1)) {
      const idx = line.indexOf(": ");
      if (idx !== -1) headers[line.slice(0, idx).toLowerCase()] = line.slice(idx + 2);
    }
    return headers;
  };

  const tcpServer = net.createServer((socket) => {
    const clientIp = (socket.remoteAddress ?? "").replace("::ffff:", "");
    logger.info(`RTSP client connected from ${clientIp}`);

    let buf = "";
    let activeSessId: string | null = null;
    let processing = false;

    socket.setEncoding("binary");

    socket.on("data", async (data) => {
      buf += data;
      if (processing) return;
      processing = true;

      while (buf.includes("\r\n\r\n")) {
        const end = buf.indexOf("\r\n\r\n") + 4;
        const raw = buf.slice(0, end);
        buf = buf.slice(end);

        const firstLine = raw.split("\r\n")[0];
        const [method, uri] = firstLine.split(" ");
        const headers = parseHeaders(raw);
        const cseq = headers["cseq"] ?? "0";

        logger.debug(`RTSP ${method} ${uri}`);

        switch (method) {
          case "OPTIONS":
            socket.write(
              `RTSP/1.0 200 OK\r\n` + `CSeq: ${cseq}\r\n` + `Public: OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN\r\n\r\n`,
            );
            break;

          case "DESCRIBE": {
            const sdp = buildSdp();
            socket.write(
              `RTSP/1.0 200 OK\r\n` +
                `CSeq: ${cseq}\r\n` +
                `Content-Type: application/sdp\r\n` +
                `Content-Base: rtsp://${localIp}:${port}/camera/\r\n` +
                `Content-Length: ${Buffer.byteLength(sdp, "utf8")}\r\n\r\n` +
                sdp,
            );
            break;
          }

          case "SETUP": {
            const transport = headers["transport"] ?? "";
            const chanMatch = transport.match(/interleaved=(\d+)-(\d+)/);
            const portMatch = transport.match(/client_port=(\d+)-(\d+)/);
            const useUdp = !chanMatch && !!portMatch;

            const rtpChan = chanMatch ? parseInt(chanMatch[1]) : 0;
            const rtcpChan = chanMatch ? parseInt(chanMatch[2]) : 1;
            const clientRtpPort = portMatch ? parseInt(portMatch[1]) : 0;
            const clientRtcpPort = portMatch ? parseInt(portMatch[2]) : 0;

            // Reuse existing session for this socket if it exists (NVR may
            // send multiple SETUP for different tracks on same connection)
            const existingSid = headers["session"]?.split(";")[0].trim();
            const sessionId =
              existingSid && rtspSessions.has(existingSid) ? existingSid : Math.random().toString(36).slice(2, 12);
            activeSessId = sessionId;

            // For UDP: create a bound UDP socket
            let udpSocket: dgram.Socket | null = null;
            let serverRtpPort = 0;
            if (useUdp) {
              udpSocket = dgram.createSocket("udp4");
              // Bind to port 0 → OS picks an available port
              // Use a Promise-based bind + address read
              await new Promise<void>((resolve) => {
                udpSocket!.bind(0, () => {
                  const addr = udpSocket!.address();
                  serverRtpPort = addr.port;
                  resolve();
                });
              });
              logger.info(
                `UDP transport: server port ${serverRtpPort}, client ${clientIp}:${clientRtpPort}-${clientRtcpPort}`,
              );
            }

            rtspSessions.set(sessionId, {
              socket,
              clientIp,
              sessionId,
              playing: false,
              seqNum: Math.floor(Math.random() * 0xffff),
              timestamp: Math.floor(Math.random() * 0xffffffff),
              ssrc,
              rtpChannel: rtpChan,
              rtcpChannel: rtcpChan,
              packetCount: 0,
              octetCount: 0,
              rtcpTimer: null,
              transport: useUdp ? "udp" : "tcp",
              udpSocket,
              clientRtpPort,
              clientRtcpPort,
              serverRtpPort,
            });

            if (useUdp) {
              socket.write(
                `RTSP/1.0 200 OK\r\n` +
                  `CSeq: ${cseq}\r\n` +
                  `Transport: RTP/AVP/UDP;unicast;client_port=${clientRtpPort}-${clientRtcpPort};server_port=${serverRtpPort}-${serverRtpPort + 1}\r\n` +
                  `Session: ${sessionId};timeout=60\r\n\r\n`,
              );
            } else {
              socket.write(
                `RTSP/1.0 200 OK\r\n` +
                  `CSeq: ${cseq}\r\n` +
                  `Transport: RTP/AVP/TCP;unicast;interleaved=${rtpChan}-${rtcpChan}\r\n` +
                  `Session: ${sessionId};timeout=60\r\n\r\n`,
              );
            }
            break;
          }

          case "PLAY": {
            // Session header may include timeout suffix e.g. "g76g2gwwod;timeout=60"
            const sid = headers["session"]?.split(";")[0].trim() ?? activeSessId ?? "";
            const sess = rtspSessions.get(sid);
            if (sess) {
              sess.playing = true;
              // Start periodic RTCP Sender Reports
              sess.rtcpTimer = setInterval(() => sendRtcpSr(sess), RTCP_SR_INTERVAL_MS);
              logger.info(`RTSP PLAY from ${clientIp} session=${sid}`);
            } else {
              logger.debug(`RTSP PLAY: session ${sid} not found, known: ${[...rtspSessions.keys()].join(",")}`);
            }
            socket.write(
              `RTSP/1.0 200 OK\r\n` + `CSeq: ${cseq}\r\n` + `Session: ${sid}\r\n` + `Range: npt=0.000-\r\n\r\n`,
            );
            break;
          }

          case "GET_PARAMETER":
          case "SET_PARAMETER": {
            // LIVE555 sends GET_PARAMETER as keepalive — must respond 200
            const sid = headers["session"]?.split(";")[0].trim() ?? activeSessId ?? "";
            socket.write(`RTSP/1.0 200 OK\r\n` + `CSeq: ${cseq}\r\n` + `Session: ${sid}\r\n\r\n`);
            break;
          }

          case "TEARDOWN": {
            const sid = headers["session"]?.split(";")[0].trim() ?? activeSessId ?? "";
            const torn = rtspSessions.get(sid);
            if (torn?.rtcpTimer) clearInterval(torn.rtcpTimer);
            if (torn?.udpSocket) {
              try {
                torn.udpSocket.close();
              } catch (_) {}
            }
            rtspSessions.delete(sid);
            logger.info(`RTSP TEARDOWN from ${clientIp}`);
            socket.write(`RTSP/1.0 200 OK\r\n` + `CSeq: ${cseq}\r\n` + `Session: ${sid}\r\n\r\n`);
            socket.destroy();
            break;
          }

          default:
            socket.write(`RTSP/1.0 501 Not Implemented\r\n` + `CSeq: ${cseq}\r\n\r\n`);
        }
      }

      processing = false;
    });

    socket.on("close", () => {
      if (activeSessId) {
        const closed = rtspSessions.get(activeSessId);
        if (closed?.rtcpTimer) clearInterval(closed.rtcpTimer);
        if (closed?.udpSocket) {
          try {
            closed.udpSocket.close();
          } catch (_) {}
        }
        rtspSessions.delete(activeSessId);
        logger.info(`RTSP client ${clientIp} disconnected`);
      }
    });

    socket.on("error", (err) => {
      logger.debug(`RTSP socket error: ${err.message}`);
    });
  });

  // Camera discovery
  const camSessions: Record<string, Session> = {};
  const transcoders: Record<string, Transcoder> = {};

  const forwardRtp = (rtpPacket: Buffer) => {
    for (const sess of rtspSessions.values()) {
      if (!sess.playing || sess.socket.destroyed) continue;
      try {
        if (sess.transport === "udp" && sess.udpSocket) {
          sess.udpSocket.send(rtpPacket, sess.clientRtpPort, sess.clientIp);
        } else {
          const frame = interleavedFrame(sess.rtpChannel, rtpPacket);
          sess.socket.write(frame);
        }
      } catch (_) {}
    }
  };

  const startSession = (s: Session) => {
    startVideoStream(s);
    logger.info(`Camera ${s.devName} ready, streaming to RTSP`);
  };

  const devEv = discoverDevices(config.discovery_ips);

  devEv.on("discover", (rinfo: RemoteInfo, dev: DevSerial) => {
    if (dev.devId in camSessions) {
      logger.info(`Camera ${dev.devId} already discovered, ignoring`);
      return;
    }

    logger.info(`Discovered camera ${dev.devId} at ${rinfo.address}`);
    config.cameras[dev.devId] = {
      rotate: 0,
      mirror: false,
      audio: false,
      ...(config.cameras[dev.devId] || {}),
    };

    const s = makeSession(Handlers, dev, rinfo, startSession, 5000);
    camSessions[dev.devId] = s;

    if (useH264) {
      const tc = createTranscoder();
      transcoders[dev.devId] = tc;

      tc.eventEmitter.on("rtp", (rtpPacket: Buffer) => {
        forwardRtp(rtpPacket);
      });

      tc.eventEmitter.on("exit", () => {
        if (!(dev.devId in camSessions)) {
          logger.debug(`Transcoder for ${dev.devId} exited after camera disconnect, ignoring`);
          return;
        }
        logger.warning(`Transcoder for ${dev.devId} exited, restarting...`);
        delete transcoders[dev.devId];
        const newTc = createTranscoder();
        transcoders[dev.devId] = newTc;
        newTc.eventEmitter.on("rtp", forwardRtp);
      });

      s.eventEmitter.on("frame", () => {
        const jpeg = Buffer.concat(s.curImage);
        tc.writeJpeg(jpeg);
      });
    } else {
      s.eventEmitter.on("frame", () => {
        const jpeg = Buffer.concat(s.curImage);
        for (const sess of rtspSessions.values()) {
          sendFrameOverTcp(sess, jpeg);
        }
      });
    }

    s.eventEmitter.on("disconnect", () => {
      logger.info(`Camera ${dev.devId} disconnected`);
      if (transcoders[dev.devId]) {
        transcoders[dev.devId].close();
        delete transcoders[dev.devId];
      }
      delete camSessions[dev.devId];
    });
  });

  tcpServer.listen(port, () => {
    logger.info(`RTSP server listening on rtsp://${localIp}:${port}/camera`);
    logger.info(`Connect your NVR/VLC to: rtsp://${localIp}:${port}/camera`);
  });
};
