const http = require("http");
const https = require("https");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { spawn } = require("child_process");

let WebSocketServer = null, pty = null;
try { const wsLib = require("ws"); WebSocketServer = wsLib.WebSocketServer || wsLib.Server; } catch (e) {}
try { pty = require("node-pty"); } catch (e) { try { pty = require("node-pty-android-arm64"); } catch (e2) {} }

const PORT = Number(process.env.PORT || 8765);
const HOST = "127.0.0.1";
const ROOT = __dirname;
const HOME = process.env.HOME || "/data/data/com.termux/files/home";
const STORAGE = process.env.VSTERMUX_STORAGE || "/storage/emulated/0/LinuxTerminal";
const CONNECTION = path.join(STORAGE, "conectionsave");
const ASSETS = path.join(STORAGE, "assets");
const LANGDIR = path.join(STORAGE, "lang");
const BACKGROUND = path.join(ASSETS, "background.mp4");
const PARTICLE = path.join(ASSETS, "particle.png");

const BACKGROUND_URL = "https://raw.githubusercontent.com/joaoTYSM/termux-terminal/main/assets/background.mp4";
const PARTICLE_URL = "https://raw.githubusercontent.com/joaoTYSM/termux-terminal/main/assets/particle.png";

const SKIP_DIRS = new Set([".git", ".cache", "node_modules", ".npm", ".bun", ".gradle", ".cargo", ".config", ".cpan", ".ssh", ".termux", ".local", ".android", ".vscode-server", "usr", "bin", "lib", "include", "share", "storage", "proc", "sys", "dev"]);
const SKIP_FILES = new Set([".bash_history", ".bashrc", ".bash_profile", ".profile", ".zshrc", ".bash_logout", ".Xauthority", ".wget-hsts", ".python_history", ".lesshst", ".netrc", ".npmrc", ".pypirc"]);
const ENV_RE = /^\.env(\..*)?$/i;
const MIME = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".txt": "text/plain; charset=utf-8", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf"
};
const procs = new Map();
let envAccessEnabled = false;

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function safeRel(rel) {
  if (typeof rel !== "string") throw new Error("Invalid path");
  rel = rel.replaceAll("\\", "/");
  const normalized = path.posix.normalize("/" + rel).replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) return "";
  return normalized;
}

function inside(base, target) {
  return target === base || target.startsWith(base + path.sep);
}

function resolveIn(base, rel) {
  const b = path.resolve(base);
  const t = path.resolve(b, safeRel(rel));
  if (!inside(b, t)) throw new Error("Invalid path");
  return t;
}

const homePath = rel => resolveIn(HOME, rel);
const connectionPath = rel => resolveIn(CONNECTION, rel);
const mkdirp = p => fsp.mkdir(p, { recursive: true });
async function safeHomePath(rel) {
  const clean = safeRel(rel);
  const target = homePath(clean);
  let current = path.resolve(HOME);
  const root = await fsp.lstat(current);
  if (root.isSymbolicLink() || !root.isDirectory()) throw new Error("Invalid path");
  const parts = clean ? clean.split("/") : [];
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let st;
    try { st = await fsp.lstat(current); }
    catch (e) { if (e.code === "ENOENT") break; throw e; }
    if (st.isSymbolicLink() || (i < parts.length - 1 && !st.isDirectory())) throw new Error("Invalid path");
  }
  return target;
}

function allowedRequest(req) {
  const hosts = ["127.0.0.1:" + PORT, "localhost:" + PORT];
  if (!hosts.includes((req.headers.host || "").toLowerCase())) return false;
  const origin = req.headers.origin;
  if (origin && !hosts.some(h => origin === "http://" + h)) return false;
  return true;
}

function download(url, dest, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error("Too many redirects"));
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        return download(response.headers.location, dest, depth + 1).then(resolve, reject);
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error("HTTP " + response.statusCode));
      }
      const part = dest + ".part";
      const file = fs.createWriteStream(part);
      response.pipe(file);
      file.on("finish", () => file.close(() => fs.rename(part, dest, err => (err ? reject(err) : resolve()))));
      file.on("error", err => { fs.unlink(part, () => {}); reject(err); });
    }).on("error", reject);
  });
}

async function ensureAssets() {
  await mkdirp(ASSETS);
  if (!fs.existsSync(BACKGROUND)) { try { await download(BACKGROUND_URL, BACKGROUND); } catch (e) {} }
  if (!fs.existsSync(PARTICLE)) { try { await download(PARTICLE_URL, PARTICLE); } catch (e) {} }
}

async function ensureAsset(file, url) {
  if (fs.existsSync(file)) return;
  await mkdirp(path.dirname(file));
  try { await download(url, file); } catch (e) {}
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, r => {
      let d = "";
      r.setEncoding("utf8");
      r.on("data", c => { d += c; });
      r.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error("Translation failed")); } });
    }).on("error", reject);
  });
}

async function translateText(text, lang) {
  const url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=" + encodeURIComponent(lang) + "&dt=t&q=" + encodeURIComponent(text);
  const j = await httpsGetJson(url);
  return j[0].map(s => s[0]).join("");
}

function killProc(child) {
  try { process.kill(-child.pid, "SIGINT"); } catch (e) { try { child.kill("SIGINT"); } catch (e2) {} }
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, "SIGKILL"); } catch (e) { try { child.kill("SIGKILL"); } catch (e2) {} }
    }
  }, 2500);
}

function serveFile(req, res, file, mime, cache) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end(); }
    const headers = { "Content-Type": mime, "Accept-Ranges": "bytes", "Cache-Control": cache || "no-cache" };
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (m && !m[1] && m[2]) { start = Math.max(0, st.size - parseInt(m[2], 10)); end = st.size - 1; }
      end = Math.min(end, st.size - 1);
      if (start > end || start >= st.size) { res.writeHead(416, { "Content-Range": "bytes */" + st.size }); return res.end(); }
      res.writeHead(206, { ...headers, "Content-Range": "bytes " + start + "-" + end + "/" + st.size, "Content-Length": end - start + 1 });
      fs.createReadStream(file, { start, end }).on("error", () => res.destroy()).pipe(res);
    } else {
      res.writeHead(200, { ...headers, "Content-Length": st.size });
      fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
    }
  });
}

async function dirSize(root, showEnv) {
  let total = 0, budget = 4000, truncated = false;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      if (budget-- <= 0) { truncated = true; return { total, truncated }; }
      const full = path.join(dir, e.name);
      if (SKIP_FILES.has(e.name) || (!showEnv && ENV_RE.test(e.name))) continue;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && (showEnv || !ENV_RE.test(e.name))) stack.push(full); }
      else { try { total += (await fsp.stat(full)).size; } catch (e2) {} }
    }
  }
  return { total, truncated };
}

function visible(e, showEnv) {
  if ((e.isSymbolicLink && e.isSymbolicLink()) || SKIP_DIRS.has(e.name) || SKIP_FILES.has(e.name)) return false;
  if (!showEnv && ENV_RE.test(e.name)) return false;
  return true;
}

function isEnvPath(rel) {
  return String(rel || "").replaceAll("\\", "/").split("/").some(part => ENV_RE.test(part));
}

function assertEnvAccess(rel) {
  if (isEnvPath(rel) && !envAccessEnabled) throw new Error(".env access is disabled");
}

const HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no">
<title>VStermu-x</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.21/codemirror.min.css">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.21/theme/dracula.min.css">
<link id="cm-light-theme" rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.21/theme/eclipse.min.css" disabled>
<link rel="stylesheet" href="/vendor/xterm.css">
<style>
:root{--accent:#d946ef;--glass-bg:rgba(20,20,25,.66);--glass-blur:16px;--glass-border:rgba(255,255,255,.12);--window-radius:14px;--opacity:1;--font-family:"Courier New",monospace;--motion-duration:240ms;--surface:#101117;--text:#f2f3f7}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{width:100%;height:100%;overflow:hidden;background:#000;overscroll-behavior:none}
body{color:var(--text);font-family:var(--font-family)}
.bg{position:fixed;inset:0;z-index:-3;background:#000}
.bg video{width:100%;height:100%;object-fit:cover;opacity:.35}
.bg .bgimg{position:absolute;inset:0;background-size:cover;background-position:center;opacity:.35}
#particle-canvas{position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:0}
#app{position:fixed;left:0;top:0;width:100%;height:100%;display:flex;flex-direction:column;overflow:hidden;z-index:1}
#terminal-layer{flex:1;min-height:0;padding:12px 15px;overflow-y:auto;font-size:14px;display:flex;flex-direction:column;-webkit-overflow-scrolling:touch}
#output{flex-shrink:0}
.term-line{white-space:pre-wrap;word-break:break-word;line-height:1.5;color:#e5e7eb}
.term-prompt{color:var(--accent);font-weight:bold}
.term-cmd{color:#fff}
.term-dim{color:#9ca3af}
#input-container{display:flex;align-items:center;margin-top:4px;flex-shrink:0}
#input-prompt{color:var(--accent);margin-right:8px;font-weight:bold;white-space:pre}
#cmd{flex:1;min-width:0;background:transparent;border:none;color:#fff;font-family:inherit;font-size:inherit;outline:none}
#keys{position:relative;z-index:50;display:grid;grid-template-columns:repeat(7,1fr);gap:4px;padding:5px max(5px,env(safe-area-inset-right)) max(5px,env(safe-area-inset-bottom)) max(5px,env(safe-area-inset-left));background:rgba(0,0,0,.82);border-top:1px solid var(--glass-border);flex-shrink:0;touch-action:manipulation;user-select:none;-webkit-user-select:none;backdrop-filter:blur(14px)}
.t-key{padding:9px 0;background:rgba(255,255,255,.07);color:#ddd;border:1px solid var(--glass-border);border-radius:6px;text-align:center;font-size:12px;font-weight:bold}
.t-key:active,.t-key.on{background:var(--accent);color:#000}
.desktop-actions{position:absolute;top:max(8px,env(safe-area-inset-top));right:10px;z-index:80;display:flex;gap:7px}
.desktop-actions button{width:38px;height:38px;border:1px solid var(--glass-border);border-radius:12px;background:var(--glass-bg);backdrop-filter:blur(var(--glass-blur));color:var(--text);font-size:15px}
#pty-screen{display:none;position:absolute;inset:0 0 66px;z-index:40;background:#08090d;padding:9px 8px 5px}
#pty-screen.active{display:block}
#pty-terminal{width:100%;height:100%}
#pty-terminal .xterm{height:100%;padding:4px}
@keyframes genie-out{0%{transform:scale(1) translateY(0);opacity:var(--opacity)}35%{transform:scale(.85,1.08) translateY(4vh);opacity:.85}100%{transform:scale(.04,2.2) translateY(110vh);opacity:0}}
.genie-suck{animation:genie-out .55s cubic-bezier(.6,-.28,.735,.045) forwards!important;pointer-events:none}
#file-manager{position:absolute;left:0;top:0;width:80%;height:75%;background:var(--glass-bg);backdrop-filter:blur(var(--glass-blur));-webkit-backdrop-filter:blur(var(--glass-blur));border:1px solid var(--glass-border);border-radius:var(--window-radius);z-index:100;display:none;flex-direction:column;box-shadow:0 20px 40px -12px rgba(0,0,0,.7);overflow:hidden;opacity:var(--opacity);transform-origin:0 0;font-family:sans-serif;transition:box-shadow var(--motion-duration),border-radius var(--motion-duration)}
#file-manager.minimized .btn-min,#file-manager.minimized .btn-max,#settings-window.minimized .btn-min,#settings-window.minimized .btn-max{display:none}
#file-manager.jelly-on{will-change:transform}
#file-manager.minimized{height:42px!important}
#file-manager.minimized .fm-body,#file-manager.minimized #resize-handle{display:none}
#file-manager.maximized{left:0!important;top:0!important;width:100%!important;height:100%!important;border-radius:0}
.fm-header{display:flex;justify-content:space-between;align-items:center;padding:0 12px;height:42px;flex-shrink:0;background:rgba(0,0,0,.25);border-bottom:1px solid var(--glass-border);cursor:move;user-select:none;-webkit-user-select:none;touch-action:none}
.fm-title{font-weight:bold;font-size:14px;white-space:nowrap}
.fm-title i{color:var(--accent);margin-right:6px}
.window-controls{display:flex;gap:6px}
.window-controls button{background:transparent;border:none;font-size:14px;width:32px;height:32px;color:#d1d5db;cursor:pointer;border-radius:8px}
.window-controls .btn-min{color:#fbbf24}
.window-controls .btn-max{color:#4ade80}
.window-controls .btn-close{color:#f87171}
.fm-body{display:flex;flex:1;min-height:0;position:relative}
.fm-sidebar{width:210px;min-width:120px;background:rgba(0,0,0,.18);border-right:1px solid var(--glass-border);display:flex;flex-direction:column;min-height:0}
.fm-toolbar{padding:8px;display:flex;gap:6px;border-bottom:1px solid var(--glass-border)}
.fm-btn{background:rgba(255,255,255,.08);border:1px solid var(--glass-border);color:#fff;border-radius:6px;padding:8px 10px;flex:1;cursor:pointer;font-size:12px}
.fm-btn:active{background:var(--accent);color:#000;border-color:var(--accent)}
#fm-path{padding:6px 10px;font-size:11px;color:#9ca3af;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-bottom:1px solid var(--glass-border)}
.fm-tree{flex:1;overflow-y:auto;padding:6px;font-size:13px;min-height:0;touch-action:pan-y;overscroll-behavior:contain}
.tree-item{padding:8px;cursor:pointer;display:flex;align-items:center;gap:8px;border-radius:6px;color:#d1d5db}
.tree-item .nm{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tree-item.sel{background:rgba(255,255,255,.14);box-shadow:inset 2px 0 0 var(--accent);color:#fff}
.row-btn{background:rgba(255,255,255,.1);border:none;color:#fff;border-radius:5px;width:26px;height:26px;font-size:11px;flex-shrink:0}
.row-btn:active{background:var(--accent);color:#000}
.fm-main{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0}
.fm-tabs{display:flex;align-items:center;background:rgba(0,0,0,.22);border-bottom:1px solid var(--glass-border);flex-shrink:0;height:40px}
#tabs{flex:1;display:flex;overflow-x:auto;min-width:0;height:100%;align-items:flex-end;scrollbar-width:none;touch-action:pan-x}
#tabs::-webkit-scrollbar{display:none}
.tab{padding:0 8px 0 12px;height:32px;display:flex;align-items:center;gap:6px;flex-shrink:0;background:rgba(255,255,255,.04);border-radius:8px 8px 0 0;margin-left:3px;font-size:12px;border:1px solid var(--glass-border);border-bottom:none;white-space:nowrap;max-width:170px;cursor:pointer}
.tab .nm{overflow:hidden;text-overflow:ellipsis}
.tab.active{background:rgba(255,255,255,.12);color:var(--accent);box-shadow:inset 0 2px 0 var(--accent)}
.tab.temp .nm{font-style:italic}
.tab .x{background:none;border:none;color:inherit;opacity:.6;width:20px;height:20px;font-size:11px}
.editor-actions{display:flex;gap:4px;padding:0 6px;flex-shrink:0}
.action-btn{background:rgba(20,20,20,.7);border:1px solid var(--glass-border);color:#fff;padding:6px 10px;border-radius:6px;font-size:12px;cursor:pointer}
.action-btn:active{background:var(--accent);color:#000}
.editor-wrapper{flex:1;position:relative;min-height:0;background:rgba(0,0,0,.4)}
.CodeMirror{position:absolute!important;inset:0;height:auto!important;background:transparent!important;font-family:var(--font-family);font-size:14px}
.CodeMirror-scroll{touch-action:pan-x pan-y;overscroll-behavior:contain}
.CodeMirror-gutters{background:rgba(0,0,0,.3)!important;border-right:1px solid var(--glass-border)!important}
#live-frame{display:none;position:absolute;inset:0;width:100%;height:100%;border:none;background:#fff}
#info-panel{display:none;position:absolute;inset:0;overflow-y:auto;padding:16px;touch-action:pan-y;overscroll-behavior:contain}
#empty-panel{display:none;position:absolute;inset:0;align-items:center;justify-content:center;color:#6b7280;font-size:14px}
.info-head{display:flex;align-items:center;gap:10px;font-size:20px;font-weight:bold;margin-bottom:14px}
.info-grid{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;font-size:13px;margin-bottom:14px}
.info-grid .k{color:#9ca3af}
.info-grid .v{word-break:break-all}
.info-btns{display:flex;gap:8px;margin-bottom:14px}
.info-list{border-top:1px solid var(--glass-border);padding-top:8px}
.info-empty{color:#6b7280;font-size:13px;padding:8px}
#status{display:flex;justify-content:space-between;gap:10px;padding:4px 10px;font-size:11px;color:#9ca3af;background:rgba(0,0,0,.3);border-top:1px solid var(--glass-border);flex-shrink:0;white-space:nowrap;overflow:hidden}
#st-path{overflow:hidden;text-overflow:ellipsis}
#settings-window{display:none;position:absolute;left:50%;top:8%;transform:translateX(-50%);width:min(560px,96vw);height:min(720px,84vh);z-index:120;background:var(--glass-bg);backdrop-filter:blur(var(--glass-blur));-webkit-backdrop-filter:blur(var(--glass-blur));border:1px solid var(--glass-border);border-radius:var(--window-radius);box-shadow:0 24px 70px rgba(0,0,0,.55);overflow:hidden;font:13px/1.45 system-ui,sans-serif;opacity:var(--opacity);flex-direction:column}
#settings-window.maximized{left:0;top:0;transform:none;width:100%;height:100%;border-radius:0}
#settings-window.minimized{height:42px}
#settings-window.minimized .settings-content,#settings-window.minimized #settings-resize{display:none}
.settings-content{overflow-y:auto;overscroll-behavior:contain;touch-action:pan-y;padding:14px 18px 18px;flex:1;min-height:0}
.settings-section{margin:4px 0 14px}
.settings-section h3{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);margin:9px 0 3px}
.set-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--glass-border)}
.set-row label,.set-row .set-label{flex:1;min-width:0}
.set-row input[type=text],.set-row input[type=url],.set-row select{background:rgba(255,255,255,.09);border:1px solid var(--glass-border);color:var(--text);border-radius:9px;padding:8px 10px;min-width:120px;max-width:65%}
.set-row select option{background:#171820;color:#fff}
.set-row input[type=checkbox]{appearance:none;width:42px;height:24px;flex:0 0 42px;border-radius:20px;background:#4b4d58;border:1px solid var(--glass-border);position:relative;transition:background var(--motion-duration)}
.set-row input[type=checkbox]::after{content:"";position:absolute;width:18px;height:18px;border-radius:50%;left:2px;top:2px;background:#fff;transition:transform var(--motion-duration)}
.set-row input[type=checkbox]:checked{background:var(--accent)}
.set-row input[type=checkbox]:checked::after{transform:translateX(18px);background:#fff}
.set-row input[type=range]{width:min(180px,42%);accent-color:var(--accent)}
.set-row input[type=color]{width:52px;height:38px;border:1px solid var(--glass-border);background:var(--surface);border-radius:9px;padding:3px}
.set-row input[type=file]{width:min(230px,60%);font-size:11px}
.settings-actions{display:flex;gap:8px;flex-wrap:wrap}
.settings-actions .fm-btn{flex:1}
#new-item-menu{display:none;position:absolute;top:100%;left:0;z-index:30;min-width:130px;padding:5px;background:var(--surface);border:1px solid var(--glass-border);border-radius:9px;box-shadow:0 10px 30px rgba(0,0,0,.4)}
#new-item-menu.open{display:grid}
#new-item-menu button{border:0;background:transparent;color:var(--text);text-align:left;padding:9px;border-radius:6px}
#new-item-menu button:active{background:var(--accent);color:#111}
.new-menu-wrap{position:relative;flex:1}
.new-menu-wrap>.fm-btn{width:100%}
#settings-resize{position:absolute;right:0;bottom:0;width:24px;height:24px;touch-action:none;cursor:nwse-resize;background:linear-gradient(135deg,transparent 55%,rgba(255,255,255,.45) 56%,transparent 62%,transparent 72%,rgba(255,255,255,.45) 73%,transparent 79%)}
.style-clay #file-manager,.style-clay #settings-window{box-shadow:inset 3px 3px 8px rgba(255,255,255,.08),inset -4px -5px 10px rgba(0,0,0,.35),0 18px 35px rgba(0,0,0,.35)}
.style-neumorphic #file-manager,.style-neumorphic #settings-window{border-color:transparent;box-shadow:8px 8px 22px rgba(0,0,0,.55),-5px -5px 18px rgba(255,255,255,.055)}
.style-flat #file-manager,.style-flat #settings-window{backdrop-filter:none;-webkit-backdrop-filter:none;box-shadow:0 12px 30px rgba(0,0,0,.28);border-radius:8px}
.theme-light{--surface:#f5f6fa;--text:#171923;--glass-bg:rgba(250,251,255,.9);--glass-border:rgba(32,35,48,.15)}
.theme-light #file-manager,.theme-light #settings-window{color:#171923}
.theme-light .fm-header,.theme-light .fm-tabs,.theme-light .fm-sidebar{background:rgba(255,255,255,.66)}
.theme-light .fm-btn,.theme-light .action-btn,.theme-light .row-btn{color:#20222c;background:rgba(25,30,45,.08)}
.theme-light .tab{color:#262833}
.theme-light body{background:#f5f6fa;color:#171923}
.theme-light #terminal-layer{color:#292a32}
.theme-light .term-line{color:#292a32}
.theme-light .term-cmd,.theme-light #cmd{color:#171923}
.theme-light #input-prompt{color:var(--accent)}
.theme-light #keys{background:rgba(250,251,255,.92)}
.theme-light .t-key{color:#2a2b34;background:rgba(20,25,40,.07)}
.theme-light .tree-item{color:#3a3b44}
.theme-light .tree-item.sel{color:#171923;background:rgba(20,20,35,.1)}
.theme-light .CodeMirror{color:#222!important}
.theme-light .CodeMirror-gutters{background:rgba(238,240,245,.95)!important}
.theme-light #status{background:rgba(255,255,255,.72);color:#5a5d69}
.motion-off *, .motion-off *::before, .motion-off *::after{animation-duration:.01ms!important;transition-duration:.01ms!important;scroll-behavior:auto!important}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important;scroll-behavior:auto!important}}
#resize-handle{position:absolute;right:0;bottom:0;width:28px;height:28px;cursor:nwse-resize;touch-action:none;z-index:30;background:linear-gradient(135deg,transparent 55%,rgba(255,255,255,.35) 56%,transparent 62%,transparent 72%,rgba(255,255,255,.35) 73%,transparent 79%)}
#dialog{display:none;position:fixed;inset:0;z-index:400;background:rgba(0,0,0,.55);align-items:center;justify-content:center;font-family:sans-serif}
.dlg-box{background:#1c1c24;border:1px solid var(--glass-border);border-radius:12px;padding:18px;width:min(340px,90vw)}
#dlg-title{font-size:14px;margin-bottom:12px;word-break:break-word}
#dlg-input{width:100%;background:rgba(255,255,255,.08);border:1px solid var(--glass-border);color:#fff;border-radius:6px;padding:9px;font-size:14px;margin-bottom:12px;outline:none}
.dlg-btns{display:flex;gap:8px}
#toast{position:fixed;left:50%;bottom:90px;transform:translateX(-50%);background:rgba(30,30,38,.95);border:1px solid var(--glass-border);padding:9px 16px;border-radius:20px;font:13px sans-serif;z-index:500;display:none;max-width:90vw}
@media(max-width:600px){.fm-sidebar{width:130px}#settings-window{left:2vw;top:4vh;transform:none;width:96vw;height:88vh}.fm-title{font-size:12px}.editor-actions{gap:2px;padding:0 3px}.action-btn{padding:6px 7px}}
</style>
</head>
<body>
<div class="bg"><video id="bg-vid" autoplay muted loop playsinline preload="auto"></video><div class="bgimg" id="bg-img"></div></div>
<canvas id="particle-canvas" aria-hidden="true"></canvas>
<div id="app">
  <div class="desktop-actions"><button id="btn-settings-launch" title="Configurações"><i class="fa-solid fa-gear"></i></button><button id="btn-fm-launch" title="Gerenciador de arquivos"><i class="fa-solid fa-folder-open"></i></button></div>
  <div id="terminal-layer">
    <div id="output"></div>
    <div id="input-container"><span id="input-prompt"></span><input type="text" id="cmd" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="send"></div>
  </div>
  <div id="keys"></div>
  <div id="pty-screen"><div id="pty-terminal"></div></div>
  <div id="file-manager">
    <div class="fm-header" id="fm-drag-handle">
      <span class="fm-title"><i class="fa-solid fa-code-branch"></i><span data-i18n="VStermu-x Explorer"></span></span>
      <div class="window-controls">
        <button id="btn-settings" data-i18n-title="Settings"><i class="fa-solid fa-gear"></i></button>
        <button class="btn-min" id="btn-min" data-i18n-title="Minimize"><i class="fa-solid fa-minus"></i></button>
        <button class="btn-max" id="btn-max" data-i18n-title="Maximize"><i class="fa-regular fa-square"></i></button>
        <button class="btn-close" id="btn-close" data-i18n-title="Close"><i class="fa-solid fa-xmark"></i></button>
      </div>
    </div>
    <div class="fm-body">
      <div class="fm-sidebar">
        <div class="fm-toolbar">
          <div class="new-menu-wrap"><button class="fm-btn" id="btn-new-item" data-i18n-title="Create new"><i class="fa-solid fa-plus"></i></button><div id="new-item-menu"><button id="btn-newfile" data-i18n="New file"></button><button id="btn-newfolder" data-i18n="New folder"></button></div></div>
        </div>
        <div id="fm-path"></div>
        <div class="fm-tree" id="tree-root"></div>
      </div>
      <div class="fm-main">
        <div class="fm-tabs">
          <div id="tabs"></div>
          <div class="editor-actions">
            <button class="action-btn" id="btn-live" data-i18n="Preview" style="display:none"></button>
            <button class="action-btn" id="btn-selall" data-i18n-title="Select all"><i class="fa-solid fa-i-cursor"></i></button>
            <button class="action-btn" id="btn-copy" data-i18n-title="Copy"><i class="fa-solid fa-copy"></i></button>
            <button class="action-btn" id="btn-download" data-i18n-title="Download"><i class="fa-solid fa-download"></i></button>
          </div>
        </div>
        <div class="editor-wrapper">
          <textarea id="editor"></textarea>
          <iframe id="live-frame" sandbox="allow-scripts"></iframe>
          <div id="info-panel"></div>
          <div id="empty-panel" data-i18n="No file open"></div>
        </div>
        <div id="status"><span id="st-path"></span><span><span id="st-msg"></span> <span id="st-pos"></span></span></div>
      </div>
    </div>
    <div id="resize-handle"></div>
  </div>
  <section id="settings-window">
    <div class="fm-header" id="settings-drag-handle"><span class="fm-title"><i class="fa-solid fa-gear"></i><span data-i18n="Settings"></span></span><div class="window-controls"><button class="btn-min" id="settings-min" title="Minimizar"><i class="fa-solid fa-minus"></i></button><button class="btn-max" id="settings-max" title="Maximizar"><i class="fa-regular fa-square"></i></button><button class="btn-close" id="settings-close" data-i18n-title="Close"><i class="fa-solid fa-xmark"></i></button></div></div>
    <div class="settings-content">
      <div class="settings-section"><h3 data-i18n="Security & visibility"></h3>
        <div class="set-row"><label for="set-env" data-i18n="Show .env files"></label><input type="checkbox" id="set-env"></div>
      </div>
      <div class="settings-section"><h3 data-i18n="Appearance"></h3>
        <div class="set-row"><label for="set-theme" data-i18n="Color mode"></label><select id="set-theme"><option value="dark" data-i18n="Dark"></option><option value="light" data-i18n="Light"></option></select></div>
        <div class="set-row"><label for="set-style" data-i18n="Window style"></label><select id="set-style"><option value="glassmorphism" data-i18n="Glassmorphism"></option><option value="clay" data-i18n="Claymorphism"></option><option value="neumorphic" data-i18n="Neumorphism"></option><option value="flat" data-i18n="Flat"></option></select></div>
        <div class="set-row"><label for="set-color" data-i18n="Accent color"></label><input type="color" id="set-color"></div>
        <div class="set-row"><label for="set-blur" data-i18n="Background blur"></label><input type="range" id="set-blur" min="0" max="30"></div>
        <div class="set-row"><label for="set-opacity" data-i18n="Window opacity"></label><input type="range" id="set-opacity" min="30" max="100"></div>
      </div>
      <div class="settings-section"><h3 data-i18n="Background & motion"></h3>
        <div class="set-row"><label for="set-bg-enabled" data-i18n="Enable background"></label><input type="checkbox" id="set-bg-enabled"></div>
        <div class="set-row"><label for="set-bg-url" data-i18n="Image or video URL"></label><input type="url" id="set-bg-url" placeholder="https://..."></div>
        <div class="set-row"><span class="set-label"></span><div class="settings-actions"><button class="fm-btn" id="set-bg-apply" data-i18n="Apply background"></button><button class="fm-btn" id="set-bg-default" data-i18n="Use default"></button></div></div>
        <div class="set-row"><label for="set-particles" data-i18n="Particles"></label><input type="checkbox" id="set-particles"></div>
        <div class="set-row"><label for="set-animations" data-i18n="Smooth animations"></label><input type="checkbox" id="set-animations"></div>
        <div class="set-row"><label for="set-jelly" data-i18n="Jelly distortion"></label><input type="checkbox" id="set-jelly"></div>
        <div class="set-row"><label for="set-motion" data-i18n="Animation speed"></label><input type="range" id="set-motion" min="60" max="500" step="10"></div>
      </div>
      <div class="settings-section"><h3 data-i18n="Typography"></h3>
        <div class="set-row"><label for="set-font-file" data-i18n="Import font"></label><input type="file" id="set-font-file" accept=".woff,.woff2,.ttf,.otf"></div>
        <div class="set-row"><label for="set-font-url" data-i18n="Google Fonts URL"></label><input type="url" id="set-font-url" placeholder="https://fonts.googleapis.com/..."></div>
        <div class="set-row"><button class="fm-btn" id="set-font-load" data-i18n="Load font URL"></button><button class="fm-btn" id="set-font-reset" data-i18n="Reset font"></button></div>
      </div>
      <div class="settings-section"><h3 data-i18n="Language"></h3>
        <div class="set-row"><label for="set-lang" data-i18n="Language code"></label><span><input type="text" id="set-lang"> <button class="fm-btn" id="set-lang-apply" data-i18n="Apply"></button></span></div>
      </div>
      <div class="settings-actions"><button class="fm-btn" id="set-reset" data-i18n="Reset interface"></button></div>
    </div>
    <div id="settings-resize"></div>
  </section>
</div>
<div id="dialog"><div class="dlg-box"><div id="dlg-title"></div><input id="dlg-input" type="text" autocomplete="off" spellcheck="false"><div class="dlg-btns"><button class="fm-btn" id="dlg-cancel" data-i18n="Cancel"></button><button class="fm-btn" id="dlg-ok" data-i18n="OK"></button></div></div></div>
<div id="toast"></div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.21/codemirror.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.21/mode/javascript/javascript.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.21/mode/xml/xml.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.21/mode/css/css.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.21/mode/htmlmixed/htmlmixed.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.21/mode/python/python.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.21/mode/clike/clike.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.21/mode/lua/lua.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.21/mode/shell/shell.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.21/mode/markdown/markdown.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.21/mode/yaml/yaml.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.21/mode/sql/sql.min.js"></script>
<script src="/vendor/xterm.js"></script>
<script src="/vendor/addon-fit.js"></script>

<script>
const $ = s => document.querySelector(s);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined) e.textContent = txt; return e; };
const icon = (cls, color) => { const i = el("i", cls); if (color) i.style.color = color; return i; };
const safeParse = (s, d) => { try { const v = JSON.parse(s); return v === null ? d : v; } catch (e) { return d; } };
const isEnvPath = p => String(p || "").replaceAll("\\", "/").split("/").some(part => /^\.env(\..*)?$/i.test(part));

const PT = {
  "VStermu-x Explorer": "Explorador VStermu-x", "Settings": "Configurações", "Minimize": "Minimizar", "Maximize": "Maximizar", "Close": "Fechar",
  "New file": "Novo arquivo", "New folder": "Nova pasta", "Create new": "Criar novo", "Preview": "Pré-visualizar", "Live": "Ao vivo", "Editor": "Editor", "Select all": "Selecionar tudo",
  "Copy": "Copiar", "Download": "Baixar", "Rename": "Renomear", "Delete": "Apagar", "Open folder": "Abrir pasta", "Cancel": "Cancelar",
  "OK": "OK", "File name:": "Nome do arquivo:", "Folder name:": "Nome da pasta:", "New name:": "Novo nome:", "Invalid name": "Nome inválido",
  "Delete this item?": "Apagar este item?", "Show .env files": "Mostrar arquivos .env", "Jelly effect": "Efeito geleia",
  "Accent color": "Cor de destaque", "Background blur": "Desfoque do vidro", "Window opacity": "Opacidade da janela", "Language": "Idioma",
  "Security & visibility": "Segurança e visibilidade", "Appearance": "Aparência", "Color mode": "Modo de cor", "Window style": "Estilo das janelas",
  "Dark": "Escuro", "Light": "Claro", "Glassmorphism": "Vidro fosco", "Claymorphism": "Claymorphism", "Neumorphism": "Neumorfismo", "Flat": "Plano",
  "Background & motion": "Fundo e movimento", "Enable background": "Ativar imagem/vídeo de fundo", "Image or video URL": "URL de imagem ou vídeo",
  "Apply background": "Aplicar fundo", "Use default": "Usar padrão", "Particles": "Partículas", "Smooth animations": "Animações suaves",
  "Jelly distortion": "Distorção gelatinosa", "Animation speed": "Duração das animações", "Typography": "Tipografia", "Import font": "Importar fonte",
  "Google Fonts URL": "URL do Google Fonts", "Load font URL": "Carregar fonte", "Reset font": "Restaurar fonte",
  "Language code": "Código do idioma", "Font file must be .woff/.woff2/.ttf/.otf and no larger than 3 MB.": "A fonte deve ser .woff/.woff2/.ttf/.otf e ter no máximo 3 MB.",
  "Enter a valid Google Fonts CSS URL.": "Informe uma URL CSS válida do Google Fonts.",
  "Background URL must use http(s).": "A URL do fundo precisa usar http(s).", "Interactive terminal needs dependencies.": "O terminal interativo precisa das dependências instaladas.",
  ".env access is disabled": "O acesso aos arquivos .env está desativado",
  "Apply": "Aplicar", "Reset interface": "Restaurar interface", "No file open": "Nenhum arquivo aberto", "Saving...": "Salvando...",
  "Saved": "Salvo", "Code copied.": "Código copiado.", "Downloading file...": "Baixando arquivo...", "Path": "Caminho", "Items": "Itens",
  "Files": "Arquivos", "Folders": "Pastas", "Size": "Tamanho", "Modified": "Modificado", "Empty folder": "Pasta vazia",
  "(truncated)": "(parcial)", "VStermu-x started.": "VStermu-x iniciado.",
  "Type 'help' for the command manual.": "Digite 'help' para o manual de comandos.", "Fullscreen on.": "Tela cheia ativada.",
  "Fullscreen off.": "Tela cheia desativada.", "File manager opened.": "Gerenciador de arquivos aberto.", "Interface reset.": "Interface restaurada.",
  "Font loaded.": "Fonte carregada.", "Font applied.": "Fonte aplicada.", "Font reset.": "Fonte restaurada.", "Setting saved: ": "Configuração salva: ",
  "Unknown value.": "Valor inválido.", "Unknown setting.": "Configuração desconhecida.", "System error: ": "Erro do sistema: ",
  "Translating...": "Traduzindo...", "Language changed.": "Idioma alterado.", "Translation failed, using English.": "Falha na tradução, usando inglês.",
  "Current language: ": "Idioma atual: ", "Directory not found.": "Pasta não encontrada.", "Usage: ": "Uso: ", "on": "ligado", "off": "desligado",
  "File too large": "Arquivo muito grande", "Binary file": "Arquivo binário", "Already exists": "Já existe", "Invalid path": "Caminho inválido",
  "Unknown language": "Idioma desconhecido", "Translation failed": "Falha na tradução",
  "--- COMMAND MANUAL ---": "--- MANUAL DE COMANDOS ---",
  "Open the graphical file manager / editor (. = current folder)": "Abre o gerenciador gráfico / editor (. = pasta atual)",
  "Open the separate settings window": "Abre a janela independente de configurações",
  "Toggle fullscreen": "Entra/sai da tela cheia", "Change directory (persistent, supports ~ and ..)": "Muda de pasta (persistente, aceita ~ e ..)",
  "Load a Google Fonts URL (font name detected automatically)": "Carrega uma URL do Google Fonts (nome detectado automaticamente)",
  "Set the font family name": "Define o nome da fonte", "Restore the default font": "Restaura a fonte padrão",
  "Change language (e.g. lang -y pt-br, es, fr, ja)": "Muda o idioma (ex: lang -y pt-br, es, fr, ja)",
  "Accent color (any CSS color)": "Cor principal (qualquer cor CSS)", "Background video/image URL, off, or default": "URL do vídeo/imagem de fundo, off ou default",
  "Glass blur level": "Nível de desfoque do vidro", "Window opacity from 0.1 to 1": "Opacidade da janela de 0.1 a 1",
  "Window corner radius": "Arredondamento das bordas", "Jelly window effect": "Efeito geleia nas janelas",
  "Show .env files in the explorer": "Mostra arquivos .env no explorador", "Restore the default design": "Restaura o design padrão",
  "Toggle background particles": "Ativa ou desativa partículas no fundo", "Toggle interface animations": "Ativa ou desativa as animações da interface",
  "Set the color theme": "Define o tema claro ou escuro", "Set the window style": "Define o estilo das janelas",
  "Show command history": "Mostra o histórico de comandos", "Clear the terminal": "Limpa o terminal",
  "Completion, history and interrupt a running command": "Autocompletar, histórico e interromper um comando em execução",
  "Anything else runs in the shell.": "Qualquer outro comando roda no shell."
};
const EN_KEYS = Object.keys(PT);
let dict = {};
const t = s => dict[s] || s;

const DEFAULT_CFG = { color: "#d946ef", bg: "", bgEnabled: false, blur: "16px", opacity: 1, radius: "14px", fontUrl: "", fontName: '"Courier New"', fontData: "", lang: "pt-br", showEnv: false, jelly: false, particles: false, animations: true, motionSpeed: 240, theme: "dark", style: "glassmorphism" };
const savedConfig = safeParse(localStorage.getItem("termuxOS_cfg"), {});
let config = Object.assign({}, DEFAULT_CFG, savedConfig);
if (config.bg === "/asset/background.mp4") { config.bg = ""; config.bgEnabled = false; }

const out = $("#output"), cmdEl = $("#cmd"), term = $("#terminal-layer"), fm = $("#file-manager"), appEl = $("#app");
let cwd = "", fmDir = "", currentFile = null, selectedPath = null, tempDir = null, view = "empty", lastInfo = null;
let recents = safeParse(localStorage.getItem("termuxOS_recent"), []);
if (!config.showEnv) { recents = recents.filter(p => !isEnvPath(p)); localStorage.setItem("termuxOS_recent", JSON.stringify(recents)); }
let hist = safeParse(localStorage.getItem("termuxOS_hist"), []), hIdx = hist.length;
let running = null, busy = false, dirty = false, saveTimer = null, treeItems = [], placed = false, appliedBg = null, fontLink = null, fontStyle = null;
const mods = { ctrl: false, alt: false };

async function get(u) { try { const r = await fetch(u); return await r.json(); } catch (e) { return { error: String(e.message || e) }; } }
async function api(u, b) { try { const r = await fetch(u, { method: "POST", body: JSON.stringify(b) }); return await r.json(); } catch (e) { return { error: String(e.message || e) }; } }

let toastTimer = null;
function toast(msg) { const n = $("#toast"); n.textContent = msg; n.style.display = "block"; clearTimeout(toastTimer); toastTimer = setTimeout(() => { n.style.display = "none"; }, 2200); }

function mediaUrl(value) {
  try {
    const u = new URL(String(value || ""), location.href);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : "";
  } catch (e) { return ""; }
}

function setBg(url) {
  if (url === appliedBg) return;
  appliedBg = url;
  const vid = $("#bg-vid"), img = $("#bg-img");
  vid.style.display = "none"; img.style.display = "none";
  if (!url) { vid.removeAttribute("src"); vid.load(); return; }
  const safeUrl = mediaUrl(url);
  if (!safeUrl) { vid.removeAttribute("src"); vid.load(); return; }
  if (/\.(mp4|webm|ogv)(\?|$)/i.test(safeUrl)) { vid.style.display = "block"; vid.src = safeUrl; vid.play().catch(() => {}); }
  else { vid.removeAttribute("src"); vid.load(); img.style.display = "block"; img.style.backgroundImage = "url(" + JSON.stringify(safeUrl) + ")"; }
}
let particlesRunning = false, particleFrame = 0, particleLast = 0, particles = [];
function drawParticles(ts) {
  if (!particlesRunning || document.hidden) { particleFrame = 0; return; }
  if (ts - particleLast < 30) { particleFrame = requestAnimationFrame(drawParticles); return; }
  particleLast = ts;
  const canvas = $("#particle-canvas"), ctx = canvas.getContext("2d");
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = config.color;
  ctx.strokeStyle = config.color;
  for (const p of particles) {
    p.x += p.vx; p.y += p.vy;
    if (p.x < -5 || p.x > w + 5) p.vx *= -1;
    if (p.y < -5 || p.y > h + 5) p.vy *= -1;
    ctx.globalAlpha = p.a;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  particleFrame = requestAnimationFrame(drawParticles);
}
function setParticles(enabled) {
  const canvas = $("#particle-canvas");
  if (!canvas) return;
  if (!enabled) {
    particlesRunning = false; if (particleFrame) cancelAnimationFrame(particleFrame);
    particleFrame = 0; canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height); return;
  }
  if (particlesRunning) return;
  particlesRunning = true;
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  canvas.width = Math.round(canvas.clientWidth * dpr); canvas.height = Math.round(canvas.clientHeight * dpr);
  canvas.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
  const count = Math.min(40, Math.max(16, Math.round(canvas.clientWidth / 28)));
  particles = Array.from({ length: count }, () => ({ x: Math.random() * canvas.clientWidth, y: Math.random() * canvas.clientHeight, vx: (Math.random() - .5) * .36, vy: (Math.random() - .5) * .36, r: 1 + Math.random() * 2, a: .14 + Math.random() * .28 }));
  particleFrame = requestAnimationFrame(drawParticles);
}
document.addEventListener("visibilitychange", () => {
  const v = $("#bg-vid");
  if (v.getAttribute("src")) { if (document.hidden) v.pause(); else v.play().catch(() => {}); }
  if (config.particles && !document.hidden && !particleFrame) particleFrame = requestAnimationFrame(drawParticles);
});
window.addEventListener("resize", () => { if (config.particles) { setParticles(false); setParticles(true); } });

function applyConfig() {
  const r = document.documentElement.style;
  r.setProperty("--accent", config.color);
  r.setProperty("--glass-blur", config.blur);
  r.setProperty("--opacity", config.opacity);
  r.setProperty("--window-radius", config.radius);
  r.setProperty("--font-family", config.fontName + ", monospace");
  r.setProperty("--motion-duration", Math.max(0, Number(config.motionSpeed) || 0) + "ms");
  document.documentElement.classList.remove("style-glassmorphism", "style-clay", "style-neumorphic", "style-flat", "theme-light", "theme-dark", "motion-off");
  document.documentElement.classList.add("style-" + (["glassmorphism", "clay", "neumorphic", "flat"].includes(config.style) ? config.style : "glassmorphism"));
  document.documentElement.classList.add(config.theme === "light" ? "theme-light" : "theme-dark");
  $("#cm-light-theme").disabled = config.theme !== "light";
  cm.setOption("theme", config.theme === "light" ? "eclipse" : "dracula");
  if (!config.animations || (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches)) document.documentElement.classList.add("motion-off");
  if (!config.animations) stopJelly();
  setBg(config.bgEnabled ? config.bg : "");
  if (config.fontData) {
    if (!fontStyle) { fontStyle = document.createElement("style"); document.head.appendChild(fontStyle); }
    fontStyle.textContent = "@font-face{font-family:VStermuImported;src:url(" + JSON.stringify(config.fontData) + ");font-display:swap}";
    r.setProperty("--font-family", '"VStermuImported", monospace');
    if (fontLink) { fontLink.remove(); fontLink = null; }
  } else if (config.fontUrl) {
    if (!fontLink) { fontLink = document.createElement("link"); fontLink.rel = "stylesheet"; document.head.appendChild(fontLink); }
    if (fontLink.href !== config.fontUrl) fontLink.href = config.fontUrl;
    if (fontStyle) { fontStyle.remove(); fontStyle = null; }
  } else {
    if (fontLink) { fontLink.remove(); fontLink = null; }
    if (fontStyle) { fontStyle.remove(); fontStyle = null; }
  }
  localStorage.setItem("termuxOS_cfg", JSON.stringify(config));
  $("#set-env").checked = !!config.showEnv;
  $("#set-jelly").checked = !!config.jelly;
  $("#set-particles").checked = !!config.particles;
  $("#set-animations").checked = !!config.animations;
  $("#set-bg-enabled").checked = !!config.bgEnabled;
  $("#set-bg-url").value = config.bg || "";
  $("#set-font-url").value = config.fontUrl || "";
  $("#set-theme").value = config.theme || "dark";
  $("#set-style").value = config.style || "glassmorphism";
  $("#set-color").value = /^#[0-9a-f]{6}$/i.test(config.color) ? config.color : DEFAULT_CFG.color;
  $("#set-blur").value = parseInt(config.blur, 10) || 0;
  $("#set-opacity").value = Math.round(config.opacity * 100);
  $("#set-motion").value = Math.max(60, Math.min(500, Number(config.motionSpeed) || 240));
  $("#set-lang").value = config.lang;
  setParticles(!!config.particles);
}

function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach(n => { n.textContent = t(n.dataset.i18n); });
  document.querySelectorAll("[data-i18n-title]").forEach(n => { n.title = t(n.dataset.i18nTitle); });
  document.documentElement.lang = config.lang;
  renderTabs(); updateLiveButton(); renderTree();
  if (view === "info" && lastInfo) renderInfo(lastInfo);
  updatePrompt();
}

async function setLang(code, announce) {
  code = String(code || "en").toLowerCase();
  if (code === "en" || code.indexOf("en-") === 0) dict = {};
  else if (code === "pt" || code === "pt-br" || code === "pt-pt") dict = PT;
  else {
    let cached = safeParse(localStorage.getItem("termuxOS_lang_" + code), null);
    if (!cached) {
      if (announce) printLine(t("Translating..."), "term-dim");
      const j = await api("/api/translate", { lang: code, strings: EN_KEYS });
      if (j.error || !Array.isArray(j.strings)) { if (announce) printLine(t("Translation failed, using English.")); return false; }
      cached = {};
      EN_KEYS.forEach((k, i) => { cached[k] = j.strings[i] || k; });
      localStorage.setItem("termuxOS_lang_" + code, JSON.stringify(cached));
    }
    dict = cached;
  }
  config.lang = code;
  applyConfig();
  applyI18n();
  if (announce) printLine(t("Language changed."));
  return true;
}

function scrollDown() { requestAnimationFrame(() => { term.scrollTop = term.scrollHeight; }); }
function trimOutput() { while (out.childElementCount > 500) out.removeChild(out.firstChild); }
function promptText() { return (cwd ? "~/" + cwd : "~") + " $"; }
function updatePrompt() { const p = $("#input-prompt"); p.textContent = promptText(); p.style.display = running || busy ? "none" : "block"; }

function printLine(txt, cls) {
  const d = el("div", "term-line" + (cls ? " " + cls : ""), txt);
  out.appendChild(d); trimOutput(); scrollDown();
  return d;
}
function printCmd(txt) {
  const d = el("div", "term-line");
  d.append(el("span", "term-prompt", promptText()), document.createTextNode(" "), el("span", "term-cmd", txt));
  out.appendChild(d); trimOutput(); scrollDown();
}

function cleanOut(s) {
  return s.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\x1b[()][A-Z0-9]/g, "").replace(/\r\n/g, "\n").replace(/[^\n]*\r(?!\n)/g, "");
}

async function runShell(command) {
  if (isInteractiveCommand(command)) return runPty(command);
  const id = String(Date.now()) + Math.random().toString(36).slice(2, 7);
  running = id; updatePrompt();
  const div = printLine("");
  let raw = "", pending = false, code = null;
  const flush = () => {
    pending = false;
    const i = raw.lastIndexOf("\u0000EXIT:");
    div.textContent = cleanOut(i >= 0 ? raw.slice(0, i) : raw);
    scrollDown();
  };
  try {
    const r = await fetch("/api/exec", { method: "POST", body: JSON.stringify({ command, cwd, id }) });
    if (!r.ok) { const j = await r.json(); div.textContent = t(j.error || "Invalid path"); }
    else {
      const reader = r.body.getReader(), dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        raw += dec.decode(value, { stream: true });
        if (raw.length > 300000) raw = raw.slice(-250000);
        if (!pending) { pending = true; requestAnimationFrame(flush); }
      }
      const i = raw.lastIndexOf("\u0000EXIT:");
      if (i >= 0) { code = parseInt(raw.slice(i + 6), 10); }
      flush();
    }
  } catch (e) { div.textContent += t("System error: ") + e; }
  if (!div.textContent.trim()) div.remove();
  if (code !== null && code !== 0 && !isNaN(code)) printLine("[exit " + code + "]", "term-dim");
  running = null; updatePrompt(); scrollDown();
}

function interrupt() {
  if (ptySocket) { if (ptySocket.readyState === WebSocket.OPEN) sendPty({ type: "input", data: "\x03" }); else ptySocket.close(); return; }
  if (running) { api("/api/kill", { id: running }); printLine("^C", "term-dim"); }
  else if (cmdEl.value) { printLine(promptText() + " " + cmdEl.value + "^C", "term-dim"); cmdEl.value = ""; }
}

function saveHist() { localStorage.setItem("termuxOS_hist", JSON.stringify(hist.slice(-200))); }

function printHelp() {
  printLine(t("--- COMMAND MANUAL ---"));
  const rows = [
    ["fm [.]", "Open the graphical file manager / editor (. = current folder)"],
    ["settings", "Open the separate settings window"],
    ["fs | fullscreen", "Toggle fullscreen"],
    ["cd [dir]", "Change directory (persistent, supports ~ and ..)"],
    ["ft -y [URL]", "Load a Google Fonts URL (font name detected automatically)"],
    ["ft -name [name]", "Set the font family name"],
    ["ft reset", "Restore the default font"],
    ["lang -y [code]", "Change language (e.g. lang -y pt-br, es, fr, ja)"],
    ["config color [c]", "Accent color (any CSS color)"],
    ["config bg [url]", "Background video/image URL, off, or default"],
    ["config blur [px]", "Glass blur level"],
    ["config opacity [N]", "Window opacity from 0.1 to 1"],
    ["config radius [px]", "Window corner radius"],
    ["config theme [dark|light]", "Set the color theme"],
    ["config style [glassmorphism|clay|neumorphic|flat]", "Set the window style"],
    ["config jelly [on|off]", "Jelly window effect"],
    ["config env [on|off]", "Show .env files in the explorer"],
    ["config particles [on|off]", "Toggle background particles"],
    ["config animations [on|off]", "Toggle interface animations"],
    ["ui reset", "Restore the default design"],
    ["history", "Show command history"],
    ["clear", "Clear the terminal"],
    ["Tab / arrows / Ctrl+C", "Completion, history and interrupt a running command"]
  ];
  rows.forEach(r => printLine(" " + r[0].padEnd(24) + ": " + t(r[1])));
  printLine(" " + t("Anything else runs in the shell."), "term-dim");
}

function normSize(v) { return /^\d+(\.\d+)?$/.test(v) ? v + "px" : v; }

async function execLine(val) {
  val = val.trim();
  if (!val) return;
  if (hist[hist.length - 1] !== val) hist.push(val);
  hIdx = hist.length; saveHist();
  printCmd(val);
  busy = true; updatePrompt();
  const args = val.split(/\s+/), cmd = args[0].toLowerCase();
  try {
    switch (cmd) {
      case "help": printHelp(); break;
      case "settings": toggleSettings(true); break;
      case "clear": case "cls": out.textContent = ""; break;
      case "fs": case "fullscreen":
        if (!document.fullscreenElement) { await document.documentElement.requestFullscreen(); printLine(t("Fullscreen on.")); }
        else { await document.exitFullscreen(); printLine(t("Fullscreen off.")); }
        break;
      case "fm":
        if (args[1] === ".") fmDir = cwd;
        toggleFM(true); printLine(t("File manager opened."));
        break;
      case "history": hist.forEach((h, i) => printLine(String(i + 1).padStart(4) + "  " + h)); break;
      case "cd": {
        const target = val.replace(/^cd\s*/i, "").trim().replace(/^['"]|['"]$/g, "");
        const j = await api("/api/cd", { cwd, target });
        if (j.error) printLine(t("Directory not found.")); else cwd = j.cwd;
        break;
      }
      case "ui":
        if (args[1] === "reset") { if (!(await setEnvVisibility(false))) break; config = Object.assign({}, DEFAULT_CFG); purgeHiddenEnvState(); applyConfig(); await loadFiles(); await setLang(config.lang, false); printLine(t("Interface reset.")); }
        else printLine(t("Usage: ") + "ui reset");
        break;
      case "lang": {
        const code = args[1] === "-y" ? args[2] : args[1];
        if (!code) printLine(t("Current language: ") + config.lang + "  (" + t("Usage: ") + "lang -y pt-br)");
        else await setLang(code, true);
        break;
      }
      case "ft":
        if (args[1] === "-y" && args[2]) {
          config.fontUrl = args[2];
          config.fontData = "";
          const m = args[2].match(/family=([^:&]+)/);
          if (m) config.fontName = '"' + decodeURIComponent(m[1]).replace(/\+/g, " ") + '"';
          applyConfig(); printLine(t("Font loaded.") + " " + config.fontName);
        } else if (args[1] === "-name" && args[2]) {
          config.fontName = '"' + args.slice(2).join(" ").replace(/^['"]|['"]$/g, "") + '"';
          applyConfig(); printLine(t("Font applied.") + " " + config.fontName);
        } else if (args[1] === "reset") {
          config.fontUrl = ""; config.fontData = ""; config.fontName = DEFAULT_CFG.fontName; applyConfig(); printLine(t("Font reset."));
        } else printLine(t("Usage: ") + "ft -y [URL] | ft -name [name] | ft reset");
        break;
      case "config": {
        if (args.length < 3) {
          ["color", "bg", "blur", "opacity", "radius"].forEach(k => printLine(" " + k.padEnd(8) + ": " + config[k]));
          printLine(" " + "theme".padEnd(8) + ": " + config.theme);
          printLine(" " + "style".padEnd(8) + ": " + config.style);
          printLine(" " + "particles".padEnd(8) + ": " + t(config.particles ? "on" : "off"));
          printLine(" " + "animations".padEnd(8) + ": " + t(config.animations ? "on" : "off"));
          printLine(" " + "jelly".padEnd(8) + ": " + t(config.jelly ? "on" : "off"));
          printLine(" " + "env".padEnd(8) + ": " + t(config.showEnv ? "on" : "off"));
          break;
        }
        const prop = args[1].toLowerCase(), v = args.slice(2).join(" ");
        let ok = true;
        if (prop === "color") { if (CSS.supports("color", v)) config.color = v; else ok = false; }
        else if (prop === "bg") { config.bg = v === "off" ? "" : v === "default" ? "/asset/background.mp4" : v; config.bgEnabled = !!config.bg; }
        else if (prop === "blur") { const n = normSize(v); if (CSS.supports("width", n)) config.blur = n; else ok = false; }
        else if (prop === "radius") { const n = normSize(v); if (CSS.supports("width", n)) config.radius = n; else ok = false; }
        else if (prop === "opacity") { const n = parseFloat(v); if (isNaN(n)) ok = false; else config.opacity = Math.min(1, Math.max(0.1, n)); }
        else if (prop === "jelly") config.jelly = /^(on|1|true|yes)$/i.test(v);
        else if (prop === "particles") config.particles = /^(on|1|true|yes)$/i.test(v);
        else if (prop === "animations") config.animations = /^(on|1|true|yes)$/i.test(v);
        else if (prop === "theme") { if (["dark", "light"].includes(v.toLowerCase())) config.theme = v.toLowerCase(); else ok = false; }
        else if (prop === "style") { if (["glassmorphism", "clay", "neumorphic", "flat"].includes(v.toLowerCase())) config.style = v.toLowerCase(); else ok = false; }
        else if (prop === "env") { if (await setEnvVisibility(/^(on|1|true|yes)$/i.test(v))) printLine(t("Setting saved: ") + prop); break; }
        else { printLine(t("Unknown setting.")); break; }
        if (!ok) printLine(t("Unknown value.")); else { applyConfig(); printLine(t("Setting saved: ") + prop); }
        break;
      }
      default: busy = false; updatePrompt(); await runShell(val);
    }
  } catch (err) { printLine(t("System error: ") + err); }
  busy = false; updatePrompt(); cmdEl.focus();
}

async function submit() {
  const val = cmdEl.value;
  if (ptySocket && ptySocket.readyState === WebSocket.OPEN) { if (val) sendPty({ type: "input", data: val + "\r" }); cmdEl.value = ""; return; }
  if (running) { cmdEl.value = ""; printLine(val, "term-cmd"); api("/api/stdin", { id: running, data: val + "\n" }); return; }
  if (busy) return;
  cmdEl.value = "";
  await execLine(val);
}

async function complete() {
  const v = cmdEl.value, p = cmdEl.selectionStart, before = v.slice(0, p);
  const token = before.match(/(\S*)$/)[1];
  const j = await get("/api/complete?cwd=" + encodeURIComponent(cwd) + "&token=" + encodeURIComponent(token));
  const list = j.matches || [];
  if (!list.length) return;
  const dirPart = token.slice(0, token.lastIndexOf("/") + 1), base = token.slice(token.lastIndexOf("/") + 1);
  let common = list[0];
  for (const m of list) { while (m.indexOf(common) !== 0) common = common.slice(0, -1); }
  if (list.length > 1 && common.length <= base.length) { printLine(list.join("  "), "term-dim"); return; }
  const pick = list.length === 1 ? list[0] : common;
  const nt = dirPart + pick.replace(/ /g, "\\ ");
  cmdEl.value = before.slice(0, before.length - token.length) + nt + v.slice(p);
  const pos = before.length - token.length + nt.length;
  cmdEl.setSelectionRange(pos, pos);
}

function applyKey(k, ctrl, alt) {
  const c = cmdEl, v = c.value, p = c.selectionStart, key = k.length === 1 ? k.toLowerCase() : k;
  if (ctrl) {
    if (key === "c") { interrupt(); return true; }
    if (key === "l") { out.textContent = ""; return true; }
    if (key === "a" || key === "Home") { c.setSelectionRange(0, 0); return true; }
    if (key === "e" || key === "End") { c.setSelectionRange(v.length, v.length); return true; }
    if (key === "u") { c.value = v.slice(p); c.setSelectionRange(0, 0); return true; }
    if (key === "k") { c.value = v.slice(0, p); return true; }
    if (key === "w") { const b = v.slice(0, p).replace(/\s*\S*$/, ""); c.value = b + v.slice(p); c.setSelectionRange(b.length, b.length); return true; }
    return false;
  }
  if (alt) {
    if (key === "b" || key === "ArrowLeft") { const m = v.slice(0, p).search(/\S+\s*$/); const n = m < 0 ? 0 : m; c.setSelectionRange(n, n); return true; }
    if (key === "f" || key === "ArrowRight") { const r = v.slice(p).match(/^\s*\S+/); const n = p + (r ? r[0].length : v.length - p); c.setSelectionRange(n, n); return true; }
    return false;
  }
  switch (k) {
    case "Escape": c.value = ""; hIdx = hist.length; return true;
    case "Tab": complete(); return true;
    case "Home": c.setSelectionRange(0, 0); return true;
    case "End": c.setSelectionRange(v.length, v.length); return true;
    case "ArrowLeft": { const n = Math.max(0, p - 1); c.setSelectionRange(n, n); return true; }
    case "ArrowRight": { const n = Math.min(v.length, c.selectionEnd + 1); c.setSelectionRange(n, n); return true; }
    case "ArrowUp": if (hIdx > 0) { hIdx--; c.value = hist[hIdx]; c.setSelectionRange(c.value.length, c.value.length); } return true;
    case "ArrowDown":
      if (hIdx < hist.length - 1) { hIdx++; c.value = hist[hIdx]; } else { hIdx = hist.length; c.value = ""; }
      c.setSelectionRange(c.value.length, c.value.length); return true;
    case "PageUp": term.scrollTop -= term.clientHeight * 0.8; return true;
    case "PageDown": term.scrollTop += term.clientHeight * 0.8; return true;
  }
  return false;
}

cmdEl.addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); submit(); return; }
  if (e.ctrlKey && e.key.toLowerCase() === "c" && cmdEl.selectionStart === cmdEl.selectionEnd) { e.preventDefault(); interrupt(); return; }
  if (e.ctrlKey || e.altKey) { if (e.key.length === 1 || e.key.indexOf("Arrow") === 0) { if (applyKey(e.key, e.ctrlKey, e.altKey)) e.preventDefault(); } return; }
  if (["Tab", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Escape"].indexOf(e.key) >= 0) { e.preventDefault(); applyKey(e.key, false, false); }
});
cmdEl.addEventListener("beforeinput", e => {
  if ((mods.ctrl || mods.alt) && e.data && e.data.length === 1) {
    e.preventDefault();
    const c = mods.ctrl, a = mods.alt;
    mods.ctrl = mods.alt = false; refreshMods(); applyKey(e.data, c, a);
  }
});
term.addEventListener("click", () => { if (!String(window.getSelection())) cmdEl.focus(); });

const KEYS = [["ESC", "Escape"], ["/", "/"], ["-", "-"], ["HOME", "Home"], ["\u2191", "ArrowUp"], ["END", "End"], ["PGUP", "PageUp"], ["TAB", "Tab"], ["CTRL", "Ctrl"], ["ALT", "Alt"], ["\u2190", "ArrowLeft"], ["\u2193", "ArrowDown"], ["\u2192", "ArrowRight"], ["PGDN", "PageDown"]];
const REPEAT = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown"];
function refreshMods() { document.querySelectorAll(".t-key").forEach(b => { if (b.dataset.k === "Ctrl") b.classList.toggle("on", mods.ctrl); if (b.dataset.k === "Alt") b.classList.toggle("on", mods.alt); }); }
function pressKey(k) {
  if (k === "Ctrl") { mods.ctrl = !mods.ctrl; refreshMods(); return; }
  if (k === "Alt") { mods.alt = !mods.alt; refreshMods(); return; }
  const ctrl = mods.ctrl, alt = mods.alt;
  if (ctrl || alt) { mods.ctrl = mods.alt = false; refreshMods(); }
  if (ptySocket) { ptyHelperKey(k, ctrl, alt); return; }
  if (k.length === 1 && !ctrl && !alt) { cmdEl.setRangeText(k, cmdEl.selectionStart, cmdEl.selectionEnd, "end"); return; }
  applyKey(k, ctrl, alt);
}
(function buildKeys() {
  const box = $("#keys");
  let rt = null, ri = null;
  const stop = () => { clearTimeout(rt); clearInterval(ri); };
  KEYS.forEach(([label, key]) => {
    const b = el("div", "t-key", label);
    b.dataset.k = key;
    b.addEventListener("pointerdown", e => {
      e.preventDefault();
      pressKey(key);
      if (REPEAT.indexOf(key) >= 0) { stop(); rt = setTimeout(() => { ri = setInterval(() => pressKey(key), 70); }, 380); }
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach(ev => b.addEventListener(ev, stop));
    box.appendChild(b);
  });
  box.addEventListener("mousedown", e => e.preventDefault());
})();

let ptyTerm = null, ptyFit = null, ptySocket = null;
function isInteractiveCommand(command) {
  const parts = String(command || "").trim().split(/\s+/).filter(Boolean);
  while (["sudo", "command", "exec", "env"].includes((parts[0] || "").toLowerCase())) parts.shift();
  const name = (parts[0] || "").split("/").pop().toLowerCase();
  if (/^(nano|vi|vim|nvim|top|htop|less|more|man|mc|ranger|tig|fzf|ssh|sftp|alsamixer|pulsemixer)$/.test(name)) return true;
  return (name === "python" || name === "python3" || name === "node") && parts.length === 1;
}
function sendPty(message) {
  if (ptySocket && ptySocket.readyState === WebSocket.OPEN) ptySocket.send(JSON.stringify(message));
}
function ensurePtyTerminal() {
  if (ptyTerm) return true;
  if (!window.Terminal || !window.FitAddon || !window.FitAddon.FitAddon) return false;
  ptyTerm = new window.Terminal({
    cursorBlink: true, convertEol: false, scrollback: 3000,
    fontFamily: config.fontName + ", monospace", fontSize: 14,
    theme: { background: "#08090d", foreground: "#e8e9ef", cursor: config.color, selectionBackground: "rgba(217,70,239,.35)" },
    allowProposedApi: false
  });
  ptyFit = new window.FitAddon.FitAddon();
  ptyTerm.loadAddon(ptyFit);
  ptyTerm.open($("#pty-terminal"));
  ptyTerm.onData(data => sendPty({ type: "input", data }));
  ptyTerm.onResize(size => sendPty({ type: "resize", cols: size.cols, rows: size.rows }));
  if (window.ResizeObserver) new ResizeObserver(() => { try { ptyFit.fit(); } catch (e) {} }).observe($("#pty-terminal"));
  return true;
}
function ptyHelperKey(key, ctrl, alt) {
  let data = "";
  const codes = { Escape: "\x1b", Tab: "\t", Home: "\x1b[H", End: "\x1b[F", ArrowUp: "\x1b[A", ArrowDown: "\x1b[B", ArrowRight: "\x1b[C", ArrowLeft: "\x1b[D", PageUp: "\x1b[5~", PageDown: "\x1b[6~" };
  if (key.length === 1 && ctrl) {
    const c = key.toUpperCase().charCodeAt(0);
    if (c >= 64 && c <= 95) data = String.fromCharCode(c - 64);
  } else if (key.length === 1) data = (alt ? "\x1b" : "") + key;
  else data = (alt ? "\x1b" : "") + (codes[key] || "");
  if (data) sendPty({ type: "input", data });
}
function runPty(command) {
  const id = "pty-" + Date.now();
  running = id; updatePrompt();
  if (!ensurePtyTerminal()) { running = null; updatePrompt(); printLine(t("Interactive terminal needs dependencies."), "term-dim"); return Promise.resolve(); }
  const screen = $("#pty-screen");
  screen.classList.add("active");
  ptyTerm.options.fontFamily = config.fontName + ", monospace";
  ptyTerm.options.cursorBlink = !!config.animations;
  ptyTerm.options.theme = { background: "#08090d", foreground: "#e8e9ef", cursor: config.color, selectionBackground: config.color + "55" };
  ptyTerm.clear();
  return new Promise(resolve => {
    let done = false;
    const finish = code => {
      if (done) return; done = true;
      if (ptySocket === socket) ptySocket = null;
      screen.classList.remove("active");
      if (running === id) running = null;
      updatePrompt(); if (!busy) cmdEl.focus();
      if (code !== undefined && code !== null && Number(code) !== 0) printLine("[exit " + code + "]", "term-dim");
      resolve();
    };
    const socket = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/pty");
    ptySocket = socket;
    socket.onopen = () => {
      try { ptyFit.fit(); } catch (e) {}
      sendPty({ type: "start", command, cwd, cols: ptyTerm.cols, rows: ptyTerm.rows });
      ptyTerm.focus();
    };
    socket.onmessage = event => {
      let msg; try { msg = JSON.parse(event.data); } catch (e) { return; }
      if (msg.type === "data") ptyTerm.write(msg.data);
      else if (msg.type === "error") { printLine(t(msg.message || "Interactive terminal needs dependencies."), "term-dim"); finish(); }
      else if (msg.type === "exited") finish(msg.code);
    };
    socket.onerror = () => { printLine(t("Interactive terminal needs dependencies."), "term-dim"); finish(); };
    socket.onclose = () => finish();
  });
}

let vpTick = false;
function syncViewport() {
  if (vpTick) return;
  vpTick = true;
  requestAnimationFrame(() => {
    vpTick = false;
    const vv = window.visualViewport;
    if (vv) {
      appEl.style.left = vv.offsetLeft + "px"; appEl.style.top = vv.offsetTop + "px";
      appEl.style.width = vv.width + "px"; appEl.style.height = vv.height + "px";
    } else { appEl.style.width = innerWidth + "px"; appEl.style.height = innerHeight + "px"; }
    applyGeom(); cm.refresh();
    term.scrollTop = term.scrollHeight;
  });
}
if (window.visualViewport) { visualViewport.addEventListener("resize", syncViewport); visualViewport.addEventListener("scroll", syncViewport); }
window.addEventListener("resize", syncViewport);
window.addEventListener("orientationchange", syncViewport);

const jelly = { o: [[0, 0], [0, 0], [0, 0], [0, 0]], v: [[0, 0], [0, 0], [0, 0], [0, 0]], run: false, last: 0 };
function quadMatrix(p, w, h) {
  const x0 = p[0][0], y0 = p[0][1], x1 = p[1][0], y1 = p[1][1], x2 = p[2][0], y2 = p[2][1], x3 = p[3][0], y3 = p[3][1];
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3, dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  let g = 0, hh = 0;
  if (Math.abs(den) > 1e-6) { g = (dx3 * dy2 - dx2 * dy3) / den; hh = (dx1 * dy3 - dx3 * dy1) / den; }
  const a = x1 - x0 + g * x1, b = x3 - x0 + hh * x3, c = x0, d = y1 - y0 + g * y1, e = y3 - y0 + hh * y3, f = y0;
  return "matrix3d(" + [a / w, d / w, 0, g / w, b / h, e / h, 0, hh / h, 0, 0, 1, 0, c, f, 0, 1].join(",") + ")";
}
function jellyApply() {
  const w = fm.offsetWidth || 1, h = fm.offsetHeight || 1, o = jelly.o;
  const p = [[o[0][0], o[0][1]], [w + o[1][0], o[1][1]], [w + o[2][0], h + o[2][1]], [o[3][0], h + o[3][1]]];
  fm.style.transform = quadMatrix(p, w, h);
}
function stopJelly() {
  jelly.run = false;
  for (let i = 0; i < 4; i++) { jelly.o[i][0] = jelly.o[i][1] = jelly.v[i][0] = jelly.v[i][1] = 0; }
  fm.classList.remove("jelly-on"); fm.style.transform = "";
}
function jellyStep(ts) {
  if (!jelly.run) return;
  const dt = Math.min(0.032, (ts - jelly.last) / 1000 || 0.016);
  jelly.last = ts;
  let energy = 0;
  for (let i = 0; i < 4; i++) for (let a = 0; a < 2; a++) {
    jelly.v[i][a] += (-170 * jelly.o[i][a] - 11 * jelly.v[i][a]) * dt;
    jelly.o[i][a] += jelly.v[i][a] * dt;
    energy += Math.abs(jelly.o[i][a]) + Math.abs(jelly.v[i][a]);
  }
  if (energy < 0.4) { stopJelly(); return; }
  jellyApply();
  requestAnimationFrame(jellyStep);
}
function startJelly() {
  if (!config.animations || jelly.run || fm.classList.contains("maximized") || fm.classList.contains("genie-suck")) return;
  jelly.run = true; jelly.last = performance.now();
  fm.classList.add("jelly-on");
  requestAnimationFrame(jellyStep);
}
function clampJelly() { for (let i = 0; i < 4; i++) for (let a = 0; a < 2; a++) jelly.o[i][a] = Math.max(-70, Math.min(70, jelly.o[i][a])); }
function jellyMove(dx, dy, gx, gy) {
  if (!config.jelly || (!dx && !dy)) return;
  const w = fm.offsetWidth || 1, h = fm.offsetHeight || 1, diag = Math.hypot(w, h);
  const pts = [[0, 0], [w, 0], [w, h], [0, h]];
  for (let i = 0; i < 4; i++) {
    const k = 0.3 + 0.7 * Math.min(1, Math.hypot(pts[i][0] - gx, pts[i][1] - gy) / diag);
    jelly.o[i][0] -= dx * k * 0.9; jelly.o[i][1] -= dy * k * 0.9;
  }
  clampJelly(); startJelly();
}
function jellyResize(dw, dh) {
  if (!config.jelly || (!dw && !dh)) return;
  jelly.o[2][0] -= dw * 0.9; jelly.o[2][1] -= dh * 0.9;
  jelly.o[1][0] -= dw * 0.45; jelly.o[3][1] -= dh * 0.45;
  clampJelly(); startJelly();
}
function jellyPop() {
  if (!config.jelly) return;
  const s = 26;
  jelly.o[0] = [s, s]; jelly.o[1] = [-s, s]; jelly.o[2] = [-s, -s]; jelly.o[3] = [s, -s];
  startJelly();
}

const geom = { x: 0, y: 0, w: 0, h: 0 };
function placeWindow() {
  const AW = appEl.clientWidth, AH = appEl.clientHeight;
  geom.w = Math.min(AW - 16, Math.max(320, Math.round(AW * 0.8)));
  geom.h = Math.min(AH - 16, Math.round(AH * 0.78));
  geom.x = Math.round((AW - geom.w) / 2); geom.y = Math.round((AH - geom.h) / 4);
}
function applyGeom() {
  const AW = appEl.clientWidth, AH = appEl.clientHeight;
  const rw = Math.max(280, Math.min(geom.w, AW - 4)), rh = Math.max(180, Math.min(geom.h, AH - 4));
  const rx = Math.max(0, Math.min(geom.x, AW - rw)), ry = Math.max(0, Math.min(geom.y, AH - rh));
  fm.style.width = rw + "px"; fm.style.height = rh + "px"; fm.style.left = rx + "px"; fm.style.top = ry + "px";
}

const handle = $("#fm-drag-handle");
let drag = null, rs = null, refreshTimer = null;
function lazyRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => cm.refresh(), 90); }
handle.addEventListener("pointerdown", e => {
  if (e.target.closest("button") || fm.classList.contains("maximized")) return;
  drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: fm.offsetLeft, oy: fm.offsetTop, gx: e.clientX - fm.offsetLeft, gy: e.clientY - fm.offsetTop };
  handle.setPointerCapture(e.pointerId);
});
handle.addEventListener("pointermove", e => {
  if (!drag || e.pointerId !== drag.id) return;
  const bx = fm.offsetLeft, by = fm.offsetTop;
  geom.x = drag.ox + e.clientX - drag.sx; geom.y = drag.oy + e.clientY - drag.sy;
  applyGeom();
  geom.x = fm.offsetLeft; geom.y = fm.offsetTop;
  jellyMove(fm.offsetLeft - bx, fm.offsetTop - by, drag.gx, drag.gy);
});
["pointerup", "pointercancel"].forEach(ev => handle.addEventListener(ev, () => { drag = null; }));
handle.addEventListener("dblclick", e => { if (!e.target.closest("button")) toggleMax(); });
handle.addEventListener("click", e => { if (fm.classList.contains("minimized") && !e.target.closest("button")) { fm.classList.remove("minimized"); setTimeout(() => cm.refresh(), 60); } });
const rh = $("#resize-handle");
rh.addEventListener("pointerdown", e => { rs = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ow: fm.offsetWidth, oh: fm.offsetHeight }; rh.setPointerCapture(e.pointerId); e.preventDefault(); });
rh.addEventListener("pointermove", e => {
  if (!rs || e.pointerId !== rs.id) return;
  const bw = fm.offsetWidth, bh = fm.offsetHeight;
  geom.w = Math.max(300, rs.ow + e.clientX - rs.sx); geom.h = Math.max(220, rs.oh + e.clientY - rs.sy);
  applyGeom();
  jellyResize(fm.offsetWidth - bw, fm.offsetHeight - bh);
  lazyRefresh();
});
["pointerup", "pointercancel"].forEach(ev => rh.addEventListener(ev, () => { rs = null; cm.refresh(); }));

function toggleMax() { stopJelly(); fm.classList.toggle("maximized"); fm.classList.remove("minimized"); setTimeout(() => cm.refresh(), 60); }
function toggleMin() { fm.classList.toggle("minimized"); if (config.jelly) { jelly.o[2][1] = -20; jelly.o[3][1] = -20; startJelly(); } }
function toggleFM(show) {
  if (show) {
    fm.style.display = "flex"; fm.classList.remove("minimized", "genie-suck");
    fm.style.zIndex = "100";
    if (!placed) { placeWindow(); placed = true; }
    applyGeom(); loadFiles(); setTimeout(() => cm.refresh(), 100); jellyPop();
  } else fm.style.display = "none";
}
const settingsWindow = $("#settings-window"), settingsHandle = $("#settings-drag-handle");
let settingsDrag = null, settingsResize = null, settingsZ = 120;
function toggleSettings(show) {
  const open = show === undefined ? settingsWindow.style.display === "none" : !!show;
  if (open) {
    settingsWindow.style.display = "flex";
    settingsWindow.classList.remove("minimized");
    settingsWindow.style.zIndex = String(++settingsZ);
    setTimeout(() => cm.refresh(), 60);
  } else settingsWindow.style.display = "none";
}
function toggleSettingsMax() { settingsWindow.classList.toggle("maximized"); settingsWindow.classList.remove("minimized"); }
function toggleSettingsMin() { settingsWindow.classList.toggle("minimized"); }
settingsHandle.addEventListener("pointerdown", e => {
  if (e.target.closest("button") || settingsWindow.classList.contains("maximized")) return;
  if (!settingsWindow.dataset.positionSet) {
    const r = settingsWindow.getBoundingClientRect(), a = appEl.getBoundingClientRect();
    settingsWindow.style.transform = "none";
    settingsWindow.style.left = Math.max(0, r.left - a.left) + "px";
    settingsWindow.style.top = Math.max(0, r.top - a.top) + "px";
    settingsWindow.dataset.positionSet = "1";
  }
  settingsDrag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: parseFloat(settingsWindow.style.left) || 0, oy: parseFloat(settingsWindow.style.top) || 0 };
  settingsHandle.setPointerCapture(e.pointerId);
});
settingsHandle.addEventListener("pointermove", e => {
  if (!settingsDrag || e.pointerId !== settingsDrag.id) return;
  const x = settingsDrag.ox + e.clientX - settingsDrag.sx, y = settingsDrag.oy + e.clientY - settingsDrag.sy;
  settingsWindow.style.left = Math.max(0, Math.min(x, appEl.clientWidth - settingsWindow.offsetWidth)) + "px";
  settingsWindow.style.top = Math.max(0, Math.min(y, appEl.clientHeight - 42)) + "px";
});
["pointerup", "pointercancel"].forEach(ev => settingsHandle.addEventListener(ev, () => { settingsDrag = null; }));
settingsHandle.addEventListener("click", e => { if (settingsWindow.classList.contains("minimized") && !e.target.closest("button")) toggleSettingsMin(); });
settingsHandle.addEventListener("dblclick", e => { if (!e.target.closest("button")) toggleSettingsMax(); });
const settingsResizeHandle = $("#settings-resize");
settingsResizeHandle.addEventListener("pointerdown", e => {
  if (settingsWindow.classList.contains("maximized") || settingsWindow.classList.contains("minimized")) return;
  settingsResize = { id: e.pointerId, x: e.clientX, y: e.clientY, w: settingsWindow.offsetWidth, h: settingsWindow.offsetHeight };
  settingsResizeHandle.setPointerCapture(e.pointerId); e.preventDefault();
});
settingsResizeHandle.addEventListener("pointermove", e => {
  if (!settingsResize || e.pointerId !== settingsResize.id) return;
  settingsWindow.style.width = Math.min(appEl.clientWidth, Math.max(320, settingsResize.w + e.clientX - settingsResize.x)) + "px";
  settingsWindow.style.height = Math.min(appEl.clientHeight, Math.max(260, settingsResize.h + e.clientY - settingsResize.y)) + "px";
});
["pointerup", "pointercancel"].forEach(ev => settingsResizeHandle.addEventListener(ev, () => { settingsResize = null; }));
async function closeGenieFM() {
  await flushSave();
  stopJelly();
  fm.style.transformOrigin = "50% 100%";
  fm.classList.add("genie-suck");
  setTimeout(() => { fm.style.display = "none"; fm.classList.remove("genie-suck"); fm.style.transformOrigin = ""; fm.style.transform = ""; }, 560);
}

const cm = CodeMirror.fromTextArea($("#editor"), { theme: "dracula", lineNumbers: true, indentUnit: 4, matchBrackets: true, mode: null, inputStyle: "contenteditable", viewportMargin: 20 });
const MODES = { js: "javascript", mjs: "javascript", cjs: "javascript", ts: { name: "javascript", typescript: true }, tsx: { name: "javascript", typescript: true }, json: "application/json", html: "htmlmixed", htm: "htmlmixed", css: "css", py: "python", lua: "lua", luau: "lua", c: "text/x-csrc", cpp: "text/x-c++src", h: "text/x-c++src", ino: "text/x-c++src", java: "text/x-java", sh: "shell", bash: "shell", env: "shell", md: "markdown", xml: "xml", yml: "yaml", yaml: "yaml", sql: "text/x-sql" };

cm.on("change", (inst, obj) => {
  if (obj.origin === "setValue" || !currentFile) return;
  dirty = true; $("#st-msg").textContent = t("Saving...");
  clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 600);
});
cm.on("cursorActivity", () => { const c = cm.getCursor(); $("#st-pos").textContent = (c.line + 1) + ":" + (c.ch + 1); });
async function flushSave() {
  clearTimeout(saveTimer);
  if (!dirty || !currentFile) return;
  dirty = false;
  const j = await api("/api/write", { path: currentFile, content: cm.getValue() });
  $("#st-msg").textContent = j.error ? t(j.error) : t("Saved");
  if (view === "live") reloadLive();
}

function iconFor(name, isDir) {
  if (isDir) return icon("fa-solid fa-folder", "#fbbf24");
  const n = name.toLowerCase();
  if (/\.(lua|luau)$/.test(n)) return icon("fa-solid fa-moon", "#3b82f6");
  if (/\.(cpp|ino|c|h)$/.test(n)) return icon("fa-solid fa-microchip", "#06b6d4");
  if (/\.html?$/.test(n)) return icon("fa-brands fa-html5", "#f97316");
  if (/\.js$/.test(n)) return icon("fa-brands fa-js", "#eab308");
  if (/\.py$/.test(n)) return icon("fa-brands fa-python", "#60a5fa");
  if (/\.json$/.test(n)) return icon("fa-solid fa-brackets-curly", "#a3e635");
  if (/^\.env/.test(n)) return icon("fa-solid fa-key", "#f472b6");
  return icon("fa-solid fa-file-code", "#9ca3af");
}
const baseName = p => p.split("/").pop();
const parentOf = p => p.split("/").slice(0, -1).join("/");
const joinPath = (d, n) => (d ? d + "/" + n : n);
function fmtSize(n) { const u = ["B", "KB", "MB", "GB"]; let i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return (i ? n.toFixed(1) : n) + " " + u[i]; }

function showView(v) {
  view = v;
  cm.getWrapperElement().style.display = v === "editor" ? "block" : "none";
  $("#live-frame").style.display = v === "live" ? "block" : "none";
  $("#info-panel").style.display = v === "info" ? "block" : "none";
  $("#empty-panel").style.display = v === "empty" ? "flex" : "none";
  const ed = v === "editor";
  $("#btn-selall").style.display = ed ? "inline-block" : "none";
  $("#btn-copy").style.display = ed ? "inline-block" : "none";
  $("#btn-download").style.display = ed || v === "live" ? "inline-block" : "none";
  updateLiveButton();
  $("#st-path").textContent = v === "info" && selectedPath !== null ? "~/" + selectedPath : currentFile ? "~/" + currentFile : "";
  if (ed) cm.refresh();
}
function updateLiveButton() {
  const b = $("#btn-live"), can = currentFile && !isEnvPath(currentFile) && /\.html?$/i.test(currentFile) && (view === "editor" || view === "live");
  b.style.display = can ? "inline-block" : "none";
  b.textContent = "";
  if (view === "live") b.append(icon("fa-solid fa-code", "#a855f7"), document.createTextNode(" " + t("Editor")));
  else b.append(icon("fa-solid fa-play", "#fbbf24"), document.createTextNode(" " + t("Preview")));
}
function liveUrl() { return "/live/" + currentFile.split("/").map(encodeURIComponent).join("/") + "?t=" + Date.now(); }
function reloadLive() { if (currentFile) $("#live-frame").src = liveUrl(); }
$("#btn-live").onclick = async () => {
  if (view === "live") showView("editor");
  else { await flushSave(); showView("live"); reloadLive(); }
};

function renderTabs() {
  const box = $("#tabs");
  box.textContent = "";
  recents.filter(p => config.showEnv || !isEnvPath(p)).forEach(p => {
    const tab = el("div", "tab" + (p === currentFile && view !== "info" ? " active" : ""));
    const x = el("button", "x"); x.appendChild(icon("fa-solid fa-xmark"));
    tab.append(iconFor(baseName(p), false), el("span", "nm", baseName(p)), x);
    tab.onclick = async () => { fmDir = parentOf(p); await loadFiles(); openFile(p); };
    x.onclick = e => { e.stopPropagation(); closeTab(p); };
    box.appendChild(tab);
  });
  if (view === "info" && tempDir !== null) {
    const tab = el("div", "tab temp active");
    tab.append(iconFor("", true), el("span", "nm", baseName(tempDir) || "~"));
    box.appendChild(tab);
  }
  const act = box.querySelector(".active");
  if (act) box.scrollLeft = Math.max(0, act.offsetLeft - 40);
}
function saveRecents() { localStorage.setItem("termuxOS_recent", JSON.stringify(recents)); }
function purgeHiddenEnvState() {
  recents = recents.filter(p => !isEnvPath(p));
  saveRecents();
  if (currentFile && isEnvPath(currentFile)) {
    clearTimeout(saveTimer); dirty = false;
    currentFile = null; selectedPath = null; cm.setValue("");
    $("#live-frame").src = "about:blank";
    showView("empty");
  }
  const hiddenInfo = (selectedPath && isEnvPath(selectedPath)) || (tempDir && isEnvPath(tempDir));
  if (selectedPath && isEnvPath(selectedPath)) selectedPath = null;
  if (tempDir && isEnvPath(tempDir)) tempDir = null;
  if (hiddenInfo) { lastInfo = null; if (view === "info") showView(currentFile ? "editor" : "empty"); }
  if (fmDir && isEnvPath(fmDir)) { fmDir = ""; treeItems = []; }
  renderTabs(); renderTree();
}
async function setEnvVisibility(enabled) {
  const result = await api("/api/env-visibility", { enabled: !!enabled });
  if (result.error) { $("#set-env").checked = !!config.showEnv; toast(t(result.error)); return false; }
  config.showEnv = !!enabled;
  if (!config.showEnv) purgeHiddenEnvState();
  applyConfig(); await loadFiles();
  return true;
}
async function closeTab(p) {
  recents = recents.filter(x => x !== p); saveRecents();
  if (p === currentFile) {
    await flushSave();
    currentFile = null; cm.setValue("");
    if (recents.length) { const n = recents[recents.length - 1]; fmDir = parentOf(n); await loadFiles(); openFile(n); return; }
    showView("empty");
  }
  renderTabs();
}

function renderTree() {
  const root = $("#tree-root");
  root.textContent = "";
  $("#fm-path").textContent = "~/" + fmDir;
  const frag = document.createDocumentFragment();
  if (fmDir) {
    const up = el("div", "tree-item");
    up.append(icon("fa-solid fa-turn-up"), el("span", "nm", ".."));
    up.onclick = () => { fmDir = parentOf(fmDir); selectedPath = null; loadFiles(); };
    frag.appendChild(up);
  }
  treeItems.filter(item => config.showEnv || !isEnvPath(item.name)).forEach(item => {
    const full = joinPath(fmDir, item.name), isDir = item.type === "dir";
    const row = el("div", "tree-item" + (selectedPath === full ? " sel" : ""));
    row.append(iconFor(item.name, isDir), el("span", "nm", item.name));
    if (selectedPath === full) {
      const rn = el("button", "row-btn"); rn.title = t("Rename"); rn.appendChild(icon("fa-solid fa-pen"));
      rn.onclick = e => { e.stopPropagation(); doRename(full); };
      const dl = el("button", "row-btn"); dl.title = t("Delete"); dl.appendChild(icon("fa-solid fa-trash"));
      dl.onclick = e => { e.stopPropagation(); doDelete(full); };
      row.append(rn, dl);
    }
    if (isDir) {
      const en = el("button", "row-btn"); en.appendChild(icon("fa-solid fa-chevron-right"));
      en.onclick = e => { e.stopPropagation(); enterDir(full); };
      row.appendChild(en);
    }
    row.onclick = () => { if (isDir) selectDir(full); else openFile(full); };
    frag.appendChild(row);
  });
  root.appendChild(frag);
}

async function loadFiles() {
  const j = await get("/api/files?path=" + encodeURIComponent(fmDir));
  if (j.error) { toast(t(j.error)); if (fmDir) { fmDir = ""; return loadFiles(); } return; }
  treeItems = j.items; renderTree();
}

function enterDir(p) {
  fmDir = p; selectedPath = null; tempDir = null;
  if (view === "info") showView(currentFile ? "editor" : "empty");
  renderTabs(); loadFiles();
}

async function selectDir(p) {
  if (selectedPath === p && view === "info") { enterDir(p); return; }
  const j = await get("/api/info?path=" + encodeURIComponent(p));
  if (j.error) { toast(t(j.error)); return; }
  selectedPath = p; tempDir = p;
  renderInfo(j); showView("info"); renderTabs(); renderTree();
}

function renderInfo(info) {
  lastInfo = info;
  const box = $("#info-panel");
  box.textContent = "";
  const head = el("div", "info-head");
  head.append(icon("fa-solid fa-folder", "#fbbf24"), el("span", "", info.name || "~"));
  box.appendChild(head);
  const grid = el("div", "info-grid");
  const row = (k, v) => { grid.append(el("div", "k", t(k)), el("div", "v", v)); };
  row("Path", "~/" + info.path);
  row("Items", String(info.files + info.dirs));
  row("Files", String(info.files));
  row("Folders", String(info.dirs));
  row("Size", fmtSize(info.size) + (info.truncated ? " " + t("(truncated)") : ""));
  row("Modified", new Date(info.modified).toLocaleString());
  box.appendChild(grid);
  const btns = el("div", "info-btns");
  [["Open folder", "fa-folder-open", () => enterDir(info.path)], ["Rename", "fa-pen", () => doRename(info.path)], ["Delete", "fa-trash", () => doDelete(info.path)]].forEach(([k, ic, fn]) => {
    const b = el("button", "fm-btn");
    b.append(icon("fa-solid " + ic), document.createTextNode(" " + t(k)));
    b.onclick = fn; btns.appendChild(b);
  });
  box.appendChild(btns);
  const list = el("div", "info-list");
  if (!info.items.length) list.appendChild(el("div", "info-empty", t("Empty folder")));
  info.items.forEach(it => {
    const full = joinPath(info.path, it.name), r = el("div", "tree-item");
    r.append(iconFor(it.name, it.type === "dir"), el("span", "nm", it.name));
    r.onclick = async () => { if (it.type === "dir") { enterDir(info.path); selectDir(full); } else { fmDir = info.path; await loadFiles(); openFile(full); } };
    list.appendChild(r);
  });
  box.appendChild(list);
}

async function openFile(p) {
  if (!config.showEnv && isEnvPath(p)) { toast(t(".env access is disabled")); return; }
  await flushSave();
  const j = await get("/api/read?path=" + encodeURIComponent(p));
  if (j.error) { toast(t(j.error)); return; }
  currentFile = p; selectedPath = p; tempDir = null;
  const ext = p.split(".").pop().toLowerCase();
  cm.setOption("mode", MODES[ext] || null);
  cm.setValue(j.content); cm.clearHistory();
  if (recents.indexOf(p) < 0) { recents.push(p); if (recents.length > 8) recents.shift(); }
  saveRecents();
  showView("editor"); renderTabs(); renderTree(); cm.scrollTo(0, 0);
  $("#st-msg").textContent = "";
}

function dialog(title, defVal, withInput) {
  return new Promise(resolve => {
    const d = $("#dialog"), inp = $("#dlg-input"), ok = $("#dlg-ok"), cancel = $("#dlg-cancel");
    $("#dlg-title").textContent = title;
    inp.style.display = withInput ? "block" : "none"; inp.value = defVal || "";
    d.style.display = "flex";
    if (withInput) { inp.focus(); inp.select(); }
    const done = v => { d.style.display = "none"; ok.onclick = cancel.onclick = inp.onkeydown = null; resolve(v); };
    ok.onclick = () => done(withInput ? inp.value.trim() : true);
    cancel.onclick = () => done(withInput ? null : false);
    inp.onkeydown = e => { if (e.key === "Enter") ok.click(); if (e.key === "Escape") cancel.click(); };
  });
}
const ask = (title, def) => dialog(title, def, true);
const confirmDlg = title => dialog(title, "", false);
const validName = n => n && !/[\/\\]/.test(n) && n !== "." && n !== "..";

function remap(oldP, newP) {
  const f = p => p === oldP ? newP : p.indexOf(oldP + "/") === 0 ? newP + p.slice(oldP.length) : p;
  recents = recents.map(f); saveRecents();
  if (currentFile) currentFile = f(currentFile);
  if (selectedPath !== null) selectedPath = f(selectedPath);
  if (tempDir !== null) tempDir = f(tempDir);
}

async function doRename(p) {
  const old = baseName(p), n = await ask(t("New name:"), old);
  if (!n || n === old) return;
  if (!validName(n)) { toast(t("Invalid name")); return; }
  await flushSave();
  const np = joinPath(parentOf(p), n);
  const j = await api("/api/rename", { oldPath: p, newPath: np });
  if (j.error) { toast(t(j.error)); return; }
  remap(p, np);
  await loadFiles();
  if (view === "info" && tempDir !== null) selectDir(tempDir); else { renderTabs(); showView(view); }
}

async function doDelete(p) {
  if (!(await confirmDlg(t("Delete this item?") + " " + baseName(p)))) return;
  await flushSave();
  const j = await api("/api/delete", { path: p });
  if (j.error) { toast(t(j.error)); return; }
  const gone = x => x === p || x.indexOf(p + "/") === 0;
  recents = recents.filter(x => !gone(x)); saveRecents();
  if (currentFile && gone(currentFile)) { currentFile = null; dirty = false; cm.setValue(""); }
  if (selectedPath !== null && gone(selectedPath)) selectedPath = null;
  tempDir = null;
  showView(currentFile ? "editor" : "empty");
  renderTabs(); loadFiles();
}

$("#btn-newfile").onclick = async () => {
  $("#new-item-menu").classList.remove("open");
  const n = await ask(t("File name:"), "");
  if (!n) return;
  if (!validName(n)) { toast(t("Invalid name")); return; }
  const p = joinPath(fmDir, n);
  const j = await api("/api/write", { path: p, content: "", create: true });
  if (j.error) { toast(t(j.error)); return; }
  await loadFiles(); openFile(p);
};
$("#btn-newfolder").onclick = async () => {
  $("#new-item-menu").classList.remove("open");
  const n = await ask(t("Folder name:"), "");
  if (!n) return;
  if (!validName(n)) { toast(t("Invalid name")); return; }
  const j = await api("/api/mkdir", { path: joinPath(fmDir, n) });
  if (j.error) toast(t(j.error)); else loadFiles();
};

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  fallbackCopy(text);
}
function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); } catch (e) {}
  ta.remove();
}
$("#btn-selall").onclick = () => { cm.focus(); cm.execCommand("selectAll"); };
$("#btn-copy").onclick = () => { copyText(cm.getSelection() || cm.getValue()); toast(t("Code copied.")); };
$("#btn-download").onclick = () => {
  if (!currentFile) return;
  const blob = new Blob([cm.getValue()], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = baseName(currentFile); a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(t("Downloading file..."));
};

$("#btn-min").onclick = toggleMin;
$("#btn-max").onclick = toggleMax;
$("#btn-close").onclick = closeGenieFM;
$("#btn-settings").onclick = () => toggleSettings(true);
$("#btn-settings-launch").onclick = () => toggleSettings();
$("#btn-fm-launch").onclick = () => toggleFM(true);
$("#settings-close").onclick = () => toggleSettings(false);
$("#settings-min").onclick = toggleSettingsMin;
$("#settings-max").onclick = toggleSettingsMax;
$("#btn-new-item").onclick = e => { e.stopPropagation(); $("#new-item-menu").classList.toggle("open"); };
document.addEventListener("click", e => { if (!e.target.closest(".new-menu-wrap")) $("#new-item-menu").classList.remove("open"); });
$("#set-env").onchange = e => setEnvVisibility(e.target.checked);
$("#set-jelly").onchange = e => { config.jelly = e.target.checked; applyConfig(); };
$("#set-particles").onchange = e => { config.particles = e.target.checked; applyConfig(); };
$("#set-animations").onchange = e => { config.animations = e.target.checked; applyConfig(); };
$("#set-bg-enabled").onchange = e => { config.bgEnabled = e.target.checked; if (config.bgEnabled && !config.bg) { config.bg = "/asset/background.mp4"; $("#set-bg-url").value = config.bg; } applyConfig(); };
$("#set-bg-apply").onclick = () => {
  const value = $("#set-bg-url").value.trim(), safe = mediaUrl(value);
  if (value && !safe) { toast(t("Background URL must use http(s).")); return; }
  config.bg = value ? (value.startsWith("/") ? value : safe) : "";
  config.bgEnabled = !!config.bg; applyConfig();
};
$("#set-bg-default").onclick = () => { config.bg = "/asset/background.mp4"; config.bgEnabled = true; applyConfig(); };
$("#set-theme").onchange = e => { config.theme = e.target.value; applyConfig(); };
$("#set-style").onchange = e => { config.style = e.target.value; applyConfig(); };
$("#set-color").oninput = e => { config.color = e.target.value; applyConfig(); };
$("#set-blur").oninput = e => { config.blur = e.target.value + "px"; applyConfig(); };
$("#set-opacity").oninput = e => { config.opacity = e.target.value / 100; applyConfig(); };
$("#set-motion").oninput = e => { config.motionSpeed = Number(e.target.value); applyConfig(); };
$("#set-font-load").onclick = () => {
  const url = $("#set-font-url").value.trim();
  if (!/^https:\/\/fonts\.googleapis\.com\/css2?\?/i.test(url)) { toast(t("Enter a valid Google Fonts CSS URL.")); return; }
  config.fontUrl = url; config.fontData = "";
  try { const family = new URL(url).searchParams.get("family").split(":")[0].replace(/\+/g, " ").replace(/[^a-z0-9 _-]/ig, ""); if (family) config.fontName = '"' + family + '"'; } catch (e) {}
  applyConfig();
};
$("#set-font-file").onchange = e => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  if (!/\.(woff2?|ttf|otf)$/i.test(file.name) || file.size > 3 * 1024 * 1024) { toast(t("Font file must be .woff/.woff2/.ttf/.otf and no larger than 3 MB.")); e.target.value = ""; return; }
  const reader = new FileReader();
  reader.onload = () => { config.fontUrl = ""; config.fontData = String(reader.result || ""); config.fontName = '"VStermuImported"'; applyConfig(); toast(t("Font applied.")); };
  reader.onerror = () => toast(t("Font file must be .woff/.woff2/.ttf/.otf and no larger than 3 MB."));
  reader.readAsDataURL(file);
};
$("#set-font-reset").onclick = () => { config.fontUrl = ""; config.fontData = ""; config.fontName = DEFAULT_CFG.fontName; $("#set-font-file").value = ""; applyConfig(); };
$("#set-lang-apply").onclick = async () => { const ok = await setLang($("#set-lang").value.trim(), false); toast(ok ? t("Language changed.") : t("Translation failed, using English.")); };
$("#set-reset").onclick = async () => { if (!(await setEnvVisibility(false))) return; config = Object.assign({}, DEFAULT_CFG); purgeHiddenEnvState(); applyConfig(); await loadFiles(); await setLang(config.lang, false); toast(t("Interface reset.")); };

window.addEventListener("beforeunload", () => { if (dirty && currentFile && (config.showEnv || !isEnvPath(currentFile))) navigator.sendBeacon("/api/write", JSON.stringify({ path: currentFile, content: cm.getValue() })); });

applyConfig();
api("/api/env-visibility", { enabled: !!config.showEnv });
showView("empty");
syncViewport();
setLang(config.lang, false).then(() => {
  printLine(t("VStermu-x started."));
  printLine(t("Type 'help' for the command manual.") + "\n");
  updatePrompt(); cmdEl.focus();
});
</script>
</body>
</html>`;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => { data += c; if (data.length > 2e7) req.destroy(); });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

async function handle(req, res) {
  if (!allowedRequest(req)) { res.writeHead(403); return res.end("Forbidden"); }
  const u = new URL(req.url, "http://" + req.headers.host);

  if (u.pathname === "/") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); return res.end(HTML); }

  if (u.pathname.startsWith("/live/")) {
    try {
      const rel = safeRel(decodeURIComponent(u.pathname.substring(6)));
      if (isEnvPath(rel)) throw new Error(".env preview is blocked");
      const p = await safeHomePath(rel);
      return serveFile(req, res, p, MIME[path.extname(p).toLowerCase()] || "text/plain; charset=utf-8");
    } catch (e) { res.writeHead(404); return res.end(); }
  }
  if (u.pathname === "/asset/background.mp4") { await ensureAsset(BACKGROUND, BACKGROUND_URL); return serveFile(req, res, BACKGROUND, "video/mp4", "public, max-age=3600"); }
  if (u.pathname === "/asset/particle.png") { await ensureAsset(PARTICLE, PARTICLE_URL); return serveFile(req, res, PARTICLE, "image/png", "public, max-age=3600"); }
  if (u.pathname === "/vendor/xterm.js") return serveFile(req, res, path.join(ROOT, "node_modules", "@xterm", "xterm", "lib", "xterm.js"), "application/javascript; charset=utf-8");
  if (u.pathname === "/vendor/xterm.css") return serveFile(req, res, path.join(ROOT, "node_modules", "@xterm", "xterm", "css", "xterm.css"), "text/css; charset=utf-8");
  if (u.pathname === "/vendor/addon-fit.js") return serveFile(req, res, path.join(ROOT, "node_modules", "@xterm", "addon-fit", "lib", "addon-fit.js"), "application/javascript; charset=utf-8");

  try {
    if (u.pathname === "/api/env-visibility") {
      if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }); return res.end(); }
      const body = await readBody(req);
      envAccessEnabled = body.enabled === true;
      return json(res, 200, { ok: true, enabled: envAccessEnabled });
    }
    const showEnv = envAccessEnabled;

    if (u.pathname === "/api/files") {
      const rel = safeRel(u.searchParams.get("path") || "");
      assertEnvAccess(rel);
      const entries = await fsp.readdir(await safeHomePath(rel), { withFileTypes: true });
      const items = entries.filter(e => visible(e, showEnv)).map(e => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }));
      items.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
      return json(res, 200, { items });
    }

    if (u.pathname === "/api/info") {
      const rel = safeRel(u.searchParams.get("path") || "");
      assertEnvAccess(rel);
      const p = await safeHomePath(rel);
      const st = await fsp.stat(p);
      const info = { name: path.basename(p), path: rel, modified: st.mtimeMs, size: st.size, files: 0, dirs: 0, items: [], truncated: false };
      if (st.isDirectory()) {
        const entries = (await fsp.readdir(p, { withFileTypes: true })).filter(e => visible(e, showEnv));
        entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
        for (const e of entries) { if (e.isDirectory()) info.dirs++; else info.files++; }
        info.items = entries.slice(0, 200).map(e => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }));
        const sz = await dirSize(p, showEnv);
        info.size = sz.total; info.truncated = sz.truncated;
      } else info.files = 1;
      return json(res, 200, info);
    }

    if (u.pathname === "/api/read") {
      const rel = safeRel(u.searchParams.get("path") || "");
      assertEnvAccess(rel);
      const p = await safeHomePath(rel);
      const st = await fsp.stat(p);
      if (st.size > 2e6) throw new Error("File too large");
      const buf = await fsp.readFile(p);
      if (buf.includes(0)) throw new Error("Binary file");
      return json(res, 200, { content: buf.toString("utf8") });
    }

    if (u.pathname === "/api/write") {
      const body = await readBody(req);
      const rel = safeRel(body.path);
      if (!rel) throw new Error("Invalid path");
      assertEnvAccess(rel);
      if (body.create && fs.existsSync(homePath(rel))) throw new Error("Already exists");
      const content = typeof body.content === "string" ? body.content : "";
      const dest = await safeHomePath(rel);
      await mkdirp(path.dirname(dest));
      await fsp.writeFile(dest, content, "utf8");
      if (!isEnvPath(rel)) {
        await mkdirp(path.dirname(connectionPath(rel)));
        await fsp.writeFile(connectionPath(rel), content, "utf8");
      }
      return json(res, 200, { ok: true });
    }

    if (u.pathname === "/api/mkdir") {
      const rel = safeRel((await readBody(req)).path);
      if (!rel) throw new Error("Invalid path");
      assertEnvAccess(rel);
      await mkdirp(await safeHomePath(rel));
      if (!isEnvPath(rel)) await mkdirp(connectionPath(rel));
      return json(res, 200, { ok: true });
    }

    if (u.pathname === "/api/rename") {
      const body = await readBody(req);
      const oldR = safeRel(body.oldPath), newR = safeRel(body.newPath);
      if (!oldR || !newR) throw new Error("Invalid path");
      assertEnvAccess(oldR); assertEnvAccess(newR);
      const oldPath = await safeHomePath(oldR), newPath = await safeHomePath(newR);
      if (fs.existsSync(newPath)) throw new Error("Already exists");
      await fsp.rename(oldPath, newPath);
      if (!isEnvPath(oldR) && !isEnvPath(newR)) { try { await mkdirp(path.dirname(connectionPath(newR))); await fsp.rename(connectionPath(oldR), connectionPath(newR)); } catch (e) {} }
      return json(res, 200, { ok: true });
    }

    if (u.pathname === "/api/delete") {
      const rel = safeRel((await readBody(req)).path);
      if (!rel) throw new Error("Invalid path");
      assertEnvAccess(rel);
      await fsp.rm(await safeHomePath(rel), { recursive: true, force: true });
      if (!isEnvPath(rel)) { try { await fsp.rm(connectionPath(rel), { recursive: true, force: true }); } catch (e) {} }
      return json(res, 200, { ok: true });
    }

    if (u.pathname === "/api/cd") {
      const body = await readBody(req);
      const cwd = safeRel(body.cwd || "");
      let target = String(body.target || "").trim();
      let abs;
      if (!target || target === "~") abs = path.resolve(HOME);
      else if (target.startsWith("~/")) abs = path.resolve(HOME, target.slice(2));
      else abs = path.resolve(homePath(cwd), target);
      const home = path.resolve(HOME);
      if (!inside(home, abs)) throw new Error("Invalid path");
      const rel = path.relative(home, abs).split(path.sep).join("/");
      abs = await safeHomePath(rel);
      const st = await fsp.stat(abs);
      if (!st.isDirectory()) throw new Error("Directory not found.");
      return json(res, 200, { cwd: path.relative(home, abs).split(path.sep).join("/") });
    }

    if (u.pathname === "/api/complete") {
      const cwd = safeRel(u.searchParams.get("cwd") || "");
      const token = u.searchParams.get("token") || "";
      const slash = token.lastIndexOf("/");
      const dirPart = slash >= 0 ? token.slice(0, slash + 1) : "";
      const base = token.slice(slash + 1);
      let matches = [];
      try {
        const relDir = dirPart.startsWith("/") ? null : path.posix.join(cwd, dirPart);
        const dir = relDir === null ? null : await safeHomePath(relDir);
        if (dir && inside(path.resolve(HOME), dir)) {
          assertEnvAccess(path.relative(HOME, dir).split(path.sep).join("/"));
          const entries = await fsp.readdir(dir, { withFileTypes: true });
          matches = entries
            .filter(e => visible(e, showEnv) && e.name.startsWith(base) && (base.startsWith(".") || !e.name.startsWith(".")))
            .map(e => e.name + (e.isDirectory() ? "/" : ""))
            .sort()
            .slice(0, 100);
        }
      } catch (e) {}
      return json(res, 200, { matches });
    }

    if (u.pathname === "/api/translate") {
      const body = await readBody(req);
      const lang = String(body.lang || "").toLowerCase().replace(/[^a-z-]/g, "");
      const strings = Array.isArray(body.strings) ? body.strings.map(String).slice(0, 400) : [];
      if (!lang) throw new Error("Unknown language");
      await mkdirp(LANGDIR);
      const file = path.join(LANGDIR, lang + ".json");
      let cache = {};
      try { cache = JSON.parse(await fsp.readFile(file, "utf8")); } catch (e) {}
      const missing = strings.filter(s => !cache[s]);
      for (let i = 0; i < missing.length; i += 20) {
        const chunk = missing.slice(i, i + 20);
        let lines = (await translateText(chunk.join("\n"), lang)).split("\n");
        if (lines.length !== chunk.length) { lines = []; for (const s of chunk) lines.push(await translateText(s, lang)); }
        chunk.forEach((s, k) => { if (lines[k] && lines[k].trim()) cache[s] = lines[k].trim(); });
      }
      const changed = strings.filter(s => cache[s] && cache[s] !== s).length;
      if (strings.length > 5 && changed === 0) throw new Error("Unknown language");
      if (missing.length) await fsp.writeFile(file, JSON.stringify(cache), "utf8");
      return json(res, 200, { strings: strings.map(s => cache[s] || s) });
    }

    if (u.pathname === "/api/exec") {
      const body = await readBody(req);
      const cwd = body.cwd || "";
      const id = String(body.id || "");
      const dir = await safeHomePath(cwd);
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
      const child = spawn("sh", ["-lc", String(body.command || "")], {
        cwd: dir, env: { ...process.env, TERM: "xterm-256color" }, detached: true, stdio: ["pipe", "pipe", "pipe"]
      });
      let ended = false;
      const finish = code => { if (ended) return; ended = true; procs.delete(id); res.end("\n\u0000EXIT:" + code); };
      procs.set(id, child);
      child.stdin.on("error", () => {});
      child.stdout.on("data", d => res.write(d));
      child.stderr.on("data", d => res.write(d));
      child.on("error", e => { res.write(String(e.message) + "\n"); finish(127); });
      child.on("close", code => finish(code));
      res.on("close", () => { if (!ended) killProc(child); });
      return;
    }

    if (u.pathname === "/api/kill") {
      const child = procs.get(String((await readBody(req)).id || ""));
      if (child) killProc(child);
      return json(res, 200, { ok: !!child });
    }

    if (u.pathname === "/api/stdin") {
      const body = await readBody(req);
      const child = procs.get(String(body.id || ""));
      if (child && child.stdin.writable) child.stdin.write(String(body.data || ""));
      return json(res, 200, { ok: !!child });
    }

    return json(res, 404, { error: "Not found" });
  } catch (e) {
    if (!res.headersSent) return json(res, 400, { error: e.message });
    res.end();
  }
}

async function main() {
  await mkdirp(STORAGE);
  await mkdirp(CONNECTION);
  await mkdirp(LANGDIR);
  const server = http.createServer((req, res) => { handle(req, res).catch(() => { try { res.end(); } catch (e) {} }); });
  const wss = WebSocketServer ? new WebSocketServer({ noServer: true, maxPayload: 65536 }) : null;
  if (wss) {
    wss.on("connection", ws => {
      let child = null, started = false;
      const send = message => { if (ws.readyState === 1) { try { ws.send(JSON.stringify(message)); } catch (e) {} } };
      ws.on("message", raw => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
        if (msg.type === "start" && !started) {
          started = true;
          if (!pty || typeof pty.spawn !== "function") { send({ type: "error", message: "Interactive terminal needs dependencies." }); ws.close(1011); return; }
          const command = typeof msg.command === "string" ? msg.command : "";
          if (!command.trim() || command.length > 8192 || command.includes("\u0000")) { send({ type: "error", message: "Invalid command" }); ws.close(1008); return; }
          try {
            const rel = safeRel(typeof msg.cwd === "string" ? msg.cwd : "");
            const cwd = homePath(rel);
            if (!fs.statSync(cwd).isDirectory()) throw new Error("Directory not found.");
            const shell = process.env.SHELL && (path.isAbsolute(process.env.SHELL) ? fs.existsSync(process.env.SHELL) : true) ? process.env.SHELL : "sh";
            const cols = Math.max(20, Math.min(300, Number(msg.cols) || 80));
            const rows = Math.max(5, Math.min(100, Number(msg.rows) || 24));
            child = pty.spawn(shell, ["-c", command], {
              name: "xterm-256color", cols, rows, cwd,
              env: { ...process.env, HOME, PWD: cwd, TERM: "xterm-256color", COLORTERM: "truecolor" }
            });
            child.onData(data => send({ type: "data", data }));
            child.onExit(event => { send({ type: "exited", code: event.exitCode }); child = null; try { ws.close(1000); } catch (e) {} });
          } catch (e) {
            console.error("PTY start failed:", e.message);
            send({ type: "error", message: "Interactive terminal needs dependencies." });
            ws.close(1011);
          }
        } else if (msg.type === "input" && child) {
          const data = typeof msg.data === "string" ? msg.data : "";
          if (data.length <= 32768) { try { child.write(data); } catch (e) {} }
        } else if (msg.type === "resize" && child) {
          const cols = Math.max(20, Math.min(300, Number(msg.cols) || 80));
          const rows = Math.max(5, Math.min(100, Number(msg.rows) || 24));
          try { child.resize(cols, rows); } catch (e) {}
        }
      });
      ws.on("close", () => { if (child) { try { child.kill(); } catch (e) {} child = null; } });
      ws.on("error", () => { if (child) { try { child.kill(); } catch (e) {} child = null; } });
    });
  }
  server.on("upgrade", (req, socket, head) => {
    const u = new URL(req.url, "http://" + (req.headers.host || "localhost"));
    if (!allowedRequest(req) || u.pathname !== "/pty" || !wss) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); socket.destroy(); return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
  });
  server.on("error", e => { console.error(e.message); process.exit(1); });
  server.listen(PORT, HOST, () => {
    const url = "http://" + HOST + ":" + PORT;
    console.log("Server rodando em: " + url);
    spawn("termux-open-url", [url], { stdio: "ignore" }).on("error", () => {});
    spawn("am", ["start", "-a", "android.intent.action.VIEW", "-d", url], { stdio: "ignore" }).on("error", () => {});
  });
}
main().catch(e => { console.error(e); process.exit(1); });
