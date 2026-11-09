import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import { EMPTY_TOTALS, addTurn, formatDuration, idleText, isLongTurn, liveText, toolsLabel } from './logic'

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const active = atom({ plugin: 'turn-timer', key: 'active' } as const, null, { shape: 'active-1' })
const totals = atom({ plugin: 'turn-timer', key: 'totals' } as const, EMPTY_TOTALS, { shape: 'totals-1' })

// The once-a-second redraw; a reload cancels it and session.start restarts it.
let tick: Timer | undefined

function stopTicking(): void {
  tick?.cancel()
  tick = undefined
}

async function showLive($: EngineInterface): Promise<void> {
  const turn = await read($, active)
  if (turn === null) return
  const now = await $.clock.now()
  $.ui.status(liveText(now - turn.startedAt, turn.tools))
}

function startTicking($: EngineInterface): void {
  stopTicking()
  tick = $.clock.every(1000, () => void showLive($))
}

export const register: Register = on => {
  // A reload (or a resumed session) puts the line back as it stood.
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if ((await read($, active)) !== null) {
      startTicking($)
      await showLive($)
    } else {
      $.ui.status(idleText(await read($, totals)))
    }
    return result
  })

  // Main-loop turns only: a subagent's run happens inside one of them.
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const startedAt = await $.clock.now()
    await update($, active, () => ({ turnId: e.turnId, startedAt, tools: 0 }))
    $.ui.status(liveText(0, 0))
    startTicking($)
    return next(e)
  })

  // Every tool call while a main turn runs counts, subagents' included.
  on('tool.call', async ($, e, next) => {
    const turn = await update($, active, t => (t === null ? t : { ...t, tools: t.tools + 1 }))
    if (turn !== null) await showLive($)
    return next(e)
  }).catch(($, e, next) => next(e)) // counting must never block a tool call

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    stopTicking()
    const turn = await read($, active)
    await update($, active, () => null)
    const tools = turn?.tools ?? 0
    const sum = await update($, totals, t => addTurn(t, e.durationMs, tools))
    $.ui.status(idleText(sum))
    if (isLongTurn(e.durationMs)) {
      $.ui.toast(`Long turn: ${formatDuration(e.durationMs)} · ${toolsLabel(tools)}`, { timeoutMs: 8000 })
    }
    return next(e)
  })
}
