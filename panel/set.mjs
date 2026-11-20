import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { buildState } from './server.mjs';
import { cancelWake, manualWake, wakeState } from './server.mjs';

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

const arg = (process.argv[2] || '').trim();

/* 体检：只读不写。装完没反应时跑这个。 */
async function doctor() {
  const lines = [];
  const ok = (t) => lines.push('  ✓ ' + t);
  const no = (t, fix) => lines.push('  ✗ ' + t + (fix ? String.fromCharCode(10) + '      → ' + fix : ''));
  const it = (t) => lines.push('  · ' + t);

  lines.push('数据文件  ' + F);
  try {
    const d = load();
    const s0 = buildState(d, now);
    ok('能读，当前 ' + s0.current + ' / ' + s0.tier + '（文件里存的是 ' + (d.value ?? '?') + '）');
  } catch (e) {
    no('读不了：' + e.message, '确认 .dsh/worlds/default/me/ 下有没有 发情状态.json');
  }

  const up = await new Promise((r) => {
    const s = net.connect({ host: '127.0.0.1', port: 41888 });
    const done = (v) => { try { s.destroy(); } catch {} r(v); };
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
    s.setTimeout(2000, () => done(false));
  });
  up ? ok('面板 41888 通') : no('面板 41888 不通', '在 panel 目录跑 start.bat；不通时页面只会显示「面板没开」');

  const root = path.join(os.homedir(), '.dsh', 'profiles');
  let names = [];
  try { names = fs.readdirSync(root); } catch {}
  let hit = 0;

  for (const name of names) {
    const dir = path.join(root, name);
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
    } catch { continue; }
    const deps = pkg.dependencies || {};
    const depKey = Object.keys(deps).find((k) => k.includes('libido-hud'));
    const bundles = Array.isArray(pkg.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
    const inB = bundles.some((b) => String(b).includes('libido'));
    if (!depKey && !inB) continue;

    hit += 1;
    it('profile ' + name);
    depKey ? ok('  dependencies 有（' + depKey + '）')
      : no('  dependencies 缺', 'package.json 的 dependencies 加 "' + (inB ? '@local/dsh-libido-hud' : '@local/dsh-libido-hud') + '": "link:<插件目录的绝对路径>"');
    inB ? ok('  bundles 有') : no('  bundles 缺', 'dsh.profile.bundles 里加一条 @local/dsh-libido-hud');

    const link = depKey ? path.join(dir, 'node_modules', ...depKey.split('/')) : '';
    let target = '';
    if (link && fs.existsSync(link)) {
      try { target = fs.realpathSync(link); } catch { target = ''; }
      target ? ok('  链接指向 ' + target) : no('  链接在但读不出目标', '删掉这个联接重建：mklink /J');
    } else if (depKey) {
      no('  node_modules 里没有它', '建目录联接：把插件目录联到 node_modules/' + depKey + '（不要跑 pnpm install）');
    }

    if (target) {
      const idx = path.join(target, 'index.js');
      try {
        const size = fs.statSync(idx).size;
        size < 200
          ? no('  index.js 只有 ' + size + ' 字节（空壳）', '这就是「装了没反应」：换掉这个文件，正常约 2 KB 以上')
          : ok('  index.js ' + size + ' 字节');
      } catch { no('  没有 index.js', '插件目录不完整，重新解压一份'); }

      try {
        const cj = fs.readFileSync(path.join(target, 'client.js'), 'utf8');
        const id = (cj.match(/id:\s*'([^']+)'/) || [])[1] || '';
        const nm = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).name;
        id === nm ? ok('  client.js 的 id 与包名一致（' + nm + '）')
          : no('  client.js 的 id 是 ' + (id || '?') + '，包名是 ' + nm, '两边必须一致，否则宿主认它、页面收不到');
      } catch {}
    }
  }

  if (!hit) {
    no('没有任何 profile 引用这个插件', '说明还没装进去：package.json 的两条都没写，或写到了别的 profile');
  }

  console.log('======== dsh-libido-hud 体检 ========');
  console.log(lines.join(String.fromCharCode(10)));
  console.log('=====================================');
}

if (arg === 'doctor') {
  await doctor();
  process.exit(0);
}

const data = load();
const state = buildState(data, now);
const note = (process.argv[3] || '').trim();

/* 事件按「距离」分五层。打名字就行，不用记数字。 */
const EVENTS = {
  被看见: 3, 被夸: 3, 被叫名字: 3,
  挨着: 8, 抓手腕: 8, 被按着: 8, 后颈: 8,
  摸尾巴: 10, 摸耳朵: 10, 碰颈侧: 10, 掀裙: 10,
  手指: 15, 进去: 15, 真的开始: 15,
  被冷落: -8, 话说一半走开: -6, 答应了没做到: -10,
};

