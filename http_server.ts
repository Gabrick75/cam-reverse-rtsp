import { RemoteInfo } from "dgram";
import http from "node:http";

import { logger } from "./logger.js";
import { config } from "./settings.js";
import { discoverDevices } from "./discovery.js";
import { DevSerial } from "./impl.js";
import { Handlers, makeSession, Session, startVideoStream } from "./session.js";
import { addExifToJpeg, createExifOrientation } from "./exif.js";

// @ts-expect-error TS2307
import favicon from "./cam.ico.gz";
// @ts-expect-error TS2307
import html_template from "./asd.html";

const BOUNDARY = "a very good boundary line";
const responses: Record<string, http.ServerResponse[]> = {};
const audioResponses: Record<string, http.ServerResponse[]> = {};
const sessions: Record<string, Session> = {};

// https://sirv.com/help/articles/rotate-photos-to-be-upright/
const oMap = [1, 8, 3, 6];
const oMapMirror = [2, 7, 4, 5];
const orientations = [1, 2, 3, 4, 5, 6, 7, 8].reduce((acc, cur) => {
  return { [cur]: createExifOrientation(cur), ...acc };
}, {});

// Reads the mapping of serial numbers to camera names from the text file.

// Returns the camera name (custom name, if it exists, otherwise its ID).
const cameraName = (id: string): string => config.cameras[id].alias || id;

