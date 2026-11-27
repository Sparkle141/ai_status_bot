import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  STATUS_LABEL,
  normalizeStatus,
  oneLine,
  parseIsoMs,
  readJsonSafe
} from '../utils.mjs';

const EXTERNAL_DIR = path.join(os.homedir(), '.ai-desk-pet', 'external');

const KNOWN_DISPLAY = {
  cursor: { name: 'Cursor', shortName: 'Cur', color: '#8B5CF6' },
  ollama: { name: 'Ollama', shortName: 'Olm', color: '#06B6D4' },
  'lm-studio': { name: 'LM Studio', shortName: 'LMS', color: '#EC4899' },
  windsurf: { name: 'Windsurf', shortName: 'Wsf', color: '#14B8A6' },
  gemini: { name: 'Gemini CLI', shortName: 'Gem', color: '#3B82F6' },
  aider: { name: 'Aider', shortName: 'Aid', color: '#F59E0B' },
  opencode: { name: 'OpenCode', shortName: 'OpC', color: '#22C55E' }
};

export function collectGeneric(nowMs, proc) {
  const cutoff24h = nowMs - 24 * 3600 * 1000;
  const providersMap = new Map();
  const tasks = [];

  const ensureProvider = (id, name, shortName, color) => {
    const key = String(id || 'external').toLowerCase();
    if (!providersMap.has(key)) {
      const preset = KNOWN_DISPLAY[key];
      providersMap.set(key, {
        id: key,
        name: name || (preset ? preset.name : id),
        shortName: shortName || (preset ? preset.shortName : String(name || id).slice(0, 3)),
        color: color || (preset ? preset.color : '#A855F7'),
        processState: 'stopped',
        processDetail: '외부 연동',
        quota: {
          available: false,
          remainingPct: null,
          usedPct: null,
          primaryLabel: '잔여량',
          primaryValueText: '-',
          secondaryText: '',
          resetText: '',
          planType: '',
          limitReached: false,
          updatedMs: 0
        },
        note: ''
      });
    }
    return providersMap.get(key);
  };

  // 1. Running other AI processes reported by PowerShell
  const otherProcs = proc && Array.isArray(proc.otherAiProcs) ? proc.otherAiProcs : [];
  const groupedProcs = new Map();
  for (const p of otherProcs) {
    if (!p || !p.name) continue;
    const rawKey = String(p.name).replace(/\.exe$/i, '').toLowerCase();
    if (!groupedProcs.has(rawKey)) groupedProcs.set(rawKey, []);
    groupedProcs.get(rawKey).push(p);
  }

  for (const [key, list] of groupedProcs.entries()) {
    const prov = ensureProvider(key);
    prov.processState = 'running';
    prov.processDetail = `실행 중 (${list.length}개 프로세스)`;
    tasks.push({
      id: `proc:${key}`,
      shortId: String(list[0].pid || key).slice(0, 8),
      providerId: prov.id,
      providerName: prov.name,
      providerShort: prov.shortName,
      providerColor: prov.color,
      title: `${prov.name} 실행 중`,
      isSubagent: false,
      status: 'running',
      statusLabel: STATUS_LABEL.running,
      statusDetail: `프로세스 ${list.length}개 활성`,
      summary: `${prov.name} 백그라운드/앱 프로세스 감지됨`,
      model: prov.name,
      cwd: '',
      updatedMs: nowMs
    });
  }

  // 2. External JSON hook files in %USERPROFILE%\.ai-desk-pet\external\*.json
  try {
    if (fs.existsSync(EXTERNAL_DIR)) {
      const files = fs.readdirSync(EXTERNAL_DIR).filter(f => f.toLowerCase().endsWith('.json'));
      for (const f of files) {
        const fp = path.join(EXTERNAL_DIR, f);
        let st;
        try {
          st = fs.statSync(fp);
        } catch {
          continue;
        }
        const data = readJsonSafe(fp);
        if (!data) continue;

        const items = Array.isArray(data) ? data : (Array.isArray(data.tasks) ? data.tasks : [data]);
        for (let idx = 0; idx < items.length; idx++) {
          const item = items[idx];
          if (!item || typeof item !== 'object') continue;
          const updatedMs = parseIsoMs(item.updatedAt || item.updatedMs) || st.mtimeMs;
          if (updatedMs < cutoff24h) continue;

          const provId = String(item.provider || item.providerId || path.basename(f, '.json')).toLowerCase();
          const prov = ensureProvider(provId, item.providerName || item.provider, item.shortName, item.color);
          if (prov.processState === 'stopped') prov.processState = 'running';
          prov.processDetail = item.processDetail || '외부 상태 파일 연동';

          if (typeof item.remainingPct === 'number') {
            const rem = Math.max(0, Math.min(100, Math.round(item.remainingPct)));
            prov.quota = {
              available: true,
              remainingPct: rem,
              usedPct: 100 - rem,
              primaryLabel: item.quotaLabel || '잔여량',
              primaryValueText: `${rem}%`,
              secondaryText: item.secondaryQuota || '',
              resetText: item.resetAt || '',
              planType: item.planType || '',
              limitReached: rem <= 0,
              updatedMs
            };
          }

          const status = normalizeStatus(item.status);
          tasks.push({
            id: String(item.id || `${f}:${idx}`),
            shortId: String(item.id || f).slice(0, 8),
            providerId: prov.id,
            providerName: prov.name,
            providerShort: prov.shortName,
            providerColor: prov.color,
            title: oneLine(item.title || `${prov.name} 작업`, 60),
            isSubagent: Boolean(item.isSubagent),
            status,
            statusLabel: STATUS_LABEL[status] || STATUS_LABEL.running,
            statusDetail: oneLine(item.statusDetail || STATUS_LABEL[status] || '작업 중', 50),
            summary: oneLine(item.summary || '-', 90),
            model: oneLine(item.model || prov.name, 32),
            cwd: oneLine(item.cwd || '', 30),
            updatedMs
          });
        }
      }
    }
  } catch {
    // Ignore external directory scan error
  }

  return {
    providers: [...providersMap.values()],
    tasks
  };
}
