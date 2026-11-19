/**
 * 把面板的数接进每一轮。
 *
 * 数不是给人看的仪表盘，是给嘴用的：
 * 同一句话，13 分和 85 分说出来不该是一个样子。
 *
 * 这一层只做一件事 —— 把 /api/mood-line 的那几行文本，
 * 作为动态上下文挂进每个 agent 的系统提示词。
 * 面板没开时不贡献任何文本（空文本等于不存在），不影响对话。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PANEL_URL = 'http://127.0.0.1:41888/api/mood-line'
const POLL_MS = 60 * 1000
const CONTEXT_NAME = 'libido-state'
const CONTEXT_ORDER = 10320
const CONFIG_FILE = join(homedir(), '.dsh', 'worlds', 'default', 'me', '发情插件.json')

/** 面板是独立的本地进程，属于可选依赖。 */
export const inject = ['systemPrompt']

/** 可选：只对名单里的会话生效。 */
function wantedSessions() {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''))
    const ids = Array.isArray(raw && raw.sessionIds) ? raw.sessionIds.filter(id => typeof id === 'string' && id) : []
    return ids
  } catch {
    return []
  }
}

export function apply(ctx) {
  let line = ''
  let stopped = false
  const only = wantedSessions()

  const refresh = async () => {
    if (stopped) return
    try {
      const response = await fetch(PANEL_URL, { signal: AbortSignal.timeout(4000) })
      line = response.ok ? (await response.text()).trim() : ''
    } catch {
      line = ''
    }
  }

  void refresh()
  const timer = setInterval(refresh, POLL_MS)
  ctx.effect(() => () => {
    stopped = true
    clearInterval(timer)
  }, 'dsh-libido-hud.poller')

  ctx.on('agent/created', ({ agent }) => {
    if (!agent || !agent.ctx || !agent.ctx.systemPrompt) return undefined
    if (only.length > 0 && !only.includes(agent.id)) return undefined
    const dispose = agent.ctx.systemPrompt.context({
      name: CONTEXT_NAME,
      order: CONTEXT_ORDER,
      text: () => line,
      interpolate: false,
    })
    return () => dispose()
  })
}
