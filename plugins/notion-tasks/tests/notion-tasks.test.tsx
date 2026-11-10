import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { buildTaskPrompt, listTasks } from '../hooks/tasks'
import { pageBody, pageIdOf } from '../hooks/notion'

const PANE = {
  plugin: 'notion-tasks',
  component: 'Pane',
  requestId: 'notion-tasks',
  props: {
    title: 'Notion tasks',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const OPTS = { options: { dataSource: 'collection://test-tasks' } }

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

const ID_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const ID_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const DASHED_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const DASHED_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

const ROWS = [
  { Name: 'Low thing', Status: 'To do', Priority: 'Low', Description: '', url: `https://app.notion.com/p/${ID_A}` },
  { Name: 'Hot fix', Status: 'To do', Priority: 'High', Description: 'Crash on load', url: `https://app.notion.com/p/${ID_B}` },
]

type Call = { server: string; tool: string; args: Record<string, unknown> }

type Mock = {
  calls: Call[]
  submitted: string[]
  toasts: string[]
}

function text(s: string) {
  return { content: [{ type: 'text', text: s }], isError: false }
}

/** The engine beneath the mod, with Notion answering through `mcp.call`. */
function engine(on: On, opts: { notion?: 'ok' | 'error' | 'throw' | 'fetch-fails'; rows?: unknown[] } = {}): Mock {
  const m: Mock = { calls: [], submitted: [], toasts: [] }
  const mode = opts.notion ?? 'ok'
  let rows = opts.rows ?? ROWS
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_, e) => {
    m.toasts.push(String((e as { text?: unknown }).text ?? e))
    return { value: undefined }
  })
  on('clock.now', () => ({ value: 1_000_000 }))
  on('tool.list', () => ({
    value: [{ name: 'mcp__nsrv__notion-query-data-sources', description: '', mcp: true }],
  }))
  on('mcp.call', (_, e) => {
    m.calls.push({ server: e.server, tool: e.tool, args: e.args })
    if (mode === 'throw') throw new Error('connection refused')
    if (mode === 'error') return { value: { content: [{ type: 'text', text: 'Unauthorized' }], isError: true } }
    if (e.tool === 'notion-query-data-sources') return { value: text(JSON.stringify({ results: rows })) }
    if (e.tool === 'notion-fetch') {
      if (mode === 'fetch-fails') return { value: { content: [{ type: 'text', text: 'boom' }], isError: true } }
      return {
        value: text(JSON.stringify({ title: 'Hot fix', text: '<page>\n<content>\nRepro: open level 2.\n</content>\n</page>' })),
      }
    }
    if (e.tool === 'notion-update-page') {
      const props = (e.args.properties ?? {}) as Record<string, unknown>
      rows = rows.map(r => {
        const row = r as Record<string, unknown>
        return String(row.url).includes(pageIdOf(String(e.args.page_id)).replace(/-/g, '')) ? { ...row, ...props } : row
      })
      return { value: text('{"page_id":"x"}') }
    }
    return { value: text('{}') }
  })
  on('prompt.submit', (_, e) => {
    m.submitted.push(e.text)
    return { text: e.text }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.run', () => ({}))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  return m
}

const start = ($: Engine) => $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

const openBoard = ($: Engine) =>
  $.command.run({
    command: 'board',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })

// ---------- pure logic ----------

test('listing drops Done and sorts In progress first, then by priority', async () => {
  const tasks = listTasks([
    ...ROWS,
    { Name: 'Shipped', Status: 'Done', Priority: 'High', url: 'https://app.notion.com/p/cccccccccccccccccccccccccccccccc' },
    { Name: 'Doing', Status: 'In progress', Priority: 'Low', url: 'https://app.notion.com/p/dddddddddddddddddddddddddddddddd' },
    { Name: 'No url' },
  ])
  expect(tasks.map(t => t.title)).toEqual(['Doing', 'Hot fix', 'Low thing'])
  expect(tasks[1]?.id).toBe(DASHED_B)
})

test('page ids and bodies are read from Notion text', async () => {
  expect(pageIdOf(`https://app.notion.com/p/${ID_A}?pvs=204`)).toBe(DASHED_A)
  expect(pageIdOf(DASHED_A)).toBe(DASHED_A)
  expect(pageBody('<page>\n<content>\nhello\n</content>\n</page>')).toBe('hello')
})

test('the message carries title, properties, link and the page body', async () => {
  const [, hot] = listTasks(ROWS).reverse()
  const msg = buildTaskPrompt(hot!, 'Repro: open level 2.', { writeBack: true })
  expect(msg).toContain('## Hot fix')
  expect(msg).toContain('Status: To do → In progress · Priority: High')
  expect(msg).toContain(`Notion page: https://app.notion.com/p/${ID_B}`)
  expect(msg).toContain('Crash on load')
  expect(msg).toContain('Repro: open level 2.')
  const ro = buildTaskPrompt(hot!, undefined, { writeBack: false })
  expect(ro).toContain('Status: To do ·')
  expect(ro).toContain('could not be fetched')
  expect(ro).not.toContain('/board panel')
})

// ---------- the pane ----------

test('/board lists open tasks on every surface, highest priority first', OPTS, async ($, on) => {
  const m = engine(on)
  await start($)
  await openBoard($)
  expect(m.calls[0]?.server).toBe('nsrv')
  expect(m.calls[0]?.tool).toBe('notion-query-data-sources')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const starts = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('start:'))
    expect(starts.map(b => b.key)).toEqual([`start:${DASHED_B}`, `start:${DASHED_A}`])
    expect(await ui.find({ type: 'Text', text: 'Hot fix' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: / To do / })).toBeDefined()
    await ui.unmount()
  }
})

