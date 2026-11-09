import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { TurnRecord, Usage } from '../types'
import { addUsage, footerLine, fromResponse } from './tokens'

// Bump a shape when its value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const turns = atom({ plugin: 'message-cost', key: 'turns' } as const, {}, {
  shape: 'turns-1',
})
const messages = atom({ plugin: 'message-cost', key: 'messages' } as const, {}, {
  shape: 'messages-2',
})

const KEEP_TURNS = 400
const KEEP_MESSAGES = 1200

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()

function keepLast<T>(map: Record<string, T>, n: number): Record<string, T> {
  const keys = Object.keys(map)
  if (keys.length <= n) return map

  return Object.fromEntries(keys.slice(-n).map(k => [k, map[k] as T]))
}

/** The usage a transcript message's footer shows, if any. */
export function footerFor(
  requestId: string,
  text: string,
  turnMap: Record<string, TurnRecord>,
  messageMap: Record<string, string>,
): Usage | null | undefined {
  const key = messageMap[requestId]

  if (key !== undefined) {
    const rec = turnMap[key]
    if (rec === undefined) return undefined
    // An answer drawn in several bubbles carries its footer on the last.
    return rec.lastMessage === undefined || rec.lastMessage === requestId ? rec.usage : undefined
  }

  // Not drawn while a response streamed: match the answer by its text, newest first.
  const t = normalize(text)
  if (t.length === 0) return undefined
  const keys = Object.keys(turnMap)
  for (let i = keys.length - 1; i >= 0; i--) {
    const rec = turnMap[keys[i] as string]
    if (rec !== undefined && rec.lastMessage === undefined && rec.text.endsWith(t)) return rec.usage
  }

  return undefined
}

/** `msg_…-t3` -> 3: the block's place in its response. */
const blockIndex = (id: string) => Number(/-t(\d+)$/.exec(id)?.[1] ?? 0)

export const register: Register = on => {
  // The main loop's response streaming now, and the transcript messages first
  // drawn while it streamed (those are its text blocks). Render hooks cannot
  // write state, so this is kept here and written when the response ends.
  let inFlight: string | undefined
  const drawnDuring = new Map<string, Set<string>>()
  const drawn = new Set<string>()

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)

    const key = `${e.turnId}:${e.index}`
    inFlight = key
    drawnDuring.set(key, new Set())
    let r
    try {
      r = yield* next(e)
    } finally {
      if (inFlight === key) inFlight = undefined
    }
    const ids = [...(drawnDuring.get(key) ?? [])].sort((a, b) => blockIndex(a) - blockIndex(b))
    drawnDuring.delete(key)

    // No response at all (failed or interrupted before a message): nothing to count.
    if (r.stopReason === null && r.usage === null) return r

    // One footer per answer: every response of the turn summed, shown on the
    // newest bubble the turn has drawn so far (so it moves down as it goes).
    const turn = e.turnId
    const text = normalize(r.answer)
    const last = ids[ids.length - 1]
    if (ids.length > 0) {
      await update($, messages, map =>
        keepLast({ ...map, ...Object.fromEntries(ids.map(id => [id, turn])) }, KEEP_MESSAGES),
      )
    }
    await update($, turns, map => {
      const was: TurnRecord = map[turn] ?? { usage: null, text: '' }
      const rec: TurnRecord = {
        usage: addUsage(was.usage, fromResponse(r.usage)),
        text: text.length > 0 ? text : was.text,
        ...(last !== undefined ? { lastMessage: last } : was.lastMessage !== undefined ? { lastMessage: was.lastMessage } : {}),
      }

      return keepLast({ ...map, [turn]: rec }, KEEP_TURNS)
    })

    return r
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const node = await next(e)
    if (e.props.isSummary) return node

    // A message first drawn while a response streams is that response's.
    if (!drawn.has(e.requestId)) {
      drawn.add(e.requestId)
      if (inFlight !== undefined) drawnDuring.get(inFlight)?.add(e.requestId)
    }

    const usage = footerFor(e.requestId, e.props.text, await read($, turns), await read($, messages))
    if (usage == null || usage.responses === 0) return node

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {node}
        <Text dimColor>{footerLine(usage)}</Text>
      </Box>
    )
  })
}
