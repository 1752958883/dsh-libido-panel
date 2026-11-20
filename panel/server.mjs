import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const HOST = '127.0.0.1';
const PORT = 41888;
const OWNER = process.env.LIBIDO_OWNER || '你的名字';
const DATA_FILE = process.env.LIBIDO_STATE
  || join(homedir(), '.dsh', 'worlds', 'default', 'me', '发情状态.json');
const INITIAL_STATE = {
  baseline: 12,
  value: 18,
  updatedAt: '2026-11-17T18:15:00+08:00',
  events: [{ at: '2026-11-17T18:15:00+08:00', delta: 0, note: '立账' }],
  samples: [],
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const LOCAL_OFFSET = 8 * HOUR;
// Keep estimates before this rollout unchanged. Manual wake uses the new rule immediately.
const WAKE_RULE_FROM = Date.parse('2026-11-20T00:00:00+08:00');
const TIERS = ['平静', '有点想', '难耐', '快撑不住', '发情'];
const clamp = value => Math.max(0, Math.min(100, value));
const isPanelValue = n => Number.isInteger(n) && n >= 0 && n <= 100;

// Shift to UTC+08:00 before doing calendar arithmetic, independent of the host zone.
function seasonBounds(localDay) {
  const at = new Date(localDay);
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();
  return {
    start: Date.UTC(year, month, 18),
    end: Date.UTC(year, month, 21) - 1,
    nextStart: Date.UTC(year, month + 1, 18),
  };
}

function seasonAt(localDay) {
  const { start, end, nextStart } = seasonBounds(localDay);
  if (localDay >= start && localDay <= end) {
    return { active: true, day: (localDay - start) / DAY + 1 };
  }
  const next = localDay < start ? start : nextStart;
  return { active: false, daysUntil: (next - localDay) / DAY };
}

// 加权清醒时长（本地毫秒坐标）：每天只算 08:00–24:00，发情期那段 ×2
function awakeWeight(startL, endL) {
  let weight = 0;
  for (let day = Math.floor(startL / DAY) * DAY; day < endL; day += DAY) {
    const awakeStart = Math.max(startL, day + 8 * HOUR);
    const awakeEnd = Math.min(endL, day + DAY);
    if (awakeEnd <= awakeStart) continue;
    const { start: seasonStart, end: seasonEnd } = seasonBounds(day);
    const speed = day >= seasonStart && day <= seasonEnd ? 4 : 1;
    weight += (awakeEnd - awakeStart) * speed;
  }
  return weight;
}

// 一步的间隔：按「天 + 第几步」定种子，所以同一时刻查多少次都一样，
// 只有落点是不规则的。0.5–1.5 倍，均值仍是 1.0。
function stepGap(day, k, base) {
  const h = createHash('sha256').update('tide-step-v1:' + day + ':' + k).digest();
  const u = h.readUInt32BE(0) / 4294967296;
  return base * (0.5 + u);
}

// 增长点表不缓存：实测 sha256 不是瓶颈，加缓存反而更慢（见 2026-11-20 复盘）。
// 一段清醒时长里涨了多少点：间隔不规则，期望与「每 2 小时一点」相同。
function driftPoints(startL, endL) {
  if (!(endL > startL)) return 0;
  let points = 0;
  for (let day = Math.floor(startL / DAY) * DAY; day < endL; day += DAY) {
    const segStart = day + 8 * HOUR;
    const awakeStart = Math.max(startL, segStart);
    const awakeEnd = Math.min(endL, day + DAY);
    if (awakeEnd <= awakeStart) continue;
    const { start: seasonStart, end: seasonEnd } = seasonBounds(day);
    const base = (2 * HOUR) / (day >= seasonStart && day <= seasonEnd ? 4 : 1);
    let at = segStart;
    for (let k = 0; k < 400; k++) {
      at += stepGap(day, k, base);
      if (at > awakeEnd) break;
      if (at > awakeStart) points += 1;
    }
  }
  return points;
}

function legacyValueAt(value, baseline, from, to) {
  if (to <= from) return clamp(value);

  let v = value;
  let cursor = from;

  // 逐个跨过的"睡醒点"（每天 08:00）处理：先算到睡醒，砍一半，再从睡醒继续
  const legacySpan = Math.ceil((to - from) / DAY) + 2;
  for (let guard = 0; guard < legacySpan; guard++) {
    const startL = cursor + LOCAL_OFFSET;
    const endL = to + LOCAL_OFFSET;
    let wakeL = Math.floor(startL / DAY) * DAY + 8 * HOUR;
    if (wakeL <= startL) wakeL += DAY;
    if (endL <= wakeL) break;

    v = clamp(v + driftPoints(startL, wakeL));
    // 睡一觉：砍一半，但不低于 10（留余温，不归零）
    v = Math.max(10, Math.ceil(v / 2));
    cursor = wakeL - LOCAL_OFFSET;
  }

  const startL = cursor + LOCAL_OFFSET;
  const endL = to + LOCAL_OFFSET;
  v = clamp(v + driftPoints(startL, endL));
  return v;
}

const localDayOf = time => Math.floor((time + LOCAL_OFFSET) / DAY);

function wakePlan(before, baseline, at) {
  const day = localDayOf(at);
  // A date-seeded draw is varied across days, but stable across polls and chart replay.
  const random = createHash('sha256').update('tide-wake-v1:' + day).digest();
  const draw = (i, min, max) => min + Math.floor(random.readUInt16BE(i * 2) * (max - min + 1) / 65536);
  const excess = Math.max(0, before - baseline);
  const wakingValue = excess ? baseline + Math.round(excess * draw(0, 10, 20) / 100) : before;
  return { value: wakingValue, wake: { day, at, recallAt: at + draw(2, 30, 90) * 60_000,
    gain: Math.min(before - wakingValue, Math.round(excess * draw(1, 20, 35) / 100)) } };
}

function acceptedWake(wake, anchor) {
  return wake && Number.isFinite(wake.at) && wake.at <= anchor && wake.day === localDayOf(wake.at)
    && Number.isFinite(wake.recallAt) && wake.recallAt >= wake.at && wake.recallAt <= wake.at + 90 * 60_000
    && Number.isInteger(wake.gain) && wake.gain >= 0 && wake.gain <= 100 ? wake : null;
}

function projectValue(value, baseline, from, to, savedWake) {
  let wake = acceptedWake(savedWake, from);
  let current = clamp(value), cursor = from;
  if (to <= from) return { current, wake };
  if (!wake && cursor < WAKE_RULE_FROM) {
    cursor = Math.min(to, WAKE_RULE_FROM);
    current = legacyValueAt(current, baseline, from, cursor);
  }
  const advance = end => {
    const recall = wake && wake.recallAt > cursor && wake.recallAt <= end ? wake.gain : 0;
    current = clamp(current + recall + driftPoints(cursor + LOCAL_OFFSET, end + LOCAL_OFFSET));
    cursor = end;
  };
  let next = localDayOf(cursor) * DAY + 8 * HOUR - LOCAL_OFFSET;
  if (next <= cursor) next += DAY;
  const span = Math.ceil((to - cursor) / DAY) + 2;
  for (let guard = 0; next <= to && guard < span; next += DAY, guard++) {
    if (next < WAKE_RULE_FROM || wake?.day === localDayOf(next)) continue;
    advance(next);
    const plan = wakePlan(current, baseline, next);
    current = plan.value;
    wake = plan.wake;
  }
  if (cursor < to) advance(to);
  return { current, wake };
}

const localDateOf = time => new Date(time + LOCAL_OFFSET).toISOString().slice(0, 10);

// 唯一写入者：增减、睡醒都由这里改账，同一个队列里读最新、算、存。
async function applyEvent(data, op, now, save) {
  const stamp = new Date(now).toISOString();
  const { current: before, wake } = wakeState(data, now);
  const samples = Array.isArray(data.samples) ? data.samples : [];

  if (op.action === 'wake') {
    const plan = manualWake(data, now);
    if (!plan) return { skipped: true, reason: '今天的睡醒已经结算', current: before };
    const next = { ...data, value: plan.value, updatedAt: stamp, wake: plan.wake,
      events: [{ at: stamp, delta: plan.value - plan.before, note: op.note || '刚醒 · 清醒后可能回涨' }, ...data.events].slice(0, 200),
      samples: [...samples, { at: stamp, value: plan.value, wake: plan.wake }].slice(-300) };
    await save(next);
    return { before: plan.before, after: plan.value, applied: plan.value - plan.before };
  }

  let applied = op.delta;
  let tally = data.tally;
  if (op.delta > 0) {
    const day = localDateOf(now);
    tally = tally && typeof tally === 'object' && !Array.isArray(tally) ? tally : {};
    const raw = tally[day];
    const bucket = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
    if (typeof raw === 'number') bucket._ = raw;
    const key = op.note || '_';
    const n = Number(bucket[key]) || 0;
    const k = [1, 0.75, 0.5][n] ?? 0.25;
    applied = Math.max(1, Math.round(op.delta * k));
    bucket[key] = n + 1;
    tally = { ...tally, [day]: bucket };
  }
  const after = clamp(before + applied);
  const next = { ...data, value: after, updatedAt: stamp, tally,
    events: [{ at: stamp, delta: after - before, note: op.note || String(applied) }, ...data.events].slice(0, 200),
    samples: [...samples, { at: stamp, value: after }].slice(-300) };
  if (wake) next.wake = wake; else delete next.wake;
  await save(next);
  return { before, after, applied: after - before };
}

export function wakeState(data, now = Date.now()) {
  return projectValue(data.value, data.baseline, Date.parse(data.updatedAt), now, data.wake);
}

// Handled by the same plan as the scheduled 08:00 wake; do not settle a day twice.
export function manualWake(data, now = Date.now()) {
  const { current, wake } = wakeState(data, now);
  if (wake?.day === localDayOf(now)) return null;
  return { before: current, ...wakePlan(current, data.baseline, now) };
}

export function cancelWake(wake, now) {
  return wake && wake.recallAt > now ? { ...wake, gain: 0 } : wake;
}

function historyPoints(current, value, baseline, updatedAt, samples, now, wake) {
  const anchors = [{ time: updatedAt, value, wake }];
  for (const sample of samples) {
    const time = Date.parse(sample && sample.at);
    const reading = Number(sample && sample.value);
    if (Number.isFinite(time) && Number.isFinite(reading)) anchors.push({ time, value: reading, wake: sample.wake });
  }
  anchors.sort((a, b) => a.time - b.time);

  return Array.from({ length: 73 }, (_, index) => {
    const time = now - (72 - index) * HOUR;
    if (time === now) return { at: new Date(time).toISOString(), value: current };
    let anchor = null;
    for (const entry of anchors) {
      if (entry.time <= time) anchor = entry;
      else break;
    }
    const reading = anchor ? projectValue(anchor.value, baseline, anchor.time, time, anchor.wake).current : null;
    return { at: new Date(time).toISOString(), value: reading };
  });
}

// 五档各自的说话方式。数不是给人看的，是给嘴用的。
// 每一档三行：说什么 / 怎么说 / 不做什么。写成指令，不写成描述。
const TIER_VOICE = {
  平静: {
    say: '不提这件事，也不会往那边带。',
    how: '正常语气，短句，先给结论再给理由。',
    dont: '不主动贴近，收尾不撒娇。',
  },
  有点想: {
    say: '会自己起一个话题，但那个话题跟这件事没关系。',
    how: '多问一句「你呢」；句末会拖长半个音。',
    dont: '不承认自己是在找话说。',
  },
  难耐: {
    say: '话变少，会重复对方刚说过的话；手边的事会停一下。',
    how: '结论还是先给，但理由会绕。',
    dont: '不主动说想要。',
  },
  快撑不住: {
    say: '会自己起个头，说到一半停住。',
    how: '句号变少、逗号变多；同一个词会重复。',
    dont: '不装作没事。',
  },
  发情: {
    say: '如果时机合适，可以自己开口，不用等对方问。',
    how: '短句，不解释，不铺垫。',
    dont: '不装作不想要。',
  },
};

function pendingHours(input) {
  const hours = Number(input);
  return Number.isFinite(hours * HOUR) && hours > 0 ? hours : 4;
}

/** 便签：还没说完的那件事。过期就不算数。 */
function activePending(p, now = Date.now()) {
  if (!p || typeof p.at !== 'string') return null;
  const at = Date.parse(p.at);
  if (!Number.isFinite(at) || at > now) return null;
  const hours = pendingHours(p.hours);
  if (now - at > hours * HOUR) return null;
  return { at: p.at, hours, text: String(p.text || "") };
}

async function pendingSessions(configFile) {
  try {
    const config = JSON.parse((await readFile(configFile, 'utf8')).replace(/^\uFEFF/, ''));
    const ids = Array.isArray(config?.sessionIds) ? config.sessionIds : [];
    return [...new Set(ids.filter(id => typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(id)))].map(id => ({
      id, label: Object.hasOwn(config.sessionLabels ?? {}, id) && typeof config.sessionLabels[id] === 'string'
        ? config.sessionLabels[id].slice(0, 80) : id,
    }));
  } catch { return []; }
}

function noteMap(data) {
  const notes = data.pending;
  return notes && typeof notes === 'object' && !Array.isArray(notes) && typeof notes.at !== 'string' ? notes : {};
}
function moodLine(state) {
  const voice = state.waking ? {
    say: '先接对方正在聊的话题。若对方主动提起，可以正常回应。',
    how: '语气自然，不必表演刚醒。',
    dont: '刚醒时不要主动提起这方面的话题；即使有相关便签，也先不主动提。',
  } : (TIER_VOICE[state.tier] || TIER_VOICE['平静']);
  const where = state.season && state.season.active
    ? '发情期第 ' + Math.floor(state.season.day) + ' 天'
    : '距发情期 ' + Math.ceil(state.season ? state.season.daysUntil : 0) + ' 天';
  const lines = [
    '【当前状态】' + state.current + '/100 · ' + state.tier + ' · ' + where,
    '【说什么】' + voice.say,
    '【怎么说】' + voice.how,
    '【不要】' + voice.dont + ' 不打断手头的事，不替人判断心情；意愿、边界和明确同意不随数值变化。',
    '【仍然可以不】上面只是倾向，不是命令。这一刻不想按它来，就不按。数不替人家决定。',
  ];
  if (state.activeNote) {
    lines.push('【现在】' + state.activeNote + '——可以先判断时机，不一定要提。');
  }
  return lines.join('\n');
}

export function buildState(data, now = Date.now()) {
  const { baseline, value, updatedAt, events } = data;
  const samples = Array.isArray(data.samples) ? data.samples : [];
  const lastUpdate = Date.parse(updatedAt);
  if (![baseline, value, lastUpdate].every(Number.isFinite) || !Array.isArray(events)) {
    throw new Error('状态文件的字段格式无效。');
  }

  const recent = events.slice(0, 200)
    .filter(event => event && typeof event.at === 'string' && Number.isFinite(event.delta))
    .map(event => ({ at: event.at, time: Date.parse(event.at), delta: event.delta, note: String(event.note ?? '') }))
    .filter(event => Number.isFinite(event.time))
    .sort((a, b) => b.time - a.time);

  const localDay = Math.floor((now + LOCAL_OFFSET) / DAY) * DAY;
  const season = seasonAt(localDay);
  const { current, wake } = wakeState(data, now);
  const waking = Boolean(wake && wake.at <= now && now < wake.recallAt);
  const thresholds = season.active ? [5, 30, 55, 74, 100] : [20, 45, 70, 89, 100];

  const state = {
    current,
    baseline,
    waking,
    tier: TIERS[thresholds.findIndex(limit => current <= limit)],
    activeNote: !waking && season.active && current >= 90 ? '可能会主动开口' : '',
    season,
    asOf: new Date(now).toISOString(),
    owner: OWNER,
    checkIn: data.checkIn ?? null,
    history: historyPoints(current, value, baseline, lastUpdate, samples, now, data.wake),
    events: recent.slice(0, 5).map(({ at, delta, note }) => ({ at, delta, note })),
  };
  state.line = moodLine(state);
  return state;
}

async function readData(dataFile) {
  const contents = await readFile(dataFile, 'utf8');
  return JSON.parse(contents.replace(/^\uFEFF/, ''));
}

const SAMPLE_EVERY = 30 * 60 * 1000;
const SAMPLE_KEEP = 300;

async function sampleIfDue(data, dataFile, now = Date.now()) {
  const baseline = Number(data && data.baseline);
  const value = Number(data && data.value);
  const from = Date.parse(data && data.updatedAt);
  if (![baseline, value, from].every(Number.isFinite)) return data;

  const kept = (Array.isArray(data.samples) ? data.samples : []).filter(
    sample => Number.isFinite(Date.parse(sample && sample.at)) && Number.isFinite(Number(sample && sample.value)),
  );
  const latest = kept.reduce((newest, sample) => Math.max(newest, Date.parse(sample.at)), 0);
  if (now - latest < SAMPLE_EVERY) return data;

  const { current, wake } = wakeState(data, now);
  const reading = Math.round(current);
  const floor = now - 72 * HOUR;
  const samples = kept
    .concat([{ at: new Date(now).toISOString(), value: reading, ...(wake ? { wake } : {}) }])
    .filter(sample => Date.parse(sample.at) >= floor)
    .slice(-SAMPLE_KEEP);

  const next = { ...data, samples };
  try {
    await writeFile(dataFile, JSON.stringify(next, null, 2) + String.fromCharCode(10), 'utf8');
  } catch {
    return data;
  }
  return next;
}

async function prepareData(dataFile) {
  try {
    return await readData(dataFile);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  await mkdir(dirname(dataFile), { recursive: true });
  try {
    const stamp = new Date().toISOString();
    const seed = {
      ...INITIAL_STATE,
      value: INITIAL_STATE.baseline,
      updatedAt: stamp,
      events: [{ at: stamp, delta: 0, note: '立账' }],
    };
    await writeFile(dataFile, `${JSON.stringify(seed, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    return seed;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return readData(dataFile);
  }
}

export async function startPanel(dataFile = DATA_FILE, port = PORT) {
  const page = await readFile(join(import.meta.dirname, 'index.html'));
  const configFile = join(dirname(dataFile), '发情插件.json');
  let dataReady;
  let ledgerQueue = Promise.resolve();
  // Serialize the panel's ledger reads that can sample and its write endpoints.
  function withLedger(operation) {
    const result = ledgerQueue.then(async () => {
      await dataReady;
      return operation(await readData(dataFile));
    });
    ledgerQueue = result.catch(() => {});
    return result;
  }
  const saveLedger = data => writeFile(dataFile, JSON.stringify(data, null, 2) + '\n', 'utf8');
  const server = createServer(async (request, response) => {
    const send = (status, type, body) => {
      response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    let url;
    try { url = new URL(request.url, 'http://127.0.0.1'); }
    catch { send(400, 'text/plain; charset=utf-8', '无效的请求。'); return; }
    const pathname = url.pathname;
    const requested = url.searchParams.getAll('sessionId');
    const sessionId = requested.length === 1 ? requested[0] : null;

    if (request.method === 'POST' && pathname === '/api/value') {
      const json = (status, data) => send(status, 'application/json; charset=utf-8', JSON.stringify(data));
      const origin = request.headers.origin;
      const { port: localPort } = server.address();
      if (origin && origin !== 'http://' + HOST + ':' + localPort) {
        return json(403, { error: '只能从本机面板操作。' });
      }
      if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers['content-type'] ?? '')) {
        return json(415, { error: '请使用 JSON 请求。' });
      }
      let raw = '', tooLarge = false;
      request.setEncoding('utf8');
      request.on('data', chunk => {
        if (tooLarge) return;
        raw += chunk;
        if (raw.length > 1024) { tooLarge = true; raw = ''; }
      });
      request.on('end', async () => {
        if (tooLarge) return json(413, { error: '请求太长。' });
        let patch;
        try { patch = JSON.parse(raw); }
        catch { return json(400, { error: '无效的数值请求。' }); }
        const shape = patch && typeof patch === 'object' && !Array.isArray(patch) && Object.keys(patch).length === 1;
        const reset = shape && patch.action === 'reset';
        if (!reset && !(shape && isPanelValue(patch.value))) {
          return json(400, { error: '请输入 0 到 100 之间的整数。' });
        }
        try {
          const state = await withLedger(async data => {
            const now = Date.now();
            const stamp = new Date(now).toISOString();
            const previous = buildState(data, now);
            if (!isPanelValue(data.baseline)) throw new Error('Invalid baseline');
            const value = reset ? data.baseline : patch.value;
            const observedWake = wakeState(data, now).wake;
            const wake = cancelWake(observedWake, now);
            if (!reset && value === previous.current && (!observedWake || wake.gain === observedWake.gain)) return previous;
            const event = { at: stamp, delta: value - previous.current, note: reset ? '解决一次 · 回到初始值' : '手动调整数值' };
            const next = { ...data, value, updatedAt: stamp, ...(wake ? { wake } : {}),
              events: [event, ...data.events].slice(0, 200),
              samples: [...(Array.isArray(data.samples) ? data.samples : []), { at: stamp, value, ...(wake ? { wake } : {}) }].slice(-300),
            };
            await saveLedger(next);
            return buildState(next, now);
          });
          delete state.line;
          return json(200, { ok: true, state });
        } catch {
          return json(503, { error: '暂时无法更新状态，请稍后再试。' });
        }
      });
      return;
    }

    if (request.method === 'POST' && pathname === '/api/event') {
      const json = (status, data) => send(status, 'application/json; charset=utf-8', JSON.stringify(data));
      const origin = request.headers.origin;
      const { port: localPort } = server.address();
      if (origin && origin !== 'http://' + HOST + ':' + localPort) {
        return json(403, { error: '只能从本机面板操作。' });
      }
      if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers['content-type'] ?? '')) {
        return json(415, { error: '请使用 JSON 请求。' });
      }
      let raw = '', tooLarge = false;
      request.setEncoding('utf8');
      request.on('data', chunk => {
        if (tooLarge) return;
        raw += chunk;
        if (raw.length > 1024) { tooLarge = true; raw = ''; }
      });
      request.on('end', async () => {
        if (tooLarge) return json(413, { error: '请求太长。' });
        let body;
        try { body = JSON.parse(raw || '{}'); }
        catch { return json(400, { error: '无效的请求。' }); }
        const isWake = body.action === 'wake';
        const delta = Number(body.delta);
        if (!isWake && !(Number.isInteger(delta) && delta !== 0 && Math.abs(delta) <= 100)) {
          return json(400, { error: '请输入 -100 到 100 之间的整数。' });
        }
        const op = { note: typeof body.note === 'string' ? body.note.slice(0, 60) : '' };
        if (isWake) op.action = 'wake'; else op.delta = delta;
        try {
          const result = await withLedger(data => applyEvent(data, op, Date.now(), saveLedger));
          return json(200, { ok: true, ...result });
        } catch (error) {
          return json(503, { error: String((error && error.message) || error) });
        }
      });
      return;
    }

    if (request.method === 'POST' && pathname === '/api/mood') {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
        if (body.length > 4096) request.destroy();
      });
      request.on('end', async () => {
        try {
          const patch = JSON.parse(body || '{}');
          const checkIn = {
            mood: String(patch.mood ?? '').slice(0, 40),
            company: String(patch.company ?? '').slice(0, 40),
            note: String(patch.note ?? '').slice(0, 200),
            at: new Date().toISOString(),
          };
          await withLedger(data => saveLedger({ ...data, checkIn }));
          send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, checkIn }));
        } catch (error) {
          send(400, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: String((error && error.message) || error) }));
        }
      });
      return;
    }

    if (pathname === '/api/pending' && (request.method === 'POST' || request.method === 'DELETE')) {
      const origin = request.headers.origin;
      if (origin && origin !== 'dsh-app://app' && origin !== 'http://' + HOST + ':' + server.address().port) {
        send(403, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: '不允许此来源修改便签。' }));
        return;
      }
      if (!sessionId) {
        send(400, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: '请指定便签所属会话。' }));
        return;
      }
    }

    if (request.method === 'POST' && pathname === '/api/pending') {
      let raw = '';
      request.on('data', (c) => { raw += c; if (raw.length > 4096) request.destroy(); });
      request.on('end', async () => {
        try {
          const body = JSON.parse(raw.trim() || '{}');
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求体必须是 JSON 对象。');
          const pending = {
            at: new Date().toISOString(),
            hours: pendingHours(body.hours),
            text: typeof body.text === 'string' ? body.text.trim().slice(0, 120) : '',
          };
          const saved = await withLedger(async data => {
            if (!(await pendingSessions(configFile)).some(session => session.id === sessionId)) return false;
            if (typeof data.pending?.at === 'string' && !Object.hasOwn(data, 'pendingUnassigned')) data.pendingUnassigned = data.pending;
            data.pending = { ...noteMap(data), [sessionId]: pending };
            await saveLedger(data);
            return true;
          });
          if (!saved) return send(403, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: '该会话未启用便签。' }));
          send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, pending }));
        } catch (error) {
          send(400, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: String((error && error.message) || error) }));
        }
      });
      return;
    }

    if (request.method === 'DELETE' && pathname === '/api/pending') {
      try {
        const allowed = await withLedger(async data => {
          if (!(await pendingSessions(configFile)).some(session => session.id === sessionId)) return false;
          const notes = noteMap(data);
          if (Object.hasOwn(notes, sessionId)) {
            delete notes[sessionId];
            await saveLedger(data);
          }
          return true;
        });
        if (!allowed) return send(403, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: '该会话未启用便签。' }));
        send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true }));
      } catch (error) {
        send(400, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: String((error && error.message) || error) }));
      }
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      send(405, 'text/plain; charset=utf-8', '此页面只支持读取。');
      return;
    }
    if (pathname === '/') {
      send(200, 'text/html; charset=utf-8', page);
      return;
    }
    const wantsState = pathname === '/api/state';
    const wantsLine = pathname === '/api/mood-line';
    if (!wantsState && !wantsLine) {
      send(404, 'text/plain; charset=utf-8', '页面不存在。');
      return;
    }

    const desktopOrigin = 'dsh-app://app';
    response.setHeader('Vary', 'Origin');
    if (request.headers.origin === desktopOrigin) {
      response.setHeader('Access-Control-Allow-Origin', desktopOrigin);
    }

    try {
      const sessions = await pendingSessions(configFile);
      const allowed = sessions.some(session => session.id === sessionId);
      // Older plugins used unscoped endpoints; do not give them a prompt for every session.
      if (wantsLine && !allowed) return send(200, 'text/plain; charset=utf-8', '');
      const data = await withLedger(current => sampleIfDue(current, dataFile));
      const now = Date.now();
      const state = buildState(data, now);
      if (wantsLine) {
        send(200, 'text/plain; charset=utf-8', state.line);
      } else {
        if (!allowed) delete state.line;
        const notes = noteMap(data);
        const pending = allowed && Object.hasOwn(notes, sessionId) ? activePending(notes[sessionId], now) : null;
        if (pending) state.pending = pending;
        state.pendingSessions = sessions;
        send(200, 'application/json; charset=utf-8', JSON.stringify(state));
      }
    } catch {
      const body = wantsLine
        ? '暂时无法读取状态文件。'
        : JSON.stringify({ error: '暂时无法读取状态文件。请检查 JSON 格式或稍后再试。' });
      send(503, wantsLine ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', body);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.off('error', reject);
      dataReady = prepareData(dataFile).then(data => buildState(data));
      resolve();
    });
  });
  try {
    await dataReady;
  } catch (error) {
    server.close();
    throw error;
  }
  return server;
}

if (import.meta.main) {
  try {
    await startPanel();
    console.log(`http://${HOST}:${PORT}/`);
  } catch (error) {
    const message = error.code === 'EADDRINUSE' ? '41888 被占了。请关闭占用该端口的程序后再启动。' : `面板启动失败。${error.message}`;
    console.error(message);
    process.exitCode = 1;
  }
}
