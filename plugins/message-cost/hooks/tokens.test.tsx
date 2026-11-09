import { describe, expect, test } from 'claude-code/testing'

import { addUsage, cachedPercent, footerLine, formatTokens, fromResponse, totalIn } from './tokens'

const R = (input: number, cacheRead: number, cacheWrite: number, output: number) => ({
  input_tokens: input,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  output_tokens: output,
})

describe('token math', () => {
  test('cache share is cache reads over all input', () => {
    const u = fromResponse(R(1_100, 10_900, 400, 820))
    expect(totalIn(u)).toBe(12_400)
    expect(cachedPercent(u)).toBe(88)
    expect(footerLine(u)).toBe('12.4k in · 820 out · 10.9k cached (88%) · 400 written')
  })

  test('no cache write: the written part is left out', () => {
    expect(footerLine(fromResponse(R(500, 9_500, 0, 120)))).toBe('10k in · 120 out · 9.5k cached (95%)')
  })

  test('a cold cache: all written, nothing read', () => {
    const u = fromResponse(R(200, 0, 30_000, 900))
    expect(cachedPercent(u)).toBe(0)
    expect(footerLine(u)).toBe('30.2k in · 900 out · 0 cached (0%) · 30k written')
  })

  test('no input at all: no cache share shown', () => {
    const u = fromResponse(R(0, 0, 0, 50))
    expect(cachedPercent(u)).toBeNull()
    expect(footerLine(u)).toBe('0 in · 50 out')
  })

  test('missing usage: one response without usage says so', () => {
    expect(footerLine(fromResponse(null))).toBe('usage n/a')
  })

  test('missing usage beside a reported response: counts shown, gap named', () => {
    const sum = addUsage(fromResponse(R(100, 900, 0, 10)), fromResponse(null))
    expect(sum.responses).toBe(2)
    expect(footerLine(sum)).toBe('1k in · 10 out · 900 cached (90%) · 1 of 2 without usage')
  })

  test('responses since the last footer add up', () => {
    const a = fromResponse(R(100, 9_900, 0, 100))
    const b = fromResponse(R(50, 9_960, 500, 300))
    const s = addUsage(addUsage(null, a), b)
    expect(s).toEqual({ input: 150, output: 400, cacheRead: 19_860, cacheWrite: 500, responses: 2, missing: 0 })
    expect(footerLine(s)).toBe('20.5k in · 400 out · 19.9k cached (97%) · 500 written')
  })

  test('token formatting', () => {
    expect(formatTokens(820)).toBe('820')
    expect(formatTokens(1_000)).toBe('1k')
    expect(formatTokens(12_400)).toBe('12.4k')
    expect(formatTokens(124_400)).toBe('124k')
    expect(formatTokens(1_250_000)).toBe('1.3M')
  })
})

async function drain<C, R>(s: AsyncGenerator<C, R> & { result: Promise<R> }): Promise<R> {
  for await (const _ of s) {
    // read the stream to its end
  }
  return s.result
}

const MSG = (requestId: string, text: string) =>
  ({
    plugin: 'message-cost',
    component: 'AssistantMessage',
    requestId,
    props: { text, isFirstOfReply: true },
  }) as const

const USAGE = { model: 'claude-opus-5-5', ...R(100, 9_900, 0, 100) }

