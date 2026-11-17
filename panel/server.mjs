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

function valueAt(value, baseline, from, to) {
  if (to <= from) return clamp(value);
  const start = from + LOCAL_OFFSET;
  const end = to + LOCAL_OFFSET;
  const firstMidnight = Math.ceil(start / DAY) * DAY;
  // 睡一觉：砍一半，但不低于 10（留余温，不归零）
  if (end >= firstMidnight + 8 * HOUR) return Math.max(10, Math.ceil(value / 2));

  let weightedAwakeTime = 0;
  for (let day = Math.floor(start / DAY) * DAY; day < end; day += DAY) {
    const awakeStart = Math.max(start, day + 8 * HOUR);
    const awakeEnd = Math.min(end, day + DAY);
    const { start: seasonStart, end: seasonEnd } = seasonBounds(day);
    const speed = day >= seasonStart && day <= seasonEnd ? 2 : 1;
    weightedAwakeTime += Math.max(0, awakeEnd - awakeStart) * speed;
  }
  return clamp(value + Math.floor(weightedAwakeTime / (2 * HOUR)));
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

  return {
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
    if (request.url !== '/api/state') {
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
      send(200, 'application/json; charset=utf-8', JSON.stringify(state));
    } catch {
      send(503, 'application/json; charset=utf-8', JSON.stringify({ error: '暂时无法读取状态文件。请检查 JSON 格式或稍后再试。' }));
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
