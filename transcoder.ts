import { spawn, ChildProcess } from "node:child_process";
import * as dgram from "node:dgram";
import { EventEmitter } from "node:events";

import { logger } from "./logger.js";

export type Transcoder = {
  eventEmitter: EventEmitter;
  writeJpeg: (jpeg: Buffer) => void;
  close: () => void;
  getSps: () => Buffer | null;
  getPps: () => Buffer | null;
};

export async function isGStreamerAvailable(): Promise<boolean> {
  const gstVersion = await new Promise<boolean>((resolve) => {
    const proc = spawn("gst-launch-1.0", ["--version"]);
    let out = "";
    proc.stdout?.on("data", (d: Buffer) => {
      out += d;
    });
    proc.stderr?.on("data", (d: Buffer) => {
      out += d;
    });
    proc.on("close", (code) => {
      if (code === 0) logger.info(`GStreamer available: ${out.split("\n")[0]}`);
      resolve(code === 0);
    });
    proc.on("error", () => resolve(false));
  });

  if (!gstVersion) return false;

  const hasPlugin = await new Promise<boolean>((resolve) => {
    const proc = spawn("gst-launch-1.0", [
      "-q",
      "videotestsrc",
      "num-buffers=1",
      "!",
      "videoconvert",
      "!",
      "openh264enc",
      "!",
      "fakesink",
    ]);
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });

  if (!hasPlugin) {
    logger.warning("GStreamer found but openh264enc plugin missing — falling back to JPEG/RTP");
  }

  return hasPlugin;
}

function extractNalType(rtp: Buffer): number | null {
  if (rtp.length < 13) return null;
  const p = 12; // RTP header start
  const first = rtp[p];
  const nalType = first & 0x1f;

  if (nalType === 28) {
    // FU-A fragmentation
    if (rtp.length < 14) return null;
    const fuHeader = rtp[p + 1];
    if (!(fuHeader & 0x80)) return null; // not first fragment
    return fuHeader & 0x1f;
  }
  return nalType;
}

export function createTranscoder(): Transcoder {
  const eventEmitter = new EventEmitter();
  const udpSocket = dgram.createSocket("udp4");
  let gstProcess: ChildProcess | null = null;
  let sps: Buffer | null = null;
  let pps: Buffer | null = null;
  let stdinBackpressure = false;
  let droppedFrames = 0;

  udpSocket.on("message", (msg: Buffer) => {
    const nalType = extractNalType(msg);
    if (nalType === 7) {
      sps = Buffer.from(msg.subarray(12));
      logger.debug(`Transcoder: SPS captured (${sps.length} bytes)`);
    } else if (nalType === 8) {
      pps = Buffer.from(msg.subarray(12));
      logger.debug(`Transcoder: PPS captured (${pps.length} bytes)`);
    }
    eventEmitter.emit("rtp", msg);
  });

  udpSocket.on("error", (err) => {
    logger.error(`Transcoder UDP error: ${err.message}`);
  });

  udpSocket.bind(0, () => {
    const port = udpSocket.address().port;

    const args = [
      "fdsrc",
      "fd=0",
      "!",
      "jpegdec",
      "!",
      "videoconvert",
      "!",
      "openh264enc",
      "complexity=low",
      "bitrate=300000",
      "gop-size=15",
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

    gstProcess = spawn("gst-launch-1.0", args, { stdio: ["pipe", "ignore", "pipe"] });

    let stderrOutput = "";
    gstProcess.stderr?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line && !line.includes("Redistribute latency")) {
        logger.debug(`GStreamer: ${line}`);
        stderrOutput += line + "\n";
      }
    });

    gstProcess.on("close", (code) => {
      if (code !== 0) {
        logger.warning(`GStreamer exited with code ${code}: ${stderrOutput.trim() || "(no error output)"}`);
      }
      gstProcess = null;
      eventEmitter.emit("exit", code);
    });

    gstProcess.on("error", (err) => {
      logger.error(`GStreamer spawn error: ${err.message}`);
      eventEmitter.emit("error", err);
    });

    logger.info(`Transcoder ready, RTP on 127.0.0.1:${port}`);
    eventEmitter.emit("ready");
  });

  return {
    eventEmitter,
    writeJpeg: (jpeg: Buffer) => {
      if (!gstProcess?.stdin || gstProcess.stdin.destroyed) return;

      if (stdinBackpressure) {
        droppedFrames++;
        if (droppedFrames % 30 === 1) {
          logger.warning(`GStreamer stdin backpressure — dropped ${droppedFrames} frames`);
        }
        return;
      }

      const ok = gstProcess.stdin.write(jpeg);
      if (!ok) {
        stdinBackpressure = true;
        droppedFrames = 0;
        gstProcess.stdin.once("drain", () => {
          stdinBackpressure = false;
          logger.debug("GStreamer stdin drained, resuming frame intake");
        });
      }
    },
    close: () => {
      if (gstProcess) {
        gstProcess.stdin?.end();
        gstProcess.kill("SIGTERM");
        gstProcess = null;
      }
      try {
        udpSocket.close();
      } catch (_) {}
    },
    getSps: () => sps,
    getPps: () => pps,
  };
}