function show(tag) {
  const s = buildState(load(), now);
  const left = s.season.active ? '发情期第 ' + Math.floor(s.season.day) + ' 天' : '还有 ' + Math.ceil(s.season.daysUntil) + ' 天';
  console.log((tag ? tag + '  ' : '') + s.current + ' / ' + s.tier + '   ' + left + (s.waking ? '   刚醒' : s.activeNote ? '   ' + s.activeNote : ''));
  if (process.argv.includes('--events')) {
    for (const e of s.events.slice(0, 5)) console.log('   ' + e.at.replace('T', ' ').slice(0, 16) + '  ' + (e.delta >= 0 ? '+' : '') + e.delta + '  ' + e.note);
  }
}

function commit(value, before, text, wake) {
  data.value = value;
  data.updatedAt = iso(now);
  if (wake) data.wake = wake;
  else delete data.wake;
  data.events.unshift({ at: iso(now), delta: value - before, note: text });
  data.events = data.events.slice(0, 200);
  data.samples.push({ at: iso(now), value, ...(wake ? { wake } : {}) });
  data.samples = data.samples.slice(-300);
  save(data);
}

const PANEL = 'http://127.0.0.1:41888';

/** 面板在线就由面板写（唯一写入者），不在线才本地写。 */
async function viaPanel(body, path = '/api/event') {
  try {
    const response = await fetch(PANEL + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function apply(delta, text) {
  const via = await viaPanel({ delta, note: text });
  if (!via) return applyLocal(delta, text);
  if (via.skipped) {
    console.log(via.reason);
    show();
    return;
  }
  console.log(String(via.before).padStart(3) + '  ->  ' + String(via.after).padStart(3)
    + '   (' + (via.applied >= 0 ? '+' : '') + via.applied + ')' + (text ? '  ' + text : ''));
  show();
}

function applyLocal(delta, text) {
  const { current: before, wake } = wakeState(data, now);
  let applied = delta;
  if (delta > 0) {
    // 递减按「同一件事今天第几次」算，不是按「今天第几个事件」。
    // 旧格式是数字（当天总计数），读到就当成公共桶。
    const raw = data.tally[today];
    const bucket = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    if (typeof raw === 'number') bucket._ = raw;
    const key = text || '_';
    const n = Number(bucket[key]) || 0;
    const k = [1, 0.75, 0.5][n] ?? 0.25;
    applied = Math.max(1, Math.round(delta * k));
    bucket[key] = n + 1;
    data.tally[today] = bucket;
  }
  const after = Math.max(0, Math.min(100, before + applied));
  const change = after - before;
  commit(after, before, text || String(applied), wake);
  console.log(String(before).padStart(3) + '  ->  ' + String(after).padStart(3) + '   (' + (change >= 0 ? '+' : '') + change + ')' + (text ? '  ' + text : ''));
  show();
}

if (!arg || arg === 'show') {
  show('现在');
} else if (arg === '睡醒' || arg === 'sleep') {
  const via = await viaPanel({ action: 'wake', note });
  if (via) {
    if (via.skipped) console.log(via.reason);
    else console.log(via.before + '  ->  ' + via.after + '   (刚醒)');
    show();
  } else {
    const plan = manualWake(data, now);
    if (plan) {
      commit(plan.value, plan.before, note || '刚醒 · 清醒后可能回涨', plan.wake);
      console.log(plan.before + '  ->  ' + plan.value + '   (刚醒)');
    } else {
      console.log('今天的睡醒已经结算，不重复扣减。');
    }
    show();
  }
} else if (arg === '解决' || arg === 'done') {
  const via = await viaPanel({ action: 'reset' }, '/api/value');
  if (via) {
    console.log('已回到初始值' + (note ? '  ' + note : '') + (via.state ? '  现在 ' + via.state.current : ''));
    show();
  } else {
    const { current: before, wake } = wakeState(data, now);
    commit(data.baseline, before, note || '解决一次 · 回到初始值', cancelWake(wake, now));
    console.log(before + '  ->  ' + data.baseline + '   (回到初始值)' + (note ? '  ' + note : ''));
    show();
  }
} else {
  const delta = Number(arg.replace('+', ''));
  if (Object.hasOwn(EVENTS, arg)) {
    await apply(EVENTS[arg], arg);
  } else if (!Number.isFinite(delta)) {
    console.log('用法：');
    console.log('  node set.mjs                 看当前值');
    console.log('  node set.mjs <动作>          按层加/减，见下');
    console.log('  node set.mjs +8 摸尾巴        也可以直接给数字');
    console.log('  node set.mjs 解决            回到设定的初始值');
    console.log('  node set.mjs 睡醒            按当天睡醒规则结算一次');
    console.log('  node set.mjs doctor          体检');
    console.log('');
    console.log('  看见  被看见 / 被夸 / 被叫名字           +3');
    console.log('  贴近  挨着 / 抓手腕 / 被按着 / 后颈        +8');
    console.log('  皮肤  摸尾巴 / 摸耳朵 / 碰颈侧 / 掀裙     +10');
    console.log('  里面  手指 / 进去 / 真的开始              +15');
    console.log('  反向  被冷落 -8 / 话说一半走开 -6 / 答应了没做到 -10');
    process.exitCode = 1;
  } else {
    await apply(Math.round(delta), note);
  }
}
