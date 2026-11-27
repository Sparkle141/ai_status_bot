import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  // Fallback to sqlite3 CLI on Node versions without node:sqlite
}

export const STATUS_RANK = {
  approval: 5,
  error: 4,
  running: 3,
  paused: 2,
  done: 1,
  idle: 0
};

export const STATUS_LABEL = {
  approval: '승인 대기',
  error: '오류',
  running: '작업 중',
  paused: '보류',
  done: '완료',
  idle: '대기'
};

export function stripLongPrefix(p) {
  return String(p || '').replace(/^\\\\\?\\/, '');
}

export function toKstDate(ms) {
  return new Date((Number(ms) || 0) + 9 * 3600 * 1000);
}

export function toKstString(ms) {
  if (!ms || Number.isNaN(Number(ms))) return '-';
  return toKstDate(ms).toISOString().replace('T', ' ').slice(0, 19);
}

export function toKstShort(ms) {
  if (!ms || Number.isNaN(Number(ms))) return '-';
  return toKstDate(ms).toISOString().replace('T', ' ').slice(5, 16);
}

export function toKstMonthDay(ms) {
  if (!ms || Number.isNaN(Number(ms))) return '-';
  return toKstDate(ms).toISOString().slice(5, 10);
}

export function toKstHour(ms) {
  if (!ms || Number.isNaN(Number(ms))) return '-';
  return toKstDate(ms).toISOString().slice(11, 13);
}

export function nextKstMidnightMs(nowMs = Date.now()) {
  const kst = toKstDate(nowMs);
  const nextUtc = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate() + 1, 0, 0, 0, 0);
  return nextUtc - 9 * 3600 * 1000;
}

export function kstTodayKey(nowMs = Date.now()) {
  return toKstDate(nowMs).toISOString().slice(0, 10);
}

export function parseIsoMs(str) {
  if (!str) return 0;
  if (typeof str === 'number') return str > 1e12 ? str : str * 1000;
  let s = String(str).trim();
  // Normalize SQLite/Go fractional timestamps like "2026-11-26 14:59:38.8345553+00:00"
  s = s.replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1');
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}

export function formatRelSec(sec) {
  let s = Math.floor(Number(sec) || 0);
  if (s < 0) s = 0;
  if (s < 60) return `${s}초 전`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs > 0 ? `${m}분 ${rs}초 전` : `${m}분 전`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm > 0 ? `${h}시간 ${rm}분 전` : `${h}시간 전`;
  const d = Math.floor(h / 24);
  return `${d}일 전`;
}

export function formatRemainingUntil(targetMs, nowMs = Date.now()) {
  const diffSec = Math.floor((Number(targetMs) - Number(nowMs)) / 1000);
  if (!targetMs || Number.isNaN(diffSec) || diffSec <= 0) return '곧 초기화';
  const d = Math.floor(diffSec / 86400);
  const h = Math.floor((diffSec % 86400) / 3600);
  const m = Math.floor((diffSec % 3600) / 60);
  if (d > 0) return `${d}일 ${h}시간 후`;
  if (h > 0) return `${h}시간 ${m}분 후`;
  return `${Math.max(1, m)}분 후`;
}

export function formatDuration(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rs = s % 60;
  if (h > 0) return `${h}시간 ${m}분`;
  if (m > 0) return `${m}분 ${rs}초`;
  return `${rs}초`;
}

export function formatBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b >= 1024 * 1024 * 1024) return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}

export function formatTokens(n) {
  const num = Number(n) || 0;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return `${num}`;
}

export function oneLine(str, maxLen = 100) {
  const s = String(str || '').replace(/\s+/g, ' ').trim();
  return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
}

export function readJsonEnvProc() {
  try {
    if (process.env.AI_PROC_JSON) {
      return JSON.parse(process.env.AI_PROC_JSON);
    }
  } catch {
    // Ignore malformed optional env payload
  }
  return null;
}

export function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function formatSqlParam(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number' || typeof val === 'bigint') return String(val);
  if (typeof val === 'boolean') return val ? '1' : '0';
  return `'${String(val).replace(/'/g, "''")}'`;
}

function bindSqlParams(sql, params) {
  let idx = 0;
  return String(sql).replace(/\?/g, () => (idx < params.length ? formatSqlParam(params[idx++]) : 'NULL'));
}

export function openReadOnlyDb(dbPath) {
  try {
    if (!dbPath || !fs.existsSync(dbPath)) return null;
    if (DatabaseSync) {
      return new DatabaseSync(dbPath, { readOnly: true, readBigInts: true });
    }
    return {
      prepare(sql) {
        return {
          all(...params) {
            try {
              const q = bindSqlParams(sql, params);
              const out = execFileSync('sqlite3', ['-readonly', '-json', dbPath, q], {
                encoding: 'utf8',
                maxBuffer: 10 * 1024 * 1024
              });
              return out && out.trim() ? JSON.parse(out) : [];
            } catch {
              return [];
            }
          },
          get(...params) {
            const rows = this.all(...params);
            return rows.length > 0 ? rows[0] : undefined;
          }
        };
      },
      close() {}
    };
  } catch {
    return null;
  }
}

