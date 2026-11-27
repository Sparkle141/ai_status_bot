import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  STATUS_LABEL,
  formatDuration,
  formatRelSec,
  formatRemainingUntil,
  oneLine,
  openReadOnlyDb,
  parseIsoMs,
  readTailUtf8,
  stripLongPrefix,
  toKstShort
} from '../utils.mjs';

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

function formatWindowLabel(minutes) {
  const m = Number(minutes) || 0;
  if (m === 10080) return '7일';
  if (m === 300) return '5시간';
  if (m >= 1440 && m % 1440 === 0) return `${m / 1440}일`;
  if (m >= 60) return `${Math.round(m / 60)}시간`;
  return m > 0 ? `${m}분` : '한도';
}

function isApprovalLikeName(name) {
  return /approval|request_user_input|elicitation|ask_user|confirm/i.test(String(name || ''));
}

function readRolloutTail(rolloutPath) {
  const cleanPath = stripLongPrefix(rolloutPath);
  if (!cleanPath || !fs.existsSync(cleanPath)) {
    return {
      exists: false,
      size: 0,
      mtimeMs: 0,
      lastSemantic: null,
      lastAnyMs: 0,
      rateLimits: null,
      rateLimitsTsMs: 0,
      contextPct: null,
      pendingApprovalSummary: null
    };
  }

  let st;
  try {
    st = fs.statSync(cleanPath);
  } catch {
    return {
      exists: false,
      size: 0,
      mtimeMs: 0,
      lastSemantic: null,
      lastAnyMs: 0,
      rateLimits: null,
      rateLimitsTsMs: 0,
      contextPct: null,
      pendingApprovalSummary: null
    };
  }

  let lastSemantic = null;
  let lastAnyMs = 0;
  let rateLimits = null;
  let rateLimitsTsMs = 0;
  let contextPct = null;
  let pendingApprovalSummary = null;
  let sawCompletionOrAbort = false;

  for (const chunkLimit of [65536, 262144]) {
    const tail = readTailUtf8(cleanPath, chunkLimit);
    if (!tail.exists) break;
    const lines = tail.text.split(/\r?\n/).filter(Boolean);
    if (tail.truncated && lines.length > 1) lines.shift();

    for (let i = lines.length - 1; i >= 0; i--) {
      let obj;
      try {
        obj = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      const tsMs = parseIsoMs(obj.timestamp);
      if (tsMs && tsMs > lastAnyMs) lastAnyMs = tsMs;

      const p = obj.payload || {};
      const pt = p.type || '';

      if (obj.type === 'event_msg' && pt === 'token_count') {
        if (!rateLimits && p.rate_limits) {
          rateLimits = p.rate_limits;
          rateLimitsTsMs = tsMs || tail.mtimeMs;
        }
        if (contextPct === null && p.info && p.info.model_context_window && p.info.last_token_usage) {
          const win = Number(p.info.model_context_window);
          const inp = Number(p.info.last_token_usage.input_tokens || 0);
          if (win > 0 && inp >= 0) {
            contextPct = Math.min(100, Math.round((inp / win) * 100));
          }
        }
        continue;
      }

      if (obj.type === 'token_usage_record') {
        continue;
      }

      if (!lastSemantic) {
        let summary = '';
        let isError = false;
        let isApproval = false;

        if (pt === 'task_complete') {
          sawCompletionOrAbort = true;
          summary = `완료: ${oneLine(p.last_agent_message || '', 88)}`;
        } else if (pt === 'turn_aborted') {
          sawCompletionOrAbort = true;
          const reason = String(p.reason || 'unknown');
          isError = /\b(err|error|fail|failed|failure|timeout|limit|crash|exception|network|socket|disconnect)\b/i.test(reason);
          summary = isError ? `오류 중단(${reason})` : `사용자/시스템 중단(${reason})`;
        } else if (isApprovalLikeName(pt) || (pt === 'function_call' && isApprovalLikeName(p.name)) || (pt === 'custom_tool_call' && isApprovalLikeName(p.name))) {
          isApproval = true;
          const detail = p.prompt || p.question || p.command || p.input || p.arguments || '';
          summary = `승인/응답 대기: ${oneLine(detail || p.name || pt, 82)}`;
          pendingApprovalSummary = summary;
        } else if (pt === 'item_completed' || pt === 'item_started') {
          const it = p.item || {};
          if (it.type === 'CommandExecution') {
            const cmd = Array.isArray(it.command) ? it.command.join(' ') : String(it.command || '');
            summary = `명령 실행: ${oneLine(cmd, 82)}`;
          } else if (it.type === 'Reasoning') {
            summary = '추론 단계 진행';
          } else {
            summary = `${it.type || '항목'}: ${oneLine(it.text || it.name || '', 78)}`;
          }
        } else if (pt === 'reasoning') {
          const sArr = Array.isArray(p.summary) ? p.summary.map(x => x.text || '').filter(Boolean) : [];
          summary = sArr.length ? `추론: ${oneLine(sArr.join(' / '), 82)}` : '추론 진행 중';
        } else if (pt === 'custom_tool_call' || pt === 'function_call') {
          summary = `도구 호출(${p.name || 'tool'}): ${oneLine(p.input || p.arguments || '', 72)}`;
        } else if (pt === 'custom_tool_call_output' || pt === 'function_call_output') {
          summary = '도구 결과 수신 후 다음 단계 추론 중';
        } else if (pt === 'message' && p.role === 'assistant') {
          const txt = Array.isArray(p.content) ? p.content.map(c => c.text || '').join(' ') : String(p.content || '');
          summary = `응답 작성: ${oneLine(txt, 82)}`;
        } else if (pt === 'agent_message') {
          summary = `메시지: ${oneLine(p.message || p.text || '', 82)}`;
        } else if (pt === 'task_started') {
          summary = '작업 시작됨';
        } else {
          summary = `${obj.type}/${pt || 'event'}`;
        }

        lastSemantic = {
          type: obj.type,
          payloadType: pt,
          tsMs,
          summary,
          isError,
          isApproval,
          sawCompletionOrAbort
        };
      }

      if (lastSemantic && rateLimits && contextPct !== null) break;
    }

    if ((lastSemantic && rateLimits) || readTailBytesDone(st.size, chunkLimit)) break;
  }

  return {
    exists: true,
    size: st.size,
    mtimeMs: st.mtimeMs,
    lastSemantic,
    lastAnyMs,
    rateLimits,
    rateLimitsTsMs,
    contextPct,
    pendingApprovalSummary
  };
}

function readTailBytesDone(size, limit) {
  return limit >= size;
}

function getLogSignals(nowSec) {
  const retryByThread = new Map();
  const latestActivityByThread = new Map();
  const approvalReqByThread = new Map();
  const toolErrorByThread = new Map();
  const extraThreads = new Map();
  let recentCapRetries30m = 0;
  let recentToolErrors30m = 0;

  const dbL = openReadOnlyDb(path.join(CODEX_HOME, 'logs_2.sqlite'));
  if (!dbL) {
    return { retryByThread, latestActivityByThread, approvalReqByThread, toolErrorByThread, extraThreads, recentCapRetries30m, recentToolErrors30m };
  }

  try {
    const cutoff30 = nowSec - 1800;
    const cutoff6h = nowSec - 6 * 3600;

    const retryRows30 = dbL.prepare(
      `SELECT feedback_log_body FROM logs WHERE ts >= ? AND target = 'codex_core::responses_retry'`
    ).all(cutoff30);
    for (const r of retryRows30) {
      if (/Selected model is at capacity/i.test(r.feedback_log_body || '')) recentCapRetries30m++;
    }

    const errRow30 = dbL.prepare(
      `SELECT COUNT(*) AS c FROM logs WHERE ts >= ? AND upper(level) = 'ERROR' AND target = 'codex_core::tools::router'`
    ).get(cutoff30);
    recentToolErrors30m = errRow30 ? Number(errRow30.c) : 0;

    const latestRetries = dbL.prepare(`
      SELECT l.thread_id, l.ts, l.feedback_log_body
      FROM logs l
      INNER JOIN (
        SELECT thread_id, MAX(id) AS max_id
        FROM logs
        WHERE ts >= ? AND target = 'codex_core::responses_retry' AND thread_id IS NOT NULL
        GROUP BY thread_id
      ) m ON l.id = m.max_id
    `).all(cutoff6h);

    for (const r of latestRetries) {
      const body = String(r.feedback_log_body || '');
      const matchDelay = body.match(/retrying sampling request \((\d+)\/(\d+)\s+in\s+([\d.]+)s\)/i);
      const matchErr = body.match(/(?:sampling_error|error)=([^\r\n]+)/i);
      const delaySec = matchDelay ? Number(matchDelay[3]) : 0;
      const ts = Number(r.ts);
      retryByThread.set(r.thread_id, {
        ts,
        retryNum: matchDelay ? Number(matchDelay[1]) : 1,
        maxRetries: matchDelay ? Number(matchDelay[2]) : 5,
        delaySec,
        retryAtSec: ts + delaySec,
        errorText: matchErr ? matchErr[1].trim() : 'retry',
        isCapacity: /Selected model is at capacity/i.test(body)
      });
    }

    const latestActs = dbL.prepare(`
      SELECT thread_id, MAX(ts) AS max_ts
      FROM logs
      WHERE ts >= ? AND thread_id IS NOT NULL AND (
        (target = 'codex_api::endpoint::responses_websocket' AND feedback_log_body LIKE '%status=101%')
        OR target = 'codex_core::session::turn'
      )
      GROUP BY thread_id
    `).all(cutoff6h);
    for (const r of latestActs) {
      latestActivityByThread.set(r.thread_id, Number(r.max_ts));
    }

    // Guardian / explicit approval requests in last 6h
    const latestApprovals = dbL.prepare(`
      SELECT thread_id, MAX(ts) AS max_ts
      FROM logs
      WHERE ts >= ? AND thread_id IS NOT NULL AND (
        target = 'codex_core::guardian::review::request'
        OR feedback_log_body LIKE '%exec_approval%'
        OR feedback_log_body LIKE '%request_user_input%'
      )
      GROUP BY thread_id
    `).all(cutoff6h);
    for (const r of latestApprovals) {
      approvalReqByThread.set(r.thread_id, Number(r.max_ts));
    }

    // Recent tool errors per thread (last 30m)
    const latestToolErrs = dbL.prepare(`
      SELECT l.thread_id, l.ts, l.feedback_log_body
      FROM logs l
      INNER JOIN (
        SELECT thread_id, MAX(id) AS max_id
        FROM logs
        WHERE ts >= ? AND upper(level) = 'ERROR' AND target = 'codex_core::tools::router' AND thread_id IS NOT NULL
        GROUP BY thread_id
      ) m ON l.id = m.max_id
    `).all(cutoff30);
    for (const r of latestToolErrs) {
      toolErrorByThread.set(r.thread_id, { ts: Number(r.ts), body: oneLine(r.feedback_log_body, 90) });
    }

    // Internal / ephemeral threads (e.g. ambient-suggestions) in last 30m
    const recentLogThreads = dbL.prepare(`
      SELECT l.thread_id, MAX(l.ts) AS max_ts, l.feedback_log_body
      FROM logs l
      WHERE l.ts >= ? AND l.thread_id IS NOT NULL AND l.target = 'feedback_tags' AND l.feedback_log_body LIKE '%model=%'
      GROUP BY l.thread_id
    `).all(cutoff30);
    for (const r of recentLogThreads) {
      const mModel = String(r.feedback_log_body || '').match(/model="([^"]+)"/);
      const mEffort = String(r.feedback_log_body || '').match(/effort=Some\(([^)]+)\)/);
      extraThreads.set(r.thread_id, {
        lastTs: Number(r.max_ts),
        model: mModel ? mModel[1] : 'unknown',
        effort: mEffort ? mEffort[1].toLowerCase() : ''
      });
    }
  } catch {
    // Ignore transient SQLite read error
  } finally {
    dbL.close();
  }

  return { retryByThread, latestActivityByThread, approvalReqByThread, toolErrorByThread, extraThreads, recentCapRetries30m, recentToolErrors30m };
}

