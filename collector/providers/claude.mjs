import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  STATUS_LABEL,
  formatBytes,
  formatRelSec,
  oneLine,
  parseIsoMs,
  readJsonSafe,
  readTailUtf8,
  toKstShort,
  walkFiles
} from '../utils.mjs';

const CLAUDE_HOME = path.join(os.homedir(), '.claude');

function parseLocalLogTs(tsStr) {
  const m = String(tsStr || '').match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return 0;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
}

function parseUtcSlashTs(tsStr) {
  const m = String(tsStr || '').match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return 0;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

function findClaudeDirs() {
  const home = os.homedir();
  const dataCandidates = [];
  const logCandidates = [];

  if (process.platform === 'darwin') {
    const appSupport = path.join(home, 'Library', 'Application Support', 'Claude');
    dataCandidates.push(appSupport);
    logCandidates.push(path.join(home, 'Library', 'Logs', 'Claude'));
    logCandidates.push(path.join(appSupport, 'logs'));
  } else {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');

    const claudeDataRoot = path.join(localAppData, 'Claude-Data');
    try {
      if (fs.existsSync(claudeDataRoot)) {
        for (const ent of fs.readdirSync(claudeDataRoot, { withFileTypes: true })) {
          if (ent.isDirectory() && /^anthropicpbc\.claude/i.test(ent.name)) {
            dataCandidates.push(path.join(claudeDataRoot, ent.name));
          }
        }
      }
    } catch {
      // Ignore
    }

    dataCandidates.push(path.join(appData, 'Claude'));
    logCandidates.push(path.join(localAppData, 'Claude', 'logs'));
    logCandidates.push(path.join(appData, 'Claude', 'logs'));

    const pkgsDir = path.join(localAppData, 'Packages');
    try {
      if (fs.existsSync(pkgsDir)) {
        for (const ent of fs.readdirSync(pkgsDir, { withFileTypes: true })) {
          if (ent.isDirectory() && /^AnthropicPBC\.Claude_/i.test(ent.name)) {
            const roamingClaude = path.join(pkgsDir, ent.name, 'LocalCache', 'Roaming', 'Claude');
            dataCandidates.push(roamingClaude);
            logCandidates.push(path.join(roamingClaude, 'logs'));
          }
        }
      }
    } catch {
      // Ignore
    }
  }

  const uniqExisting = (arr) => {
    const seen = new Set();
    const out = [];
    for (const p of arr) {
      const norm = path.resolve(p);
      const key = norm.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        if (fs.existsSync(norm)) out.push(norm);
      } catch {
        // Ignore
      }
    }
    return out;
  };

  return {
    dataDirs: uniqExisting(dataCandidates),
    logDirs: uniqExisting(logCandidates)
  };
}

function pickFreshestLogFile(logDirs, filename) {
  let bestPath = null;
  let bestMtime = -1;
  let bestSize = -1;
  for (const dir of logDirs) {
    const fp = path.join(dir, filename);
    let fd = null;
    try {
      fd = fs.openSync(fp, 'r');
      const fst = fs.fstatSync(fd);
      if (fst.mtimeMs > bestMtime || (fst.mtimeMs === bestMtime && fst.size > bestSize)) {
        bestMtime = fst.mtimeMs;
        bestSize = fst.size;
        bestPath = fp;
      }
    } catch {
      // Ignore
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // Ignore
        }
      }
    }
  }
  return bestPath;
}

