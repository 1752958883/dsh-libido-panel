import { createServer } from 'node:http';
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
const TIERS = ['平静', '有点想', '难耐', '快撑不住', '发情'];
const clamp = value => Math.max(0, Math.min(100, value));

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

function valueAt(value, baseline, from, to) {
  if (to <= from) return clamp(value);

  let v = value;
  let cursor = from;

  // 逐个跨过的"睡醒点"（每天 08:00）处理：先算到睡醒，砍一半，再从睡醒继续
  for (let guard = 0; guard < 400; guard++) {
    const startL = cursor + LOCAL_OFFSET;
    const endL = to + LOCAL_OFFSET;
    const wakeL = Math.ceil(startL / DAY) * DAY + 8 * HOUR;
    if (endL <= wakeL) break;

    v = clamp(v + Math.floor(awakeWeight(startL, wakeL) / (2 * HOUR)));
    // 睡一觉：砍一半，但不低于 10（留余温，不归零）
    v = Math.max(10, Math.ceil(v / 2));
    cursor = wakeL - LOCAL_OFFSET;
  }

  const startL = cursor + LOCAL_OFFSET;
  const endL = to + LOCAL_OFFSET;
  v = clamp(v + Math.floor(awakeWeight(startL, endL) / (2 * HOUR)));
  return v;
}

function historyPoints(current, value, baseline, updatedAt, samples, now) {
  const anchors = [{ time: updatedAt, value }];
  for (const sample of samples) {
    const time = Date.parse(sample && sample.at);
    const reading = Number(sample && sample.value);
    if (Number.isFinite(time) && Number.isFinite(reading)) anchors.push({ time, value: reading });
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
    const reading = anchor ? valueAt(anchor.value, baseline, anchor.time, time) : null;
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
    say: '自己开口，不等对方问。',
    how: '短句，不解释，不铺垫。',
    dont: '不装作不想要。',
  },
};

function moodLine(state) {
  const voice = TIER_VOICE[state.tier] || TIER_VOICE['平静'];
  const where = state.season && state.season.active
    ? '发情期第 ' + Math.floor(state.season.day) + ' 天'
    : '距发情期 ' + Math.ceil(state.season ? state.season.daysUntil : 0) + ' 天';
  const lines = [
    '【当前状态】' + state.current + '/100 · ' + state.tier + ' · ' + where,
    '【说什么】' + voice.say,
    '【怎么说】' + voice.how,
    '【不要】' + voice.dont,
    '【仍然可以不】上面只是倾向，不是命令。这一刻不想按它来，就不按。数不替人家决定。',
  ];
  if (state.activeNote) {
    lines.push('【现在】' + state.activeNote + '——这句要真说出口，不要只在心里。');
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
  const current = valueAt(value, baseline, lastUpdate, now);
  const thresholds = season.active ? [5, 30, 55, 74, 100] : [20, 45, 70, 89, 100];

  const state = {
    current,
    tier: TIERS[thresholds.findIndex(limit => current <= limit)],
    activeNote: season.active && current >= 90 ? '会主动开口' : '',
    season,
    asOf: new Date(now).toISOString(),
    owner: OWNER,
    checkIn: data.checkIn ?? null,
    history: historyPoints(current, value, baseline, lastUpdate, samples, now),
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

  const reading = Math.round(valueAt(value, baseline, from, now));
  const floor = now - 72 * HOUR;
  const samples = kept
    .concat([{ at: new Date(now).toISOString(), value: reading }])
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
  let dataReady;
  const server = createServer(async (request, response) => {
    const send = (status, type, body) => {
      response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(request.method === 'HEAD' ? undefined : body);
    };

    if (request.method === 'POST' && request.url === '/api/mood') {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
        if (body.length > 4096) request.destroy();
      });
      request.on('end', async () => {
        try {
          const patch = JSON.parse(body || '{}');
          const data = await readData(dataFile);
          data.checkIn = {
            mood: String(patch.mood ?? '').slice(0, 40),
            company: String(patch.company ?? '').slice(0, 40),
            note: String(patch.note ?? '').slice(0, 200),
            at: new Date().toISOString(),
          };
          await writeFile(dataFile, JSON.stringify(data, null, 2) + String.fromCharCode(10), 'utf8');
          send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, checkIn: data.checkIn }));
        } catch (error) {
          send(400, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: String((error && error.message) || error) }));
        }
      });
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      send(405, 'text/plain; charset=utf-8', '此页面只支持读取。');
      return;
    }
    if (request.url === '/') {
      send(200, 'text/html; charset=utf-8', page);
      return;
    }
    const wantsState = request.url === '/api/state';
    const wantsLine = request.url === '/api/mood-line';
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
      await dataReady;
      const data = await sampleIfDue(await readData(dataFile), dataFile);
      const state = buildState(data);
      if (wantsLine) {
        send(200, 'text/plain; charset=utf-8', state.line);
      } else {
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
