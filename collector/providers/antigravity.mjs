import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  STATUS_LABEL,
  formatRelSec,
  formatTokens,
  kstTodayKey,
  oneLine,
  openReadOnlyDb,
  parseIsoMs,
  readTailUtf8,
  toKstDate
} from '../utils.mjs';

const AG_ROOT = path.join(os.homedir(), '.gemini', 'antigravity');

function inspectTranscriptTail(convId, todayKey) {
  const tp = path.join(AG_ROOT, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
  const tail = readTailUtf8(tp, 131072);
  if (!tail.exists) {
    return {
      exists: false,
      lastStatus: '',
      lastType: '',
      lastModel: '',
      lastToolName: '',
      needsApproval: false,
      summary: '',
      todayTokens: 0,
      lastTsMs: 0
    };
  }

  const lines = tail.text.split(/\r?\n/).filter(Boolean);
  if (tail.truncated && lines.length > 1) lines.shift();

  let lastStatus = '';
  let lastType = '';
  let lastModel = '';
  let lastToolName = '';
  let needsApproval = false;
  let summary = '';
  let todayTokens = 0;
  let lastTsMs = 0;
  let sawUserAfterPlanner = false;

  for (let i = lines.length - 1; i >= 0; i--) {
    let o;
    try {
      o = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    const tsMs = parseIsoMs(o.created_at);
    if (tsMs && tsMs > lastTsMs) lastTsMs = tsMs;

    if (tsMs && toKstDate(tsMs).toISOString().slice(0, 10) === todayKey) {
      const inp = Number(o.input_tokens || 0);
      const out = Number(o.output_tokens || 0);
      if (inp > 0 || out > 0) todayTokens += inp + out;
    }

    if (!lastModel && o.model) lastModel = String(o.model);
    if (!lastType && o.type) lastType = String(o.type);
    if (!lastStatus && o.status) lastStatus = String(o.status);

    if (o.type === 'USER_INPUT' && !summary) {
      sawUserAfterPlanner = true;
    }

    if (!summary) {
      if (o.type === 'PLANNER_RESPONSE') {
        const calls = Array.isArray(o.tool_calls) ? o.tool_calls : [];
        if (calls.length > 0) {
          const lastCall = calls[calls.length - 1];
          const toolName = String(lastCall.name || lastCall.tool_name || 'tool');
          lastToolName = toolName;
          const args = lastCall.arguments || lastCall.args || {};
          const reqFeedback = args && (args.RequestFeedback === true || args.requestFeedback === true);
          if (!sawUserAfterPlanner && (toolName === 'ask_question' || toolName === 'enter_plan_mode' || reqFeedback)) {
            needsApproval = true;
          }
          summary = `도구 실행(${toolName})`;
        } else if (o.content) {
          summary = `응답: ${oneLine(o.content, 82)}`;
        } else if (o.thinking) {
          summary = `추론: ${oneLine(o.thinking, 82)}`;
        }
      } else if (o.type === 'USER_INPUT') {
        summary = `사용자 입력: ${oneLine(o.content || '', 80)}`;
      } else if (o.type === 'GENERIC' && o.content && !/^(Created At:|Completed At:|Command exited|Showing lines|The tool's output)/i.test(String(o.content).trim())) {
        summary = oneLine(o.content, 82);
      }
    }
  }

  return {
    exists: true,
    lastStatus,
    lastType,
    lastModel,
    lastToolName,
    needsApproval,
    summary,
    todayTokens,
    lastTsMs: lastTsMs || tail.mtimeMs
  };
}

function decodeWorkspaceName(workspaceUris) {
  try {
    const arr = JSON.parse(workspaceUris || '[]');
    if (Array.isArray(arr) && arr.length > 0) {
      const decoded = decodeURIComponent(String(arr[0]).replace(/^file:\/\/\//i, ''));
      return path.basename(decoded);
    }
  } catch {
    // Ignore
  }
  return '';
}

export function collectAntigravity(nowMs, proc) {
  const cutoff24h = nowMs - 24 * 3600 * 1000;
  const todayKey = kstTodayKey(nowMs);

  const agCount = proc ? Number(proc.antigravityCount || 0) : 0;
  const agyCliPids = proc && Array.isArray(proc.agyCliPids) ? proc.agyCliPids : [];
  const lsCount = proc ? Number(proc.languageServerCount || 0) : 0;
  const isRunning = agCount > 0 || agyCliPids.length > 0 || lsCount > 0;

  const procParts = [];
  if (agCount > 0) procParts.push(`앱 ${agCount}`);
  if (lsCount > 0) procParts.push('언어서버');
  if (agyCliPids.length > 0) procParts.push(`CLI ${agyCliPids.length}`);

  const tasks = [];
  let totalTodayTokens = 0;
  let activeModel = '';

  const db = openReadOnlyDb(path.join(AG_ROOT, 'conversation_summaries.db'));
  if (db) {
    try {
      const rows = db.prepare(`
        SELECT conversation_id, title, preview, step_count, last_modified_time, status, not_fully_idle, killed, parent_conversation_id, workspace_uris
        FROM conversation_summaries
        ORDER BY last_modified_time DESC
        LIMIT 20
      `).all();

      for (const r of rows) {
        const modMs = parseIsoMs(r.last_modified_time);
        const tail = inspectTranscriptTail(r.conversation_id, todayKey);
        totalTodayTokens += tail.todayTokens;
        if (!activeModel && tail.lastModel) activeModel = tail.lastModel;

        const updatedMs = Math.max(modMs, tail.lastTsMs || 0);
        if (updatedMs < cutoff24h && String(r.status || '') === 'CASCADE_RUN_STATUS_IDLE') continue;

        const idleSec = Math.max(0, Math.floor((nowMs - updatedMs) / 1000));
        const rawStatus = String(r.status || '');
        const notFullyIdle = Number(r.not_fully_idle || 0) === 1;
        const killed = Number(r.killed || 0) === 1;
        const stepCount = Number(r.step_count || 0);

        let status = 'done';
        let statusDetail = '';

        if (killed || /ERROR|FAILED/i.test(rawStatus) || tail.lastStatus === 'ERROR') {
          status = 'error';
          statusDetail = killed ? '강제 종료/오류' : '실행 오류';
        } else if (/WAITING/i.test(rawStatus) || ((rawStatus === 'CASCADE_RUN_STATUS_RUNNING' || notFullyIdle) && tail.needsApproval)) {
          status = 'approval';
          statusDetail = tail.lastToolName ? `승인/입력 대기 (${tail.lastToolName})` : '승인/입력 대기';
        } else if (/PAUSE|CANCEL/i.test(rawStatus)) {
          status = 'paused';
          statusDetail = `보류 (${formatRelSec(idleSec)})`;
        } else if (rawStatus === 'CASCADE_RUN_STATUS_RUNNING' || tail.lastStatus === 'RUNNING') {
          if (idleSec > 300) {
            status = 'paused';
            statusDetail = `응답 지연/보류 (${formatRelSec(idleSec)})`;
          } else {
            status = 'running';
            statusDetail = `작업 중 · ${stepCount}단계 (${formatRelSec(idleSec)})`;
          }
        } else if (notFullyIdle) {
          status = idleSec <= 300 ? 'running' : 'paused';
          statusDetail = idleSec <= 300 ? `마무리 중 (${formatRelSec(idleSec)})` : `유휴/보류 (${formatRelSec(idleSec)})`;
        } else {
          status = 'done';
          statusDetail = `완료 · ${stepCount}단계`;
        }

        const title = oneLine(r.title || r.preview || r.conversation_id.slice(0, 8), 54);
        const wsName = decodeWorkspaceName(r.workspace_uris);

        tasks.push({
          id: r.conversation_id,
          shortId: r.conversation_id.slice(0, 8),
          providerId: 'antigravity',
          providerName: 'Antigravity',
          providerShort: 'Agy',
          providerColor: '#4285F4',
          title,
          isSubagent: Boolean(r.parent_conversation_id),
          status,
          statusLabel: STATUS_LABEL[status],
          statusDetail,
          summary: tail.summary || oneLine(r.preview || '-', 82),
          model: tail.lastModel || 'Gemini (Antigravity)',
          cwd: wsName,
          updatedMs
        });
      }
    } catch {
      // Ignore transient DB errors
    } finally {
      db.close();
    }
  }

  const quota = {
    available: false,
    remainingPct: null,
    usedPct: null,
    primaryLabel: '오늘 누적 토큰',
    primaryValueText: totalTodayTokens > 0 ? formatTokens(totalTodayTokens) : '-',
    secondaryText: activeModel ? oneLine(activeModel, 22) : '',
    resetText: '로컬 잔여% 미제공 · 토큰 집계',
    planType: '',
    limitReached: false,
    updatedMs: nowMs
  };

  return {
    provider: {
      id: 'antigravity',
      name: 'Antigravity',
      shortName: 'Agy',
      color: '#4285F4',
      processState: isRunning ? 'running' : 'stopped',
      processDetail: isRunning ? `실행 중 (${procParts.join(', ')})` : '중지됨',
      quota,
      note: ''
    },
    tasks
  };
}
