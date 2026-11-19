import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { buildState } from './server.mjs';

const F = process.env.LIBIDO_STATE
  || join(homedir(), '.dsh', 'worlds', 'default', 'me', '发情状态.json');
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const localDate = (ms) => iso(ms + 8 * 3600 * 1000).slice(0, 10);
const today = localDate(now);
const oldestTallyDay = localDate(now - 6 * 24 * 3600 * 1000);

function load() {
  const data = JSON.parse(readFileSync(F, 'utf8').replace(/^\uFEFF/, ''));
  if (!Array.isArray(data.samples)) data.samples = [];
  if (!Array.isArray(data.events)) data.events = [];
  if (!data.tally || typeof data.tally !== 'object' || Array.isArray(data.tally)) data.tally = {};
  return data;
}

function save(data) {
  data.tally = Object.fromEntries(Object.entries(data.tally).filter(([day]) =>
    /^\d{4}-\d{2}-\d{2}$/.test(day) && day >= oldestTallyDay && day <= today,
  ));
  copyFileSync(F, F + '.bak');
  writeFileSync(F, JSON.stringify(data, null, 2) + String.fromCharCode(10), 'utf8');
}

const data = load();
const state = buildState(data, now);
const arg = (process.argv[2] || '').trim();
const note = (process.argv[3] || '').trim();

function show(tag) {
  const s = buildState(load(), now);
  const left = s.season.active ? '发情期第 ' + Math.floor(s.season.day) + ' 天' : '还有 ' + Math.ceil(s.season.daysUntil) + ' 天';
  console.log((tag ? tag + '  ' : '') + s.current + ' / ' + s.tier + '   ' + left + (s.activeNote ? '   ' + s.activeNote : ''));
  if (process.argv.includes('--events')) {
    for (const e of s.events.slice(0, 5)) console.log('   ' + e.at.replace('T', ' ').slice(0, 16) + '  ' + (e.delta >= 0 ? '+' : '') + e.delta + '  ' + e.note);
  }
}

function apply(delta, text) {
  const before = state.current;
  let applied = delta;
  if (delta > 0) {
    const n = data.tally[today] || 0;
    const k = [1, 0.75, 0.5][n] ?? 0.25;
    const scaled = Math.max(1, Math.round(delta * k));
    applied = scaled;
    data.tally[today] = n + 1;
  }
  const after = Math.max(0, Math.min(100, before + applied));
  const change = after - before;
  data.value = after;
  data.updatedAt = iso(now);
  data.events.unshift({ at: iso(now), delta: change, note: text || String(applied) });
  data.events = data.events.slice(0, 200);
  data.samples.push({ at: iso(now), value: after });
  data.samples = data.samples.slice(-300);
  save(data);
  console.log(String(before).padStart(3) + '  ->  ' + String(after).padStart(3) + '   (' + (change >= 0 ? '+' : '') + change + ')' + (text ? '  ' + text : ''));
  show();
}

if (!arg || arg === 'show') {
  show('现在');
} else if (arg === '睡醒' || arg === 'sleep') {
  const before = state.current;
  data.value = Math.max(10, Math.ceil(before / 2));
  data.updatedAt = iso(now);
  data.events.unshift({ at: iso(now), delta: data.value - before, note: '睡醒，砍一半' });
  data.events = data.events.slice(0, 200);
  data.samples.push({ at: iso(now), value: data.value });
  data.samples = data.samples.slice(-300);
  save(data);
  console.log(String(before).padStart(3) + '  ->  ' + String(data.value).padStart(3) + '   (回基线)' + (note ? '  ' + note : ''));
  show();
} else if (arg === '解决' || arg === 'done') {
  const before = state.current;
  data.value = 10;
  data.updatedAt = iso(now);
  data.events.unshift({ at: iso(now), delta: 10 - before, note: note || '解决一次，归 10' });
  data.events = data.events.slice(0, 200);
  data.samples.push({ at: iso(now), value: 10 });
  data.samples = data.samples.slice(-300);
  save(data);
  console.log(String(before).padStart(3) + '  ->   10   (归 10，留余温)' + (note ? '  ' + note : ''));
  show();
} else {
  const delta = Number(arg.replace('+', ''));
  if (!Number.isFinite(delta)) {
    console.log('用法：');
    console.log('  node set.mjs              看当前值');
    console.log('  node set.mjs +8 摸尾巴     涨 8');
    console.log('  node set.mjs -20 难过      落 20');
    console.log('  node set.mjs 解决          直接归 10');
    console.log('  node set.mjs 睡醒          回基线');
    process.exitCode = 1;
  } else {
    apply(Math.round(delta), note);
  }
}