test('▶ fetches the page, submits it, then sets In progress', OPTS, async ($, on) => {
  const m = engine(on)
  await start($)
  await openBoard($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `start:${DASHED_B}` })

  expect(m.submitted).toHaveLength(1)
  expect(m.submitted[0]).toContain('## Hot fix')
  expect(m.submitted[0]).toContain('Repro: open level 2.')
  const tools = m.calls.map(c => c.tool)
  expect(tools.indexOf('notion-fetch')).toBeLessThan(tools.indexOf('notion-update-page'))
  const write = m.calls.find(c => c.tool === 'notion-update-page')
  expect(write?.args).toEqual({ page_id: DASHED_B, command: 'update_properties', properties: { Status: 'In progress' } })
  // The list reloads and shows the new status.
  expect(await ui.find({ type: 'Text', text: / In progress / })).toBeDefined()
  await ui.unmount()
})

test('✓ Done sets Done and the task leaves the list', OPTS, async ($, on) => {
  const m = engine(on)
  await start($)
  await openBoard($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: `done:${DASHED_B}` })
  const write = m.calls.find(c => c.tool === 'notion-update-page')
  expect(write?.args.properties).toEqual({ Status: 'Done' })
  expect(await ui.find({ type: 'Text', text: 'Hot fix' })).toBeUndefined()
  expect(m.submitted).toHaveLength(0)
  await ui.unmount()
})

test('with write-back off nothing is written and there is no Done button', { options: { ...OPTS.options, writeBack: false } }, async ($, on) => {
  const m = engine(on)
  await start($)
  await openBoard($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', key: `done:${DASHED_B}` })).toBeUndefined()
  await ui.press({ key: `start:${DASHED_B}` })
  expect(m.submitted).toHaveLength(1)
  expect(m.calls.some(c => c.tool === 'notion-update-page')).toBe(false)
  await ui.unmount()
})

test('a Notion error shows the error state with Retry', OPTS, async ($, on) => {
  engine(on, { notion: 'error' })
  await start($)
  await openBoard($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: "Can't reach Notion" })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Unauthorized/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'retry' })).toBeDefined()
  await ui.press({ key: 'retry' })
  await ui.unmount()
})

test('an unreachable Notion fails softly too', OPTS, async ($, on) => {
  engine(on, { notion: 'throw' })
  await start($)
  await openBoard($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: "Can't reach Notion" })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'retry' })).toBeDefined()
  await ui.unmount()
})

test('a page that will not fetch still sends the task, from its row', OPTS, async ($, on) => {
  const m = engine(on, { notion: 'fetch-fails' })
  await start($)
  await openBoard($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `start:${DASHED_B}` })
  expect(m.submitted[0]).toContain('could not be fetched')
  expect(m.submitted[0]).toContain('Crash on load')
  await ui.unmount()
})

test('while a turn runs, ▶ reads Queue and still sends', OPTS, async ($, on) => {
  const m = engine(on)
  await start($)
  await openBoard($)
  await $.turn.start({ text: 'busy', turnId: 't1' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const btn = await ui.find({ type: 'Button', key: `start:${DASHED_A}` })
  expect(btn?.text).toBe('▶ Queue')
  await ui.press({ key: `start:${DASHED_A}` })
  expect(m.submitted).toHaveLength(1)
  expect(m.toasts.some(t => t.includes('Queued'))).toBe(true)
  await ui.unmount()
})
