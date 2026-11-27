import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectAllStatus } from '../collector/collect-ai-status.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_HTML_PATH = path.join(__dirname, 'ui.html');
const STATE_DIR = path.join(os.homedir(), '.ai-desk-pet');
const STATE_FILE = path.join(STATE_DIR, 'widget-state.json');
const EXTERNAL_DIR = path.join(STATE_DIR, 'external');
const SERVER_INFO_FILE = path.join(STATE_DIR, 'mac-server.json');

const args = process.argv.slice(2);
const isSmokeTest = args.includes('--smoke-test');
const portIdx = args.indexOf('--port');
const requestedPort = portIdx >= 0 && args[portIdx + 1] ? Number(args[portIdx + 1]) : 0;
const intIdx = args.indexOf('--interval');
const intervalSec = Math.max(2, intIdx >= 0 && args[intIdx + 1] ? Number(args[intIdx + 1]) : 4);

function loadPrefs() {
  const def = { left: -1, top: -1, topmost: true, muted: false };
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      return { ...def, ...raw };
    }
  } catch {}
  return def;
}

function savePrefs(prefs) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(prefs), 'utf8');
  } catch {}
}

function ensureExternalReadme() {
  fs.mkdirSync(EXTERNAL_DIR, { recursive: true });
  const readmePath = path.join(EXTERNAL_DIR, '_README_EXAMPLE.txt');
  if (!fs.existsSync(readmePath)) {
    const sample = `이 폴더에 *.json 파일을 놓으면 AI Desk Pet 위젯에 즉시 함께 표시됩니다.
예시 파일명: my-agent.json

{
  "provider": "gemini-cli",
  "providerName": "Gemini CLI",
  "shortName": "Gem",
  "color": "#3B82F6",
  "title": "문서 요약 배치 작업",
  "status": "running",
  "statusDetail": "작업 중",
  "summary": "PDF 12건 텍스트 추출 중",
  "remainingPct": 72,
  "quotaLabel": "일일 잔여",
  "model": "gemini-4-flash"
}

status 값: running | approval | paused | error | done
`;
    fs.writeFileSync(readmePath, sample, 'utf8');
  }
}

function sendMacNotification(title, message) {
  if (process.platform !== 'darwin') return;
  const escTitle = String(title || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const escMsg = String(message || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `display notification "${escMsg}" with title "${escTitle}" sound name "Glass"`;
  execFile('osascript', ['-e', script], () => {});
}

let prefs = loadPrefs();
let latestSnapshot = null;
let isFirstSnapshot = true;
const seenAlerts = new Set();

function refreshSnapshot() {
  const snap = collectAllStatus();
  latestSnapshot = snap;

  if (Array.isArray(snap.alerts)) {
    if (isFirstSnapshot) {
      for (const a of snap.alerts) {
        seenAlerts.add(a.alertKey);
        if (a.severity === 'approval' && !prefs.muted && !isSmokeTest) {
          sendMacNotification(`AI 승인 대기 (${a.providerName})`, a.message);
        }
      }
    } else {
      for (const a of snap.alerts) {
        if (!seenAlerts.has(a.alertKey)) {
          seenAlerts.add(a.alertKey);
          if (!prefs.muted && !isSmokeTest) {
            const title = a.severity === 'approval' ? `AI 승인 대기 (${a.providerName})` : `AI 작업 오류 (${a.providerName})`;
            sendMacNotification(title, a.message);
          }
        }
      }
    }
  }
  isFirstSnapshot = false;
  return snap;
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 65536) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || '/').split('?')[0];

  if (req.method === 'GET' && urlPath === '/') {
    try {
      const html = fs.readFileSync(UI_HTML_PATH, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(err.message);
    }
    return;
  }

  if (req.method === 'GET' && urlPath === '/api/status') {
    if (!latestSnapshot) refreshSnapshot();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ snapshot: latestSnapshot, prefs }));
    return;
  }

  if (req.method === 'POST' && urlPath === '/api/refresh') {
    refreshSnapshot();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ snapshot: latestSnapshot, prefs }));
    return;
  }

  if (req.method === 'POST' && urlPath === '/api/prefs') {
    const body = await readJsonBody(req);
    if (typeof body.topmost === 'boolean') prefs.topmost = body.topmost;
    if (typeof body.muted === 'boolean') prefs.muted = body.muted;
    if (typeof body.left === 'number') prefs.left = body.left;
    if (typeof body.top === 'number') prefs.top = body.top;
    savePrefs(prefs);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, prefs }));
    return;
  }

  if (req.method === 'POST' && urlPath === '/api/open-external') {
    ensureExternalReadme();
    if (process.platform === 'darwin') {
      execFile('open', [EXTERNAL_DIR], () => {});
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, dir: EXTERNAL_DIR }));
    return;
  }

  if (req.method === 'POST' && urlPath === '/api/quit') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
    setTimeout(() => shutdown(), 100);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

let pollTimer = null;
function shutdown() {
  if (pollTimer) clearInterval(pollTimer);
  try {
    if (fs.existsSync(SERVER_INFO_FILE)) fs.unlinkSync(SERVER_INFO_FILE);
  } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

refreshSnapshot();
server.listen(requestedPort, '127.0.0.1', async () => {
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  if (isSmokeTest) {
    try {
      const r1 = await fetch(`${baseUrl}/`);
      const html = await r1.text();
      const r2 = await fetch(`${baseUrl}/api/status`);
      const data = await r2.json();
      const hasHtml = r1.status === 200 && html.includes('AI Desk Pet');
      const hasJson = r2.status === 200 && data && data.snapshot && typeof data.snapshot.overallState === 'string';
      if (!hasHtml || !hasJson) throw new Error('Smoke check failed');
      console.log(`MAC_SERVER_SMOKE_OK overall=${data.snapshot.overallState} stateText="${data.snapshot.compactStateText}" providers=${data.snapshot.providers.length}`);
      shutdown();
    } catch (err) {
      console.error('MAC_SERVER_SMOKE_FAIL:', err.message);
      process.exit(1);
    }
    return;
  }

  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(SERVER_INFO_FILE, JSON.stringify({ url: baseUrl, pid: process.pid }), 'utf8');
  } catch {}

  pollTimer = setInterval(refreshSnapshot, intervalSec * 1000);
  console.log(`READY ${baseUrl}`);
});