describe('footer on a drawn message', () => {
  test('a tool-only response counts toward the answer footer, on every surface', async ($, on) => {
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    let step = 0
    on('turn.step', async function* (_, e) {
      step++
      return {
        turnId: e.turnId,
        index: e.index,
        answer: step === 1 ? '' : 'All done here.',
        toolUses: [],
        stopReason: step === 1 ? 'tool_use' : 'end_turn',
        usage: USAGE,
      }
    })

    const base = { turnId: 't1', model: 'claude-opus-5-5', messageCount: 1 }
    await drain($.turn.step({ ...base, index: 0 }))
    await drain($.turn.step({ ...base, index: 1 }))

    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      // Matched by text: not drawn while that response streamed.
      const ui = await $.ui.mount({ ...MSG('m-1', 'All done here.'), surface })
      expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
      expect((await ui.find({ type: 'Text', text: / in · / }))?.text).toBe(
        '20k in · 200 out · 19.8k cached (99%)',
      )
      await ui.unmount()
    }

    const other = await $.ui.mount({ ...MSG('m-2', 'Something else'), surface: 'desktop' })
    expect(await other.find({ type: 'Text', text: / in · / })).toBeUndefined()
    await other.unmount()
  })

  test('a response with no usage shows usage n/a', async ($, on) => {
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    on('turn.step', async function* (_, e) {
      return { turnId: e.turnId, index: e.index, answer: 'Hi.', toolUses: [], stopReason: 'end_turn', usage: null }
    })

    await drain($.turn.step({ turnId: 't3', index: 0, model: 'claude-opus-5-5', messageCount: 1 }))
    const ui = await $.ui.mount({ ...MSG('m-3', 'Hi.'), surface: 'desktop' })
    expect((await ui.find({ type: 'Text', text: /usage/ }))?.text).toBe('usage n/a')
    await ui.unmount()
  })

  test('messages first drawn while a response streams carry its footer, on the last block', async ($, on) => {
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    on('turn.step', async function* (_, e) {
      // Opus 5.5: text between tool calls is not in `answer`, but the app draws it.
      for (const id of ['msg_X-t0', 'msg_X-t2']) {
        const ui = await $.ui.mount({ ...MSG(id, id), surface: 'desktop' })
        await ui.unmount()
      }
      return {
        turnId: e.turnId,
        index: e.index,
        answer: '',
        toolUses: [{ name: 'Bash', input: {} }],
        stopReason: 'tool_use',
        usage: { model: 'claude-opus-5-5', ...R(0, 0, 0, 1000) },
      }
    })

    // An old message drawn before any response: never claimed.
    const old = await $.ui.mount({ ...MSG('msg_old-t0', 'old'), surface: 'desktop' })
    await old.unmount()
    await drain($.turn.step({ turnId: 't2', index: 0, model: 'claude-opus-5-5', messageCount: 1 }))

    const first = await $.ui.mount({ ...MSG('msg_X-t0', 'x'), surface: 'desktop' })
    expect(await first.find({ type: 'Text', text: / in · / })).toBeUndefined()
    await first.unmount()
    const last = await $.ui.mount({ ...MSG('msg_X-t2', 'x'), surface: 'desktop' })
    expect((await last.find({ type: 'Text', text: / in · / }))?.text).toBe('0 in · 1k out')
    await last.unmount()
    const again = await $.ui.mount({ ...MSG('msg_old-t0', 'old'), surface: 'desktop' })
    expect(await again.find({ type: 'Text', text: / in · / })).toBeUndefined()
    await again.unmount()
  })

  test('one footer per answer: the turn summed, on its newest bubble only', async ($, on) => {
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    on('turn.step', async function* (_, e) {
      // Each response of the turn draws one bubble of its own.
      const ui = await $.ui.mount({ ...MSG(`msg_${e.index}-t0`, 'x'), surface: 'desktop' })
      await ui.unmount()
      return {
        turnId: e.turnId,
        index: e.index,
        answer: '',
        toolUses: [],
        stopReason: e.index < 2 ? 'tool_use' : 'end_turn',
        usage: { model: 'claude-opus-5-5', ...R(10, 990, 0, 100) },
      }
    })

    for (const index of [0, 1, 2]) {
      await drain($.turn.step({ turnId: 'answer', index, model: 'claude-opus-5-5', messageCount: 1 }))
    }

    for (const index of [0, 1]) {
      const ui = await $.ui.mount({ ...MSG(`msg_${index}-t0`, 'x'), surface: 'desktop' })
      expect(await ui.find({ type: 'Text', text: / in · / })).toBeUndefined()
      await ui.unmount()
    }
    const last = await $.ui.mount({ ...MSG('msg_2-t0', 'x'), surface: 'desktop' })
    expect((await last.find({ type: 'Text', text: / in · / }))?.text).toBe('3k in · 300 out · 3k cached (99%)')
    await last.unmount()

    // The next answer starts its own total.
    await drain($.turn.step({ turnId: 'next', index: 3, model: 'claude-opus-5-5', messageCount: 1 }))
    const next = await $.ui.mount({ ...MSG('msg_3-t0', 'x'), surface: 'desktop' })
    expect((await next.find({ type: 'Text', text: / in · / }))?.text).toBe('1k in · 100 out · 990 cached (99%)')
    await next.unmount()
  })
})
