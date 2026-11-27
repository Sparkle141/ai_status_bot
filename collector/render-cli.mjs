import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectAllStatus } from './collect-ai-status.mjs';
import { oneLine } from './utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readVersionMeta() {
  try {
    const vp = path.join(__dirname, '..', 'version.json');
    if (fs.existsSync(vp)) {
      const obj = JSON.parse(fs.readFileSync(vp, 'utf8'));
      const version = String(obj.version || '1.1.0');
      const isBeta = String(obj.channel || 'stable').toLowerCase() === 'beta';
      return { version, isBeta };
    }
  } catch {}
  return { version: '1.1.0', isBeta: false };
}

const STATE_ICON = {
  approval: '!',
  error: 'X',
  running: '●',
  paused: '⏸',
  done: '✓',
  idle: '·'
};

function render() {
  const data = collectAllStatus();
  const ver = readVersionMeta();
  const verTag = `v${ver.version}${ver.isBeta ? ' [BETA]' : ''}`;
  console.log('================================================================================');
  console.log(`  AI 통합 실시간 모니터 ${verTag} (토큰 소모 없음)  |  ${data.generatedAtKst} KST`);
  console.log('================================================================================');
  console.log(`  종합 상태: ${data.petSpeech}`);
  console.log(`  요약 카운트: 승인대기 ${data.counts.approval} | 오류 ${data.counts.error} | 작업중 ${data.counts.running} | 보류 ${data.counts.paused} | 완료 ${data.counts.done}`);

  console.log('\n[프로바이더별 구동 상태 · 잔여 사용량]');
  for (const p of data.providers) {
    const q = p.quota || {};
    const qText = q.available
      ? `${q.primaryLabel} ${q.primaryValueText}${q.secondaryText ? ` (${q.secondaryText})` : ''}${q.resetText ? ` · ${q.resetText}` : ''}`
      : `${q.primaryLabel || '사용량'} ${q.primaryValueText || '-'}${q.resetText ? ` · ${q.resetText}` : ''}`;
    const noteTxt = p.note ? ` | 참고: ${p.note}` : '';
    console.log(`  - ${p.name.padEnd(12, ' ')} [${p.processDetail}]  ${qText}${noteTxt}`);
  }

  const active = data.tasks.filter(t => t.status !== 'done');
  console.log(`\n[진행·대기·오류 작업 (${active.length}건)]`);
  if (active.length === 0) {
    console.log('  현재 활성 또는 주의가 필요한 작업이 없습니다.');
  } else {
    for (const t of active.slice(0, 15)) {
      const icon = STATE_ICON[t.status] || '·';
      const sub = t.isSubagent ? '[서브] ' : '';
      console.log(`  ${icon} [${t.providerName}] ${sub}${t.title}  (${t.statusLabel} · ${t.updatedRel})`);
      console.log(`    상태: ${t.statusDetail} | 모델: ${t.model}${t.cwd ? ` | 폴더: ${t.cwd}` : ''}`);
      console.log(`    작업: ${oneLine(t.summary, 96)}`);
    }
  }

  const done = data.tasks.filter(t => t.status === 'done');
  console.log(`\n[최근 완료 작업 (${Math.min(done.length, 6)} / ${done.length}건)]`);
  if (done.length === 0) {
    console.log('  없음');
  } else {
    for (const t of done.slice(0, 6)) {
      console.log(`  ✓ [${t.providerName}] ${oneLine(t.title, 48)} (${t.statusDetail}, ${t.updatedRel})`);
      console.log(`    ${oneLine(t.summary, 96)}`);
    }
  }

  if (data.adapterErrors.length > 0) {
    console.log(`\n[수집기 경고] ${data.adapterErrors.join(' | ')}`);
  }
  console.log('================================================================================');
}

render();