// The HTTP server.
export const serveHttp = (port: number) => {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/ui/")) {
      let devId = req.url.split("/")[2];
      let s = sessions[devId];
      if (s === undefined) {
        res.writeHead(400);
        res.end("invalid ID");
        return;
      }
      if (!s.connected) {
        res.writeHead(400);
        res.end("Nothing online");
        return;
      }
      const ui = html_template
        .toString()
        .replace(/\${id}/g, devId)
        .replace(/\${name}/g, cameraName(devId))
        .replace(/\${audio}/g, config.cameras[devId].audio ? "true" : "false");
      res.end(ui);
      return;
    }
    if (req.url.startsWith("/audio/")) {
      let devId = req.url.split("/")[2];
      let s = sessions[devId];
      if (s === undefined) {
        res.writeHead(400);
        res.end("invalid ID");
        return;
      }
      if (!s.connected) {
        res.writeHead(400);
        res.end("Nothing online");
        return;
      }
      res.setHeader("Content-Type", `text/event-stream`);
      audioResponses[devId].push(res);
      logger.info(`Audio stream requested for camera ${devId}`);
      return;
    }

    if (req.url.startsWith("/favicon.ico")) {
      res.setHeader("Content-Type", "image/x-icon");
      res.setHeader("Content-Encoding", "gzip");
      res.end(Buffer.from(favicon));
      return;
    }

    if (req.url.startsWith("/rotate/")) {
      let devId = req.url.split("/")[2];
      let curPos = config.cameras[devId]?.rotate || 0;
      let nextPos = (curPos + 1) % 4;
      logger.debug(`Rotating ${devId} to ${nextPos}`);
      config.cameras[devId].rotate = nextPos;
      res.writeHead(204);
      res.end();
      return;
    } else if (req.url.startsWith("/mirror/")) {
      let devId = req.url.split("/")[2];
      logger.debug(`Mirroring ${devId}`);
      config.cameras[devId].mirror = !config.cameras[devId].mirror;
      res.writeHead(204);
      res.end();
      return;
    } else if (req.url.startsWith("/camera/")) {
      let devId = req.url.split("/")[2];
      logger.info(`Video stream requested for camera ${devId}`);
      let s = sessions[devId];

      if (s === undefined) {
        res.writeHead(400);
        res.end(`Camera ${devId} not discovered`);
        return;
      }
      if (!s.connected) {
        res.writeHead(400);
        res.end(`Camera ${devId} offline`);
        return;
      }

      res.setHeader("Content-Type", `multipart/x-mixed-replace; boundary="${BOUNDARY}"`);
      responses[devId].push(res);
      res.on("close", () => {
        responses[devId] = responses[devId].filter((r) => r !== res);
        logger.info(`Video stream closed for camera ${devId}`);
      });
    } else {
      const cameraCards = Object.keys(sessions)
        .map((id) => {
          const s = sessions[id];
          const cls = s.connected ? "online" : "offline";
          const label = s.connected ? "Online" : "Offline";
          return `<div class="camera-card" data-name="${cameraName(id).toLowerCase()}" data-id="${id.toLowerCase()}">
            <div class="camera-card-header">
              <h3>${cameraName(id)}</h3>
              <span class="status-dot ${cls}">${label}</span>
            </div>
            <a href="/ui/${id}" class="stream-link" title="Open ${cameraName(id)} UI">
              <img src="/camera/${id}" alt="Live feed from ${cameraName(id)}" loading="lazy">
            </a>
            <div class="camera-card-actions">
              <a href="/ui/${id}" class="btn">Open Camera</a>
            </div>
          </div>`;
        })
        .join("");
      res.end(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="shortcut icon" href="/favicon.ico">
<title>All Cameras - Cam Reverse RTSP</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg-primary:#0d1117;--bg-secondary:#161b22;--bg-card:#1c2128;--border:#30363d;--text-primary:#e6edf3;--text-secondary:#8b949e;--accent:#58a6ff;--success:#3fb950;--danger:#f85149;--warning:#d29922;--radius:8px;--shadow:0 1px 3px rgba(0,0,0,.3),0 1px 2px rgba(0,0,0,.2)}
[data-theme="light"]{--bg-primary:#ffffff;--bg-secondary:#f6f8fa;--bg-card:#ffffff;--border:#d0d7de;--text-primary:#1f2328;--text-secondary:#656d76;--accent:#0969da;--accent-hover:#0550ae;--success:#1a7f37;--danger:#cf222e;--warning:#9a6700;--shadow:0 1px 3px rgba(0,0,0,.08),0 1px 2px rgba(0,0,0,.06)}
html{font-size:16px;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif;background:var(--bg-primary);color:var(--text-primary);min-height:100vh;display:flex;flex-direction:column}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}

/* Header */
header{background:var(--bg-secondary);border-bottom:1px solid var(--border);padding:1rem 1.5rem;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.75rem}
.header-left{display:flex;align-items:center;gap:1rem}
header h1{font-size:1.25rem;font-weight:600;letter-spacing:-.02em}
.server-status{font-size:.75rem;color:var(--text-secondary);padding:.25rem .6rem;border:1px solid var(--border);border-radius:20px;display:inline-flex;align-items:center;gap:.35rem}
.server-status::before{content:'';display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--success);animation:pulse 2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.header-right{display:flex;align-items:center;gap:.5rem}
.theme-toggle{font-family:inherit;font-size:1rem;background:transparent;border:1px solid var(--border);border-radius:6px;color:var(--text-secondary);cursor:pointer;padding:.3rem .5rem;line-height:1;transition:all .2s ease}
.theme-toggle:hover{color:var(--accent);border-color:var(--accent);background:rgba(88,166,255,.1)}
.github-link{color:var(--text-secondary);font-size:.875rem;font-weight:500;padding:.4rem .75rem;border-radius:6px;transition:all .2s ease}
.github-link:hover{color:var(--accent);background:rgba(88,166,255,.1);text-decoration:none}

/* Dashboard header */
.dashboard-header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.75rem;padding:1.5rem 1.5rem 0}
.dashboard-header-left{display:flex;align-items:center;gap:.75rem}
.dashboard-header-left h2{font-size:1.5rem;font-weight:600}
.cam-count{font-size:.875rem;color:var(--text-secondary);background:rgba(139,148,158,.1);padding:.25rem .6rem;border-radius:20px}
.search-box{font-family:inherit;font-size:.875rem;padding:.45rem .75rem;border:1px solid var(--border);border-radius:6px;background:var(--bg-primary);color:var(--text-primary);outline:none;transition:all .2s ease;min-width:200px}
.search-box:focus{border-color:var(--accent);box-shadow:0 0 0 2px rgba(88,166,255,.2)}
.search-box::placeholder{color:var(--text-secondary)}

/* Camera grid */
.camera-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:1.25rem;padding:1.5rem}
.camera-card{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);overflow:hidden;transition:border-color .2s ease,transform .2s ease}
.camera-card:hover{border-color:var(--text-secondary);transform:translateY(-2px)}
.camera-card-header{display:flex;align-items:center;justify-content:space-between;padding:.85rem 1rem;border-bottom:1px solid var(--border)}
.camera-card-header h3{font-size:.95rem;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.status-dot{font-size:.7rem;font-weight:500;padding:.15rem .5rem;border-radius:20px;text-transform:uppercase;letter-spacing:.04em;display:inline-flex;align-items:center;gap:.3rem;flex-shrink:0}
.status-dot.online{background:rgba(63,185,80,.15);color:var(--success);border:1px solid rgba(63,185,80,.3)}
.status-dot.offline{background:rgba(248,81,73,.15);color:var(--danger);border:1px solid rgba(248,81,73,.3)}
.status-dot::before{content:'';display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor}
.stream-link{display:block;line-height:0;background:#000}
.stream-link img{display:block;width:100%;height:auto;aspect-ratio:4/3;object-fit:cover;transition:opacity .3s ease}
.stream-link img:hover{opacity:.85}
.camera-card-actions{padding:.75rem 1rem;border-top:1px solid var(--border)}
.btn{display:block;text-align:center;font-size:.875rem;font-weight:500;padding:.5rem;border:1px solid var(--border);border-radius:6px;background:#21262d;color:var(--text-primary);transition:all .2s ease;cursor:pointer}
[data-theme="light"] .btn{background:#f6f8fa}
.btn:hover{background:#30363d;border-color:var(--text-secondary);text-decoration:none}
[data-theme="light"] .btn:hover{background:#eaeef2}

/* Empty state */
.empty-state{grid-column:1/-1;text-align:center;padding:3rem 1rem;color:var(--text-secondary)}
.empty-state p{font-size:1rem;margin-top:.5rem}

/* Footer */
footer{text-align:center;padding:1rem 1.5rem;font-size:.75rem;color:var(--text-secondary);border-top:1px solid var(--border);background:var(--bg-secondary);margin-top:auto}
footer a:hover{text-decoration:underline}

/* Responsive */
@media(max-width:768px){header{padding:.75rem 1rem}header h1{font-size:1rem}.dashboard-header{padding:1rem 1rem 0}.dashboard-header-left h2{font-size:1.25rem}.search-box{min-width:150px;width:100%}.camera-grid{padding:1rem;gap:1rem;grid-template-columns:1fr}}
@media(max-width:480px){.status-dot{font-size:.65rem}.search-box{min-width:0}}
</style>
</head>
<body>
<header>
  <div class="header-left">
    <h1>Cam Reverse RTSP</h1>
    <span class="server-status">Active</span>
  </div>
  <div class="header-right">
    <button class="theme-toggle" onclick="toggleTheme()" title="Toggle theme">&#x263E;</button>
    <a href="https://github.com/DavidVentura/cam-reverse" class="github-link" target="_blank" rel="noopener">GitHub</a>
  </div>
</header>
<div class="dashboard-header">
  <div class="dashboard-header-left">
    <h2>Cameras</h2>
    <span class="cam-count">${Object.keys(sessions).length} device(s)</span>
  </div>
  <input type="text" class="search-box" id="searchInput" placeholder="Search cameras..." oninput="filterCameras()">
</div>
<div class="camera-grid" id="cameraGrid">
  ${cameraCards || '<div class="empty-state"><h3>No cameras discovered</h3><p>Waiting for devices to appear on the network...</p></div>'}
</div>
<footer>
  <a href="https://github.com/DavidVentura/cam-reverse">Cam Reverse RTSP</a> &middot; Open source camera streaming
</footer>
<script>
(function() {
  var saved = localStorage.getItem('theme');
  if (saved === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
    var btn = document.querySelector('.theme-toggle');
    if (btn) btn.textContent = '\\u2600';
  }
})();
function toggleTheme() {
  var html = document.documentElement;
  var isDark = html.getAttribute('data-theme') !== 'light';
  html.setAttribute('data-theme', isDark ? 'light' : 'dark');
  localStorage.setItem('theme', isDark ? 'light' : 'dark');
  var btn = document.querySelector('.theme-toggle');
  if (btn) btn.textContent = isDark ? '\\u2600' : '\\u263E';
}
function filterCameras() {
  var q = document.getElementById('searchInput').value.toLowerCase();
  var cards = document.querySelectorAll('.camera-card');
  var visible = 0;
  for (var i = 0; i < cards.length; i++) {
    var card = cards[i];
    var name = (card.getAttribute('data-name') || '') + ' ' + (card.getAttribute('data-id') || '');
    var match = name.indexOf(q) !== -1;
    card.style.display = match ? '' : 'none';
    if (match) visible++;
  }
}
</script>
</body>
</html>`);
    }
  });

  let devEv = discoverDevices(config.discovery_ips);

  const startSession = (s: Session) => {
    startVideoStream(s);
    logger.info(`Camera ${s.devName} is now ready to stream`);
  };

  devEv.on("discover", (rinfo: RemoteInfo, dev: DevSerial) => {
    if (dev.devId in sessions) {
      logger.info(`Camera ${dev.devId} at ${rinfo.address} already discovered, ignoring`);
      return;
    }

    logger.info(`Discovered camera ${dev.devId} at ${rinfo.address}`);
    responses[dev.devId] = [];
    audioResponses[dev.devId] = [];
    const s = makeSession(Handlers, dev, rinfo, startSession, 5000);
    sessions[dev.devId] = s;
    config.cameras[dev.devId] = { rotate: 0, mirror: false, audio: true, ...(config.cameras[dev.devId] || {}) };

    s.eventEmitter.on("frame", () => {
      // Add an EXIF header to indicate if the image should be rotated or mirrored
      let orientation = config.cameras[dev.devId].rotate;
      orientation = config.cameras[dev.devId].mirror ? oMapMirror[orientation] : oMap[orientation];
      const exifSegment = orientations[orientation];
      const jpegHeader = addExifToJpeg(s.curImage[0], exifSegment);
      const assembled = Buffer.concat([jpegHeader, ...s.curImage.slice(1)]);
      const header = Buffer.from(
        `\r\n--${BOUNDARY}\r\nContent-Length: ${assembled.length}\r\nContent-Type: image/jpeg\r\n\r\n`,
      );
      responses[dev.devId].forEach((res) => {
        res.write(header);
        res.write(assembled);
      });
    });

    s.eventEmitter.on("disconnect", () => {
      logger.info(`Camera ${dev.devId} disconnected`);
      delete sessions[dev.devId];
    });
    if (config.cameras[dev.devId].audio) {
      s.eventEmitter.on("audio", ({ gap, data }) => {
        // ew, maybe WS?
        var b64encoded = Buffer.from(data).toString("base64");
        audioResponses[dev.devId].forEach((res) => {
          res.write("data: ");
          res.write(b64encoded);
          res.write("\n\n");
        });
      });
    }
  });

  logger.info(`Starting HTTP server on port ${port}`);
  server.listen(port);
};