export function detectMacProcesses() {
  const summary = {
    codexAppCount: 0,
    codexAppServerPids: [],
    codexExecServerPids: [],
    codexCliOtherPids: [],
    claudeDesktopCount: 0,
    claudeCliPids: [],
    coworkSvcPids: [],
    antigravityCount: 0,
    agyCliPids: [],
    languageServerCount: 0,
    otherAiProcs: []
  };
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,comm=,args='], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024
    });
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)\s+(\S+)\s*(.*)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const comm = path.basename(m[2] || '').toLowerCase();
      const args = String(m[3] || '');
      const full = `${comm} ${args}`.toLowerCase();

      if (full.includes('/codex.app/') || comm === 'codex desktop') {
        summary.codexAppCount++;
      } else if (comm === 'codex') {
        if (/\bapp-server\b/.test(args)) summary.codexAppServerPids.push(pid);
        else if (/\bexec-server\b/.test(args)) summary.codexExecServerPids.push(pid);
        else summary.codexCliOtherPids.push(pid);
      } else if (full.includes('/claude.app/')) {
        summary.claudeDesktopCount++;
      } else if (comm === 'claude') {
        summary.claudeCliPids.push(pid);
      } else if (comm === 'coworkd' || comm === 'cowork-svc') {
        summary.coworkSvcPids.push(pid);
      } else if (full.includes('/antigravity.app/') || comm === 'antigravity') {
        summary.antigravityCount++;
      } else if (comm === 'agy') {
        summary.agyCliPids.push(pid);
      } else if (comm.includes('language_server') && full.includes('antigravity')) {
        summary.languageServerCount++;
      } else if (comm === 'cursor' || full.includes('/cursor.app/')) {
        summary.otherAiProcs.push({ name: 'cursor', pid });
      } else if (comm === 'ollama') {
        summary.otherAiProcs.push({ name: 'ollama', pid });
      } else if (full.includes('/lm studio.app/') || comm === 'lm-studio') {
        summary.otherAiProcs.push({ name: 'lm-studio', pid });
      } else if (comm === 'windsurf' || full.includes('/windsurf.app/')) {
        summary.otherAiProcs.push({ name: 'windsurf', pid });
      } else if (comm === 'gemini') {
        summary.otherAiProcs.push({ name: 'gemini', pid });
      } else if (comm === 'aider') {
        summary.otherAiProcs.push({ name: 'aider', pid });
      } else if (comm === 'opencode') {
        summary.otherAiProcs.push({ name: 'opencode', pid });
      }
    }
  } catch {
    // Ignore ps lookup error
  }
  return summary;
}

export function readTailUtf8(filePath, maxBytes = 65536) {
  const cleanPath = stripLongPrefix(filePath);
  if (!cleanPath) {
    return { exists: false, size: 0, mtimeMs: 0, text: '', truncated: false };
  }
  let fd = null;
  try {
    fd = fs.openSync(cleanPath, 'r');
    const fst = fs.fstatSync(fd);
    const readBytes = Math.min(fst.size, maxBytes);
    let text = '';
    if (readBytes > 0) {
      const buf = Buffer.alloc(readBytes);
      fs.readSync(fd, buf, 0, readBytes, fst.size - readBytes);
      text = buf.toString('utf8');
    }
    return {
      exists: true,
      size: fst.size,
      mtimeMs: fst.mtimeMs,
      text,
      truncated: fst.size > readBytes
    };
  } catch {
    return { exists: false, size: 0, mtimeMs: 0, text: '', truncated: false };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close error
      }
    }
  }
}

export function walkFiles(rootDir, maxDepth, skipDirNames, fileFilter) {
  const results = [];
  function walk(dir, depth) {
    if (depth > maxDepth || !dir) return;
    let entries;
    try {
      if (!fs.existsSync(dir)) return;
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (skipDirNames && skipDirNames.has(ent.name)) continue;
        walk(path.join(dir, ent.name), depth + 1);
      } else if (!fileFilter || fileFilter(ent.name)) {
        const fp = path.join(dir, ent.name);
        try {
          const st = fs.statSync(fp);
          results.push({ fp, name: ent.name, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          // Ignore stat error
        }
      }
    }
  }
  walk(rootDir, 0);
  return results;
}

export function normalizeStatus(rawStatus) {
  const s = String(rawStatus || '').toLowerCase().trim();
  if (s === 'approval' || s === 'waiting' || s === 'waiting_approval' || s === '승인대기' || s === '승인 대기') return 'approval';
  if (s === 'error' || s === 'failed' || s === '오류') return 'error';
  if (s === 'running' || s === 'active' || s === 'working' || s === '작업중' || s === '작업 중' || s === '진행중') return 'running';
  if (s === 'paused' || s === 'hold' || s === 'throttled' || s === '보류' || s === '대기') return 'paused';
  if (s === 'done' || s === 'completed' || s === 'complete' || s === '완료') return 'done';
  return 'idle';
}