function getGoalsMap() {
  const goals = new Map();
  const dbG = openReadOnlyDb(path.join(CODEX_HOME, 'goals_1.sqlite'));
  if (!dbG) return goals;
  try {
    const rows = dbG.prepare(`SELECT thread_id, objective, status, tokens_used, time_used_seconds, updated_at_ms FROM thread_goals`).all();
    for (const r of rows) {
      goals.set(r.thread_id, {
        thread_id: r.thread_id,
        objective: r.objective,
        status: r.status,
        tokens_used: Number(r.tokens_used || 0),
        time_used_seconds: Number(r.time_used_seconds || 0),
        updated_at_ms: Number(r.updated_at_ms || 0)
      });
    }
  } catch {
    // Ignore transient lock
  } finally {
    dbG.close();
  }
  return goals;
}

export function collectCodex(nowMs, proc) {
  const nowSec = Math.floor(nowMs / 1000);
  const cutoff24h = nowSec - 86400;

  const appCount = proc ? Number(proc.codexAppCount || 0) : 0;
  const appServerPids = proc && Array.isArray(proc.codexAppServerPids) ? proc.codexAppServerPids : [];
  const execServerPids = proc && Array.isArray(proc.codexExecServerPids) ? proc.codexExecServerPids : [];
  const cliPids = proc && Array.isArray(proc.codexCliOtherPids) ? proc.codexCliOtherPids : [];

  const isProcessRunning = appCount > 0 || appServerPids.length > 0 || execServerPids.length > 0 || cliPids.length > 0;
  const procParts = [];
  if (appCount > 0) procParts.push(`앱 ${appCount}`);
  if (appServerPids.length > 0) procParts.push(`server ${appServerPids.length}`);
  if (cliPids.length > 0) procParts.push(`CLI ${cliPids.length}`);

  const goalsMap = getGoalsMap();
  const { retryByThread, latestActivityByThread, approvalReqByThread, toolErrorByThread, extraThreads, recentCapRetries30m } = getLogSignals(nowSec);

  const tasks = [];
  const knownThreadIds = new Set();
  let newestRateLimits = null;
  let newestRateLimitsMs = 0;

  const dbS = openReadOnlyDb(path.join(CODEX_HOME, 'state_5.sqlite'));
  if (dbS) {
    try {
      const rows = dbS.prepare(`
        SELECT id, name, title, first_user_message, agent_nickname, agent_role, updated_at, updated_at_ms, rollout_path, source, tokens_used, model, reasoning_effort, archived, approval_mode, cwd
        FROM threads
        WHERE updated_at >= ?
        ORDER BY updated_at DESC
        LIMIT 30
      `).all(cutoff24h);

      for (const t of rows) {
        knownThreadIds.add(t.id);
        if (String(t.source || '').includes('guardian')) continue;

        const tail = readRolloutTail(t.rollout_path);
        if (tail.rateLimits && tail.rateLimitsTsMs >= newestRateLimitsMs) {
          newestRateLimits = tail.rateLimits;
          newestRateLimitsMs = tail.rateLimitsTsMs;
        }

        const updatedAtSec = Number(t.updated_at || 0);
        const updatedAtMsCol = Number(t.updated_at_ms || 0);
        const goal = goalsMap.get(t.id);
        const retry = retryByThread.get(t.id);
        const lastLogActTs = latestActivityByThread.get(t.id) || 0;
        const lastRolloutSec = Math.floor((tail.lastAnyMs || tail.mtimeMs || updatedAtMsCol || updatedAtSec * 1000) / 1000);
        const lastActSec = Math.max(lastLogActTs, lastRolloutSec);
        const idleSec = Math.max(0, nowSec - lastActSec);

        const pt = tail.lastSemantic ? tail.lastSemantic.payloadType : '';
        const approvalTs = approvalReqByThread.get(t.id) || 0;
        const toolErr = toolErrorByThread.get(t.id);
        const isTerminal = pt === 'task_complete' || pt === 'turn_aborted';

        let status = 'running';
        let statusDetail = '';

        if (tail.lastSemantic && tail.lastSemantic.isApproval && !isTerminal) {
          status = 'approval';
          statusDetail = '승인/사용자 입력 대기';
        } else if (!isTerminal && approvalTs > lastRolloutSec && (nowSec - approvalTs) <= 3600) {
          status = 'approval';
          statusDetail = '승인 요청 확인 필요';
        } else if (pt === 'turn_aborted') {
          if (tail.lastSemantic && tail.lastSemantic.isError) {
            status = 'error';
            statusDetail = tail.lastSemantic.summary;
          } else {
            status = 'done';
            statusDetail = '중단됨';
          }
        } else if (pt === 'task_complete') {
          status = 'done';
          statusDetail = '완료';
        } else if (!isTerminal && newestRateLimits && newestRateLimits.rate_limit_reached_type && idleSec <= 1800) {
          status = 'error';
          statusDetail = `한도 도달 (${newestRateLimits.rate_limit_reached_type})`;
        } else if (!isTerminal && toolErr && toolErr.ts >= lastRolloutSec - 2 && idleSec <= 600) {
          status = 'error';
          statusDetail = `도구 오류 (${formatRelSec(nowSec - toolErr.ts)})`;
        } else if (retry && retry.ts >= lastActSec - 2 && !isTerminal) {
          const rem = Math.round(retry.retryAtSec - nowSec);
          if (retry.isCapacity) {
            status = 'paused';
            statusDetail = rem > 0
              ? `용량 대기 (~${rem}초 후 ${retry.retryNum}/${retry.maxRetries} 재시도)`
              : `재연결/응답 대기 (${retry.retryNum}/${retry.maxRetries})`;
          } else if (retry.retryNum >= retry.maxRetries && rem <= 0) {
            status = 'error';
            statusDetail = `재시도 한도 초과 (${oneLine(retry.errorText, 50)})`;
          } else {
            status = 'paused';
            statusDetail = rem > 0
              ? `재시도 대기 (~${rem}초 후 ${retry.retryNum}/${retry.maxRetries})`
              : `재연결 대기 (${retry.retryNum}/${retry.maxRetries})`;
          }
        } else if (!isProcessRunning && !isTerminal) {
          status = 'paused';
          statusDetail = `보류 · 앱 미실행 (${formatRelSec(idleSec)})`;
        } else if (idleSec > 300) {
          status = 'paused';
          statusDetail = `보류/유휴 (${formatRelSec(idleSec)})`;
        } else {
          status = 'running';
          statusDetail = `작업 중 (${formatRelSec(idleSec)})`;
        }

        const isSubagent = String(t.source || '').includes('subagent');
        const subNick = t.agent_nickname ? `${t.agent_nickname}${t.agent_role ? `(${t.agent_role})` : ''}` : '';
        const rawTitle = t.name || oneLine(t.title, 48) || (subNick ? `${subNick}: ${oneLine(t.first_user_message || '', 36)}` : oneLine(t.first_user_message, 48)) || '(제목 없음)';
        const updatedMs = Math.max(tail.mtimeMs || 0, tail.lastAnyMs || 0, updatedAtMsCol || updatedAtSec * 1000);
        const goalTxt = goal && goal.status === 'active' ? ` · /goal ${formatDuration(goal.time_used_seconds)}` : '';
        const ctxTxt = tail.contextPct !== null ? ` · 컨텍스트 ${tail.contextPct}%` : '';

        tasks.push({
          id: t.id,
          shortId: t.id.slice(0, 8),
          providerId: 'codex',
          providerName: 'Codex',
          providerShort: 'Cdx',
          providerColor: '#10A37F',
          title: rawTitle,
          isSubagent,
          status,
          statusLabel: STATUS_LABEL[status],
          statusDetail: `${statusDetail}${goalTxt}`,
          summary: `${tail.lastSemantic ? tail.lastSemantic.summary : (oneLine(t.title, 70) || '-')}${ctxTxt}`,
          model: `${t.model || '-'}${t.reasoning_effort ? ` (${t.reasoning_effort})` : ''}`,
          cwd: t.cwd ? path.basename(stripLongPrefix(t.cwd)) : '',
          updatedMs
        });
      }
    } catch {
      // Ignore transient DB errors
    } finally {
      dbS.close();
    }
  }

  // Fallback: if no recent threads had rate_limits, check latest 5 threads overall
  if (!newestRateLimits && dbS === null) {
    // Handled below
  }
  if (!newestRateLimits) {
    const dbFallback = openReadOnlyDb(path.join(CODEX_HOME, 'state_5.sqlite'));
    if (dbFallback) {
      try {
        const rows = dbFallback.prepare(`SELECT rollout_path FROM threads ORDER BY updated_at DESC LIMIT 6`).all();
        for (const r of rows) {
          const tail = readRolloutTail(r.rollout_path);
          if (tail.rateLimits && tail.rateLimitsTsMs >= newestRateLimitsMs) {
            newestRateLimits = tail.rateLimits;
            newestRateLimitsMs = tail.rateLimitsTsMs;
            break;
          }
        }
      } catch {
        // Ignore
      } finally {
        dbFallback.close();
      }
    }
  }

  // Internal/ephemeral Codex threads active in last 10m
  for (const [tid, info] of extraThreads.entries()) {
    if (knownThreadIds.has(tid)) continue;
    const retry = retryByThread.get(tid);
    const lastAct = Math.max(info.lastTs, latestActivityByThread.get(tid) || 0);
    if (nowSec - lastAct > 600) continue;
    let status = 'running';
    let detail = '내부 백그라운드 작업 중';
    if (retry && retry.ts >= lastAct - 2) {
      const rem = Math.round(retry.retryAtSec - nowSec);
      status = 'paused';
      detail = rem > 0 ? `용량 대기 (~${rem}초)` : '재연결 대기';
    }
    tasks.push({
      id: tid,
      shortId: tid.slice(0, 8),
      providerId: 'codex',
      providerName: 'Codex',
      providerShort: 'Cdx',
      providerColor: '#10A37F',
      title: `백그라운드 자동 작업 (${tid.slice(0, 8)})`,
      isSubagent: true,
      status,
      statusLabel: STATUS_LABEL[status],
      statusDetail: detail,
      summary: 'ambient-suggestions 등 내부 보조 스레드',
      model: `${info.model}${info.effort ? ` (${info.effort})` : ''}`,
      cwd: '',
      updatedMs: Math.max(lastAct, retry ? retry.ts : 0) * 1000
    });
  }

  // Build quota summary
  let quota = {
    available: false,
    remainingPct: null,
    usedPct: null,
    primaryLabel: '잔여량',
    primaryValueText: '-',
    secondaryText: '',
    resetText: '',
    planType: '',
    limitReached: false,
    updatedMs: newestRateLimitsMs
  };

  if (newestRateLimits) {
    const pri = newestRateLimits.primary;
    const sec = newestRateLimits.secondary;
    const priUsed = pri && typeof pri.used_percent === 'number' ? Number(pri.used_percent) : null;
    const priRem = priUsed !== null ? Math.max(0, Math.min(100, Math.round(100 - priUsed))) : null;
    const priLabel = pri ? formatWindowLabel(pri.window_minutes) : '한도';
    const priResetMs = pri && pri.resets_at ? Number(pri.resets_at) * 1000 : 0;

    let secText = '';
    if (sec && typeof sec.used_percent === 'number') {
      const secRem = Math.max(0, Math.min(100, Math.round(100 - Number(sec.used_percent))));
      secText = `${formatWindowLabel(sec.window_minutes)} ${secRem}%`;
    }

    const limitReached = Boolean(newestRateLimits.rate_limit_reached_type) || (priRem !== null && priRem <= 0);
    quota = {
      available: priRem !== null,
      remainingPct: priRem,
      usedPct: priUsed,
      primaryLabel: `${priLabel} 잔여`,
      primaryValueText: priRem !== null ? `${priRem}%` : '-',
      secondaryText: secText,
      resetText: priResetMs ? `${formatRemainingUntil(priResetMs, nowMs)} (${toKstShort(priResetMs)})` : '',
      planType: newestRateLimits.plan_type || '',
      limitReached,
      updatedMs: newestRateLimitsMs
    };
  }

  return {
    provider: {
      id: 'codex',
      name: 'Codex',
      shortName: 'Cdx',
      color: '#10A37F',
      processState: isProcessRunning ? 'running' : 'stopped',
      processDetail: isProcessRunning ? `실행 중 (${procParts.join(', ')})` : '중지됨',
      quota,
      note: recentCapRetries30m > 0 ? `최근 30분 용량 대기 ${recentCapRetries30m}회` : ''
    },
    tasks
  };
}
