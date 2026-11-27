import { pathToFileURL } from 'node:url';
import { collectAntigravity } from './providers/antigravity.mjs';
import { collectClaude } from './providers/claude.mjs';
import { collectCodex } from './providers/codex.mjs';
import { collectGeneric } from './providers/generic.mjs';
import {
  STATUS_RANK,
  detectMacProcesses,
  formatRelSec,
  oneLine,
  readJsonEnvProc,
  toKstString
} from './utils.mjs';

function buildPetSpeech(overallState, counts, tasks) {
  const topTask = tasks[0];
  if (overallState === 'approval') {
    return `[승인 대기 ${counts.approval}건] ${topTask.providerName}: ${oneLine(topTask.title, 34)}`;
  }
  if (overallState === 'error') {
    return `[오류 ${counts.error}건] ${topTask.providerName}: ${oneLine(topTask.statusDetail || topTask.title, 34)}`;
  }
  if (overallState === 'running') {
    return `[작업 중 ${counts.running}건] ${topTask.providerName}: ${oneLine(topTask.title, 34)}`;
  }
  if (overallState === 'paused') {
    return `[보류 ${counts.paused}건] ${topTask.providerName}: ${oneLine(topTask.statusDetail || topTask.title, 34)}`;
  }
  if (overallState === 'done') {
    return `최근 작업 ${counts.done}건 완료 · 대기 중`;
  }
  return '현재 실행 중인 AI 작업 없음 · 휴식 중';
}

function buildCompactChipText(overallState, counts, providers) {
  let stateText = '휴식 중';
  if (overallState === 'approval') stateText = `승인 ${counts.approval}`;
  else if (overallState === 'error') stateText = `오류 ${counts.error}`;
  else if (overallState === 'running') stateText = `현재 작업 중 ${counts.running}개`;
  else if (overallState === 'paused') stateText = `보류 ${counts.paused}`;
  else if (overallState === 'done') stateText = `완료 ${counts.done}`;

  const qChips = [];
  for (const p of providers) {
    if (p.quota && p.quota.available && typeof p.quota.remainingPct === 'number') {
      qChips.push(`${p.shortName} ${p.quota.remainingPct}%`);
    } else if (p.id === 'antigravity' && p.quota && p.quota.primaryValueText && p.quota.primaryValueText !== '-') {
      qChips.push(`${p.shortName} ${p.quota.primaryValueText}`);
    }
  }
  return {
    stateText,
    quotaText: qChips.slice(0, 3).join(' · ')
  };
}

export function collectAllStatus() {
  const nowMs = Date.now();
  const proc = readJsonEnvProc() || (process.platform === 'darwin' ? detectMacProcesses() : null);

  const providers = [];
  const tasks = [];
  const adapterErrors = [];

  const adapters = [
    ['codex', () => collectCodex(nowMs, proc)],
    ['claude', () => collectClaude(nowMs, proc)],
    ['antigravity', () => collectAntigravity(nowMs, proc)],
    ['generic', () => collectGeneric(nowMs, proc)]
  ];

  for (const [name, fn] of adapters) {
    try {
      const res = fn();
      if (res.provider) providers.push(res.provider);
      if (Array.isArray(res.providers)) providers.push(...res.providers);
      if (Array.isArray(res.tasks)) tasks.push(...res.tasks);
    } catch (err) {
      adapterErrors.push(`${name}: ${err.message}`);
    }
  }

  // Add relative updated text and sort by urgency then recency
  const normalizedTasks = tasks.map(t => ({
    ...t,
    updatedAtKst: toKstString(t.updatedMs),
    updatedRel: t.updatedMs ? formatRelSec(Math.max(0, Math.floor((nowMs - t.updatedMs) / 1000))) : '-'
  }));

  normalizedTasks.sort((a, b) => {
    const rankDiff = (STATUS_RANK[b.status] || 0) - (STATUS_RANK[a.status] || 0);
    if (rankDiff !== 0) return rankDiff;
    return (b.updatedMs || 0) - (a.updatedMs || 0);
  });

  const counts = {
    approval: 0,
    error: 0,
    running: 0,
    paused: 0,
    done: 0,
    total: normalizedTasks.length
  };
  for (const t of normalizedTasks) {
    if (Object.prototype.hasOwnProperty.call(counts, t.status)) {
      counts[t.status]++;
    }
  }

  let overallState = 'idle';
  if (counts.approval > 0) overallState = 'approval';
  else if (counts.error > 0) overallState = 'error';
  else if (counts.running > 0) overallState = 'running';
  else if (counts.paused > 0) overallState = 'paused';
  else if (counts.done > 0) {
    // Show happy 'done' expression if a task finished in the last 10 minutes, otherwise calm 'idle'
    const recentDone = normalizedTasks.find(t => t.status === 'done' && (nowMs - (t.updatedMs || 0)) <= 10 * 60 * 1000);
    overallState = recentDone ? 'done' : 'idle';
  }

  // Emit alert entries for approval / error tasks updated within the last 60 minutes
  const alertCutoff = nowMs - 60 * 60 * 1000;
  const alerts = [];
  for (const t of normalizedTasks) {
    if ((t.status === 'approval' || t.status === 'error') && (t.updatedMs || 0) >= alertCutoff) {
      alerts.push({
        alertKey: `${t.providerId}:${t.id}:${t.status}`,
        severity: t.status,
        providerName: t.providerName,
        title: t.title,
        message: `${t.providerName} — ${t.statusDetail || t.statusLabel}: ${oneLine(t.title, 50)}`
      });
    }
  }

  const compact = buildCompactChipText(overallState, counts, providers);

  return {
    generatedAtMs: nowMs,
    generatedAtKst: toKstString(nowMs),
    overallState,
    counts,
    petSpeech: buildPetSpeech(overallState, counts, normalizedTasks),
    compactStateText: compact.stateText,
    compactQuotaText: compact.quotaText,
    providers,
    tasks: normalizedTasks,
    alerts,
    adapterErrors
  };
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  const snapshot = collectAllStatus();
  process.stdout.write(JSON.stringify(snapshot) + '\n');
}