function readClaudeJsonlTail(filePath) {
  const tail = readTailUtf8(filePath, 65536);
  if (!tail.exists) {
    return {
      exists: false,
      size: 0,
      mtimeMs: 0,
      lastTsMs: 0,
      isTurnEnded: false,
      pendingToolName: '',
      hasError: false,
      summary: ''
    };
  }
  const lines = tail.text.split(/\r?\n/).filter(Boolean);
  if (tail.truncated && lines.length > 1) lines.shift();

  let lastTsMs = 0;
  let isTurnEnded = false;
  let endedDecided = false;
  let pendingToolName = '';
  let hasError = false;
  let summary = '';

  for (let i = lines.length - 1; i >= 0; i--) {
    let o;
    try {
      o = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const ts = parseIsoMs(o.timestamp);
    if (ts && ts > lastTsMs) lastTsMs = ts;

    if (o.type === 'system' && o.subtype === 'stop_hook_summary') {
      if (!endedDecided) {
        isTurnEnded = true;
        endedDecided = true;
      }
    } else if (o.type === 'error' || o.isApiErrorMessage) {
      if (!endedDecided) {
        hasError = true;
        endedDecided = true;
      }
      if (!summary) summary = `오류: ${oneLine(o.error?.message || o.message || 'API/실행 오류', 80)}`;
    } else if (o.type === 'assistant' && o.message) {
      if (!endedDecided) {
        isTurnEnded = o.message.stop_reason === 'end_turn';
        endedDecided = true;
      }
      if (!summary) {
        const content = o.message.content;
        if (Array.isArray(content)) {
          for (let j = content.length - 1; j >= 0; j--) {
            const c = content[j];
            if (!c) continue;
            if (c.type === 'tool_use') {
              pendingToolName = c.name || 'tool';
              summary = `도구 호출(${pendingToolName})`;
              break;
            }
            if (c.type === 'text' && c.text) {
              summary = `${isTurnEnded ? '완료 응답' : '응답 작성'}: ${oneLine(c.text, 82)}`;
              break;
            }
            if (c.type === 'thinking') {
              summary = '추론 진행 중';
              break;
            }
          }
        } else if (typeof content === 'string' && content.trim()) {
          summary = `${isTurnEnded ? '완료 응답' : '응답 작성'}: ${oneLine(content, 82)}`;
        }
      }
    } else if (o.type === 'user' && o.message) {
      if (!endedDecided) {
        isTurnEnded = false;
        endedDecided = true;
      }
      if (!summary) {
        const content = o.message.content;
        const hasToolResult = Array.isArray(content) && content.some(c => c && c.type === 'tool_result');
        summary = hasToolResult ? '도구 실행 결과 수신 후 다음 단계 추론 중' : '사용자 입력 수신 · 응답 대기';
      }
    }

    if (lastTsMs && summary && endedDecided) break;
  }

  return {
    exists: true,
    size: tail.size,
    mtimeMs: tail.mtimeMs,
    lastTsMs: lastTsMs || tail.mtimeMs,
    isTurnEnded,
    pendingToolName,
    hasError,
    summary
  };
}

export function collectClaude(nowMs, proc) {
  const cutoff24h = nowMs - 24 * 3600 * 1000;
  const cutoff30m = nowMs - 30 * 60 * 1000;
  const { dataDirs, logDirs } = findClaudeDirs();

  const desktopCount = proc ? Number(proc.claudeDesktopCount || 0) : 0;
  const cliPids = proc && Array.isArray(proc.claudeCliPids) ? proc.claudeCliPids : [];
  const coworkPids = proc && Array.isArray(proc.coworkSvcPids) ? proc.coworkSvcPids : [];
  const isRunning = desktopCount > 0 || cliPids.length > 0;

  const procParts = [];
  if (desktopCount > 0) procParts.push(`앱 ${desktopCount}`);
  if (coworkPids.length > 0) procParts.push('Cowork VM');
  if (cliPids.length > 0) procParts.push(`CLI ${cliPids.length}`);

  const processState = isRunning ? 'running' : (coworkPids.length > 0 ? 'paused' : 'stopped');
  const processDetail = isRunning
    ? `실행 중 (${procParts.join(', ')})`
    : (coworkPids.length > 0 ? 'VM 서비스 대기 중' : '중지됨');

  // A. Remote Cowork sessionId <-> mounted folders mapping
  const spaceByNormId = new Map();
  const spaceFiles = [];
  for (const dataDir of dataDirs) {
    const lamDir = path.join(dataDir, 'local-agent-mode-sessions');
    spaceFiles.push(...walkFiles(lamDir, 3, new Set(['skills-plugin']), name => name === 'remote-session-spaces.json'));
  }
  spaceFiles.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const sf of spaceFiles) {
    const obj = readJsonSafe(sf.fp);
    if (!obj) continue;
    for (const entry of Array.isArray(obj.entries) ? obj.entries : []) {
      if (!entry || !entry.sessionId) continue;
      const normId = String(entry.sessionId).replace(/^session_/i, '').toLowerCase();
      if (normId) {
        spaceByNormId.set(normId, {
          sessionId: String(entry.sessionId),
          folders: Array.isArray(entry.folders) ? entry.folders : []
        });
      }
    }
  }

  // B. Cached plan usage (5-hour / 7-day) - pick latest per metric from most recent org
  let latestUsage = null;
  for (const dataDir of dataDirs) {
    const obj = readJsonSafe(path.join(dataDir, 'plan-usage-history.json'));
    if (!obj || !Array.isArray(obj.samples)) continue;
    const sorted = [...obj.samples]
      .filter(s => s && typeof s.t === 'number')
      .sort((a, b) => a.t - b.t);
    if (sorted.length === 0) continue;
    const newest = sorted[sorted.length - 1];
    const targetOrg = newest.org || '';
    let fh = newest.u && typeof newest.u.fh === 'number' ? newest.u.fh : null;
    let sd = newest.u && typeof newest.u.sd === 'number' ? newest.u.sd : null;
    let fhTs = fh !== null ? newest.t : 0;
    let sdTs = sd !== null ? newest.t : 0;

    // If newest sample only logged sd (or fh), grab the latest counterpart for same org within 12h
    for (let i = sorted.length - 1; i >= 0; i--) {
      const s = sorted[i];
      if (targetOrg && s.org && s.org !== targetOrg) continue;
      if (newest.t - s.t > 12 * 3600 * 1000) break;
      if (fh === null && s.u && typeof s.u.fh === 'number') {
        fh = s.u.fh;
        fhTs = s.t;
      }
      if (sd === null && s.u && typeof s.u.sd === 'number') {
        sd = s.u.sd;
        sdTs = s.t;
      }
      if (fh !== null && sd !== null) break;
    }

    if (!latestUsage || newest.t > latestUsage.t) {
      latestUsage = { t: newest.t, org: targetOrg, fh, sd, fhTs, sdTs };
    }
  }

  // C. Parse main.log
  const vmSessions = new Map();
  const ensureVmSession = (vmUser) => {
    if (!vmSessions.has(vmUser)) {
      vmSessions.set(vmUser, {
        vmUser,
        lastBashMs: 0,
        mounts: '',
        lastCmdLen: 0,
        bashCount24h: 0,
        bashCount30m: 0,
        spawnCount24h: 0,
        spawnCount30m: 0,
        lastSpawnMs: 0,
        lastCmd: '',
        lastExitMs: 0,
        lastExitCode: null
      });
    }
    return vmSessions.get(vmUser);
  };

  let keepAwake = { active: false, tsMs: 0, claims: '' };
  let mcpErrors30m = 0;
  let lastMcpErrorText = '';

  const mainLogPath = pickFreshestLogFile(logDirs, 'main.log');
  if (mainLogPath) {
    const mainTail = readTailUtf8(mainLogPath, 1572864);
    const lines = mainTail.text.split(/\r?\n/);
    if (mainTail.truncated && lines.length > 1) lines.shift();
    for (const line of lines) {
      const m = line.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+\[(info|warn|error)\]\s+(.+)$/);
      if (!m) continue;
      const tsMs = parseLocalLogTs(m[1]);
      if (!tsMs) continue;
      const level = m[2];
      const rest = m[3];

      if (rest.startsWith('[remote-bash]')) {
        const bm = rest.match(/^\[remote-bash\]\s+vmUser=([^\s]+)\s+mounts=(.*?)\s+cmdLen=(\d+)/);
        if (bm && tsMs >= cutoff24h) {
          const s = ensureVmSession(bm[1]);
          if (tsMs >= s.lastBashMs) {
            s.lastBashMs = tsMs;
            if (bm[2].trim()) s.mounts = bm[2].trim();
            s.lastCmdLen = Number(bm[3]);
          }
          s.bashCount24h++;
          if (tsMs >= cutoff30m) s.bashCount30m++;
        }
      } else if (rest.startsWith('[keep-awake]')) {
        const ks = rest.match(/^\[keep-awake\]\s+started\s+\(id=\d+,\s*claims=([^)]+)\)/);
        if (ks) keepAwake = { active: true, tsMs, claims: ks[1] };
        else if (/^\[keep-awake\]\s+stopped\s+\(id=\d+\)/.test(rest)) keepAwake = { active: false, tsMs, claims: '' };
      } else if (level === 'error' && rest.startsWith('[LocalMcpServerManager]') && tsMs >= cutoff30m) {
        mcpErrors30m++;
        lastMcpErrorText = oneLine(rest, 80);
      }
    }
  }

  // D. Parse coworkd.log
  const activeProcs = new Map();
  let nonZeroExits30m = 0;
  const coworkdPath = pickFreshestLogFile(logDirs, 'coworkd.log');
  if (coworkdPath) {
    const cwTail = readTailUtf8(coworkdPath, 2097152);
    const lines = cwTail.text.split(/\r?\n/);
    if (cwTail.truncated && lines.length > 1) lines.shift();
    for (const line of lines) {
      if (line.includes('[coworkd] starting coworkd')) {
        activeProcs.clear();
        continue;
      }
      let m = line.match(/^(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2})\s+\[process:([^\]]+)\]\s+spawn:\s+name=([^\s]+)\s+cmd=([^\s]+)/);
      if (m) {
        const tsMs = parseUtcSlashTs(m[1]);
        activeProcs.set(m[2], { user: m[3], cmd: m[4], startMs: tsMs, pid: null });
        if (tsMs >= cutoff24h) {
          const s = ensureVmSession(m[3]);
          s.spawnCount24h++;
          if (tsMs >= cutoff30m) s.spawnCount30m++;
          if (tsMs >= s.lastSpawnMs) {
            s.lastSpawnMs = tsMs;
            s.lastCmd = m[4];
          }
        }
        continue;
      }
      m = line.match(/^(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2})\s+\[process:([^\]]+)\]\s+started PID (\d+)/);
      if (m && activeProcs.has(m[2])) {
        activeProcs.get(m[2]).pid = m[3];
        continue;
      }
      m = line.match(/^(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2})\s+\[process:([^\]]+)\]\s+direct child exited:\s+code=(-?\d+)/);
      if (m) {
        const tsMs = parseUtcSlashTs(m[1]);
        const code = Number(m[3]);
        const p = activeProcs.get(m[2]);
        if (p) {
          if (tsMs >= cutoff24h || vmSessions.has(p.user)) {
            const s = ensureVmSession(p.user);
            if (tsMs >= s.lastExitMs) {
              s.lastExitMs = tsMs;
              s.lastExitCode = code;
            }
          }
          if (code !== 0 && tsMs >= cutoff30m) nonZeroExits30m++;
        }
        activeProcs.delete(m[2]);
        continue;
      }
      m = line.match(/^(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2})\s+\[process:([^\]]+)\]\s+all processes exited/);
      if (m) activeProcs.delete(m[2]);
    }
  }

  // E. cowork_vm_node.log
  const vmNodePath = pickFreshestLogFile(logDirs, 'cowork_vm_node.log');
  if (vmNodePath) {
    const vnTail = readTailUtf8(vmNodePath, 524288);
    const lines = vnTail.text.split(/\r?\n/);
    if (vnTail.truncated && lines.length > 1) lines.shift();
    for (const line of lines) {
      const m = line.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+\[info\]\s+\[vmOneShot\]\s+Running:\s+([^\s]+)\s+.*\s+as\s+([^\s]+)/);
      if (!m) continue;
      const tsMs = parseLocalLogTs(m[1]);
      if (tsMs >= cutoff24h) {
        const s = ensureVmSession(m[3]);
        if (tsMs > s.lastSpawnMs) {
          s.lastSpawnMs = tsMs;
          s.lastCmd = m[2];
        }
      }
    }
  }

  const tasks = [];
  const limitReached = Boolean(latestUsage && ((latestUsage.fh ?? 0) >= 100 || (latestUsage.sd ?? 0) >= 100));

  // F. Cowork VM sessions
  for (const s of vmSessions.values()) {
    const normId = s.vmUser.replace(/^rcw-/i, '').toLowerCase();
    const space = spaceByNormId.get(normId);
    const displayId = space ? space.sessionId : s.vmUser;
    const kind = /^rcw-/i.test(s.vmUser) ? '원격 Cowork' : '로컬 Cowork';
    const mounts = s.mounts || (space && space.folders.length ? space.folders.map(f => path.basename(f)).join(', ') : '-');
    const running = [...activeProcs.values()].filter(p => p.user === s.vmUser && p.startMs >= cutoff30m);
    const lastActMs = Math.max(s.lastBashMs || 0, s.lastSpawnMs || 0, s.lastExitMs || 0);
    if (lastActMs < cutoff24h && running.length === 0) continue;

    const idleSec = Math.max(0, Math.floor((nowMs - lastActMs) / 1000));
    let status = 'done';
    let statusDetail = '';

    if (running.length > 0) {
      status = 'running';
      const r0 = running[0];
      const runSec = Math.max(0, Math.floor((nowMs - r0.startMs) / 1000));
      statusDetail = `VM 명령 실행 중 (${r0.cmd}, ${formatRelSec(runSec)})`;
    } else if (s.lastExitCode !== null && s.lastExitCode !== 0 && idleSec <= 1800) {
      status = 'error';
      statusDetail = `VM 명령 오류 종료 (코드 ${s.lastExitCode})`;
    } else if (idleSec <= 300) {
      status = 'running';
      statusDetail = `진행 중 (${formatRelSec(idleSec)})`;
    } else if (keepAwake.active && keepAwake.claims.includes('remote_tools') && idleSec <= 900) {
      status = limitReached ? 'paused' : 'running';
      statusDetail = limitReached ? '한도 도달로 대기 중' : `진행/응답 대기 (keep-awake, ${formatRelSec(idleSec)})`;
    } else if (idleSec <= 1800) {
      status = 'paused';
      statusDetail = `보류/유휴 (${formatRelSec(idleSec)})`;
    } else {
      status = 'done';
      statusDetail = `대기/완료 (${formatRelSec(idleSec)})`;
    }

    const count30m = Math.max(s.spawnCount30m, s.bashCount30m);
    const count24h = Math.max(s.spawnCount24h, s.bashCount24h);
    const sumParts = [`[${kind}] 도구 ${s.lastCmd || 'bash'} (30분 ${count30m}회 · 24시간 ${count24h}회)`];
    if (s.lastCmdLen > 0) sumParts.push(`명령 ${formatBytes(s.lastCmdLen)}`);
    if (s.lastExitCode !== null) sumParts.push(`종료코드 ${s.lastExitCode}`);

    tasks.push({
      id: `vm:${displayId}`,
      shortId: displayId.slice(0, 8),
      providerId: 'claude',
      providerName: 'Claude',
      providerShort: 'Cld',
      providerColor: '#D97757',
      title: `${kind} · ${displayId.slice(0, 14)}`,
      isSubagent: false,
      status,
      statusLabel: STATUS_LABEL[status],
      statusDetail,
      summary: sumParts.join(' | '),
      model: 'Cowork VM',
      cwd: mounts,
      updatedMs: lastActMs
    });
  }

  // G. Desktop Code tab & Local Cowork JSONs + ~/.claude CLI files
  const cliFiles = [
    ...walkFiles(path.join(CLAUDE_HOME, 'projects'), 4, new Set(), name => /\.(jsonl|json)$/i.test(name) && !/\.desktop-released\.json$/i.test(name)),
    ...walkFiles(path.join(CLAUDE_HOME, 'sessions'), 4, new Set(), name => /\.(jsonl|json)$/i.test(name) && !/\.desktop-released\.json$/i.test(name))
  ];
  const cliJsonlById = new Map();
  for (const cf of cliFiles) {
    if (/\.jsonl$/i.test(cf.name)) cliJsonlById.set(path.basename(cf.name, '.jsonl'), cf);
  }

  const linkedCliIds = new Set();
  const seenLocalIds = new Set();
  const localSources = [];
  for (const dataDir of dataDirs) {
    for (const f of walkFiles(path.join(dataDir, 'claude-code-sessions'), 4, new Set(), name => /^local_.*\.json$/i.test(name))) {
      localSources.push({ ...f, kind: 'Code 탭' });
    }
    for (const f of walkFiles(path.join(dataDir, 'local-agent-mode-sessions'), 4, new Set(['skills-plugin']), name => /^local_.*\.json$/i.test(name))) {
      localSources.push({ ...f, kind: '데스크톱 Cowork' });
    }
  }

  for (const lf of localSources) {
    if (lf.size > 2 * 1024 * 1024) continue;
    const d = readJsonSafe(lf.fp);
    if (!d || d.isArchived === true) continue;
    const sid = d.sessionId || path.basename(lf.name, '.json');
    if (seenLocalIds.has(sid)) continue;
    seenLocalIds.add(sid);

    let jsonlTail = null;
    if (d.cliSessionId) {
      linkedCliIds.add(d.cliSessionId);
      const cf = cliJsonlById.get(d.cliSessionId);
      if (cf) jsonlTail = readClaudeJsonlTail(cf.fp);
    }

    const updatedMs = Math.max(
      lf.mtimeMs,
      Number(d.lastActivityAt || 0),
      Number(d.lastTurnEdgeAt || 0),
      jsonlTail ? jsonlTail.lastTsMs : 0,
      jsonlTail ? jsonlTail.mtimeMs : 0
    );
    if (updatedMs < cutoff24h) continue;

    const idleSec = Math.max(0, Math.floor((nowMs - updatedMs) / 1000));
    let isTurnEnded = false;
    if (jsonlTail && jsonlTail.exists) {
      isTurnEnded = jsonlTail.isTurnEnded;
    } else if ((d.postTurnSummary || d.turnWrapUp) && idleSec > 120) {
      isTurnEnded = true;
    }

    const pendingTool = jsonlTail ? jsonlTail.pendingToolName : '';
    const awaitingPerson = Boolean(d.interruptedAwaitingPerson);
    const isAskTool = /AskUserQuestion|ExitPlanMode|permission/i.test(pendingTool);

    let status = 'done';
    let statusDetail = '';

    if (jsonlTail && jsonlTail.hasError) {
      status = 'error';
      statusDetail = '세션 오류 발생';
    } else if (awaitingPerson || (!isTurnEnded && isAskTool && idleSec <= 3600) || (!isTurnEnded && pendingTool && isRunning && idleSec > 15 && idleSec <= 900)) {
      status = 'approval';
      statusDetail = isAskTool ? `사용자 응답/승인 대기 (${pendingTool})` : `도구 승인/입력 대기 (${pendingTool || '확인 필요'})`;
    } else if (!isTurnEnded && limitReached && idleSec <= 1800) {
      status = 'paused';
      statusDetail = '사용량 한도 도달로 대기';
    } else if (!isTurnEnded && idleSec <= 300 && isRunning) {
      status = 'running';
      statusDetail = `진행 중 (${formatRelSec(idleSec)})`;
    } else if (!isTurnEnded && idleSec <= 1800) {
      status = 'paused';
      statusDetail = isRunning ? `보류/유휴 (${formatRelSec(idleSec)})` : `보류 · 앱 미실행 (${formatRelSec(idleSec)})`;
    } else {
      status = 'done';
      statusDetail = isTurnEnded || d.postTurnSummary?.status_category === 'completed' ? '완료' : `대기 (${formatRelSec(idleSec)})`;
    }

    const modelStr = `${d.model || '-'}${d.effort ? ` (${d.effort})` : ''}`;
    const cwdBase = d.cwd ? path.basename(d.cwd) : '';
    const lastSummary = (jsonlTail && jsonlTail.summary)
      || (d.turnWrapUp && d.turnWrapUp.description)
      || (d.postTurnSummary && d.postTurnSummary.status_detail)
      || `[${lf.kind}]`;

    tasks.push({
      id: sid,
      shortId: sid.slice(0, 8),
      providerId: 'claude',
      providerName: 'Claude',
      providerShort: 'Cld',
      providerColor: '#D97757',
      title: d.title || sid,
      isSubagent: false,
      status,
      statusLabel: STATUS_LABEL[status],
      statusDetail,
      summary: lastSummary,
      model: modelStr,
      cwd: cwdBase,
      updatedMs
    });
  }

  // Remaining standalone Claude CLI files
  for (const cf of cliFiles) {
    if (cf.mtimeMs < cutoff24h) continue;
    if (/\.jsonl$/i.test(cf.name)) {
      const stem = path.basename(cf.name, '.jsonl');
      if (linkedCliIds.has(stem)) continue;
      const tail = readClaudeJsonlTail(cf.fp);
      const updatedMs = Math.max(tail.lastTsMs || 0, tail.mtimeMs || cf.mtimeMs);
      if (updatedMs < cutoff24h) continue;
      const idleSec = Math.max(0, Math.floor((nowMs - updatedMs) / 1000));
      const isAskTool = /AskUserQuestion|ExitPlanMode|permission/i.test(tail.pendingToolName || '');

      let status = 'done';
      let statusDetail = '완료';
      if (tail.hasError) {
        status = 'error';
        statusDetail = 'CLI 오류';
      } else if (!tail.isTurnEnded && isAskTool && idleSec <= 3600) {
        status = 'approval';
        statusDetail = `승인/응답 대기 (${tail.pendingToolName})`;
      } else if (!tail.isTurnEnded && idleSec <= 300) {
        status = 'running';
        statusDetail = `CLI 작업 중 (${formatRelSec(idleSec)})`;
      } else if (!tail.isTurnEnded && idleSec <= 1800) {
        status = 'paused';
        statusDetail = `보류/유휴 (${formatRelSec(idleSec)})`;
      }

      tasks.push({
        id: `cli:${stem}`,
        shortId: stem.slice(0, 8),
        providerId: 'claude',
        providerName: 'Claude',
        providerShort: 'Cld',
        providerColor: '#D97757',
        title: `Claude CLI · ${stem.slice(0, 8)}`,
        isSubagent: false,
        status,
        statusLabel: STATUS_LABEL[status],
        statusDetail,
        summary: tail.summary || `${formatBytes(cf.size)}`,
        model: 'Claude CLI',
        cwd: path.basename(path.dirname(cf.fp)),
        updatedMs
      });
    } else if (/\.json$/i.test(cf.name)) {
      const obj = cf.size < 512 * 1024 ? readJsonSafe(cf.fp) : null;
      if (obj && obj.sessionId && (linkedCliIds.has(obj.sessionId) || cliJsonlById.has(obj.sessionId))) continue;
      const idleSec = Math.max(0, Math.floor((nowMs - cf.mtimeMs) / 1000));
      const status = idleSec <= 300 ? 'running' : (idleSec <= 1800 ? 'paused' : 'done');
      tasks.push({
        id: `clijson:${cf.name}`,
        shortId: path.basename(cf.name, '.json').slice(0, 8),
        providerId: 'claude',
        providerName: 'Claude',
        providerShort: 'Cld',
        providerColor: '#D97757',
        title: (obj && (obj.title || obj.sessionId)) || path.basename(cf.name, '.json'),
        isSubagent: false,
        status,
        statusLabel: STATUS_LABEL[status],
        statusDetail: STATUS_LABEL[status],
        summary: obj && obj.cwd ? `작업폴더: ${obj.cwd}` : `세션 파일 (${formatBytes(cf.size)})`,
        model: 'Claude CLI',
        cwd: obj && obj.cwd ? path.basename(obj.cwd) : '',
        updatedMs: cf.mtimeMs
      });
    }
  }

  // Quota summary
  let quota = {
    available: false,
    remainingPct: null,
    usedPct: null,
    primaryLabel: '잔여량',
    primaryValueText: '-',
    secondaryText: '',
    resetText: '',
    planType: '',
    limitReached,
    updatedMs: latestUsage ? latestUsage.t : 0
  };

  if (latestUsage) {
    const fhRem = latestUsage.fh !== null ? Math.max(0, Math.min(100, Math.round(100 - latestUsage.fh))) : null;
    const sdRem = latestUsage.sd !== null ? Math.max(0, Math.min(100, Math.round(100 - latestUsage.sd))) : null;

    // Show the tighter (lower remaining) or primary 5h metric as bar, and put the other in secondaryText
    let priRem = fhRem;
    let priLabel = '5시간 잔여';
    let secText = sdRem !== null ? `7일 ${sdRem}%` : '';

    if (priRem === null && sdRem !== null) {
      priRem = sdRem;
      priLabel = '7일 잔여';
      secText = '';
    } else if (fhRem !== null && sdRem !== null && sdRem < fhRem) {
      priRem = sdRem;
      priLabel = '7일 잔여';
      secText = `5시간 ${fhRem}%`;
    }

    quota = {
      available: priRem !== null,
      remainingPct: priRem,
      usedPct: priRem !== null ? 100 - priRem : null,
      primaryLabel: priLabel,
      primaryValueText: priRem !== null ? `${priRem}%` : '-',
      secondaryText: secText,
      resetText: latestUsage.t ? `${toKstShort(latestUsage.t)} 캐시 기준` : '',
      planType: '',
      limitReached,
      updatedMs: latestUsage.t
    };
  }

  const notes = [];
  if (mcpErrors30m > 0) notes.push(`MCP 오류 ${mcpErrors30m}회 (${lastMcpErrorText})`);
  if (nonZeroExits30m > 0) notes.push(`VM 비정상 종료 ${nonZeroExits30m}회`);

  return {
    provider: {
      id: 'claude',
      name: 'Claude',
      shortName: 'Cld',
      color: '#D97757',
      processState,
      processDetail,
      quota,
      note: notes.join(' · ')
    },
    tasks
  };
}
