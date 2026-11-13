import { expect, mock, test } from 'claude-code/testing'
import type { ModelCompleteResult, On, SessionMessage } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { digest, entryHeading, entryMarkdown, extras, filesTouched, splitTitle, startIndex, ticketIds, withTicket } from '../hooks/devlog'

const PANE = {
  plugin: 'notion-tasks',
  component: 'Pane',
  requestId: 'notion-devlog',
  props: {
    title: 'Devlog draft',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const PAGE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
const OPTS = { options: { devlogPage: PAGE } }
const MODEL_TEXT = 'Title: Enemy spawner basics\nBuilt the enemy spawner.\n\n**Done**\n- Added spawner scene\n\n**Open problems**\n- None'

function msgs(n: number): SessionMessage[] {
  const out: SessionMessage[] = []
  for (let i = 0; i < n; i++) {
    out.push({ role: 'user', text: `step ${i}`, toolUses: [] })
    out.push({
      role: 'assistant',
      text: `did step ${i}`,
      toolUses: [
        { tool_use_id: `t${i}`, tool: 'Edit', input: { file_path: `C:\\game\\src\\file${i}.gd` } },
      ],
    } as SessionMessage)
  }
  return out
}

type Mock = { appends: Record<string, unknown>[]; prompts: string[]; messages: SessionMessage[] }

function engine(on: On, opts: { notion?: 'ok' | 'error'; model?: 'ok' | 'fail'; messages?: SessionMessage[] } = {}): Mock {
  const m: Mock = { appends: [], prompts: [], messages: opts.messages ?? msgs(2) }
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('clock.now', () => ({ value: Date.UTC(2026, 10, 10, 12, 30) }))
  on('session.cwd', () => ({ value: 'C:/game' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.messages', () => ({ value: m.messages }))
  on('tool.list', () => ({ value: [{ name: 'mcp__nsrv__notion-query-data-sources', description: '', mcp: true }] }))
  on('model.complete', (_, e) => {
    m.prompts.push(String(e.prompt))
    if (opts.model === 'fail') return { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded' } as unknown as ModelCompleteResult }
    return {
      value: {
        isAnswered: true,
        text: MODEL_TEXT,
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    }
  })
  on('mcp.call', (_, e) => {
    if (e.tool === 'notion-update-page') {
      if (opts.notion === 'error') return { value: { content: [{ type: 'text', text: 'Forbidden' }], isError: true } }
      m.appends.push(e.args)
    }
    return { value: { content: [{ type: 'text', text: '{}' }], isError: false } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.run', () => ({}))
  return m
}

const start = ($: Engine) => $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
const devlog = ($: Engine, args = '') =>
  $.command.run({ command: 'devlog', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

// ---------- pure ----------

test('since-last starts after the stored point only in the same session', async () => {
  expect(startIndex(undefined, 's', 10)).toBe(0)
  expect(startIndex({ sessionId: 's', messageCount: 4, at: 1 }, 's', 10)).toBe(4)
  expect(startIndex({ sessionId: 'other', messageCount: 4, at: 1 }, 's', 10)).toBe(0)
  expect(startIndex({ sessionId: 's', messageCount: 40, at: 1 }, 's', 10)).toBe(10)
})

test('files, tasks and note are written by the mod, with task links', async () => {
  const files = filesTouched(msgs(2))
  expect(files).toEqual(['C:\\game\\src\\file0.gd', 'C:\\game\\src\\file1.gd'])
  const x = extras(files, [
    { at: 1, project: 'p', kind: 'started', title: 'Spawner', url: 'https://n/p/1' },
    { at: 2, project: 'p', kind: 'done', title: 'Spawner', url: 'https://n/p/1' },
  ], 'felt good')
  expect(x).toContain('`game/src/file0.gd`')
  expect(x).toContain('- Completed: [Spawner](https://n/p/1)')
  expect(x).not.toContain('Started: [Spawner]')
  expect(x).toContain('**Note**\nfelt good')
  expect(digest(msgs(1))).toContain('tool Edit C:\\game\\src\\file0.gd')
  const at = Date.UTC(2026, 10, 10, 12, 30)
  expect(entryHeading('Enemy spawner basics', at)).toBe('10/11/26 || Enemy spawner basics')
  expect(entryMarkdown('Tiny', 'body', at)).toBe('<toggle heading="h2">\n10/11/26 || Tiny\n\nbody\n</toggle>\n')
  expect(splitTitle('**Title:** Spawner work.\nRest')).toEqual({ title: 'Spawner work', rest: 'Rest' })
  expect(splitTitle('No title here')).toEqual({ title: '', rest: 'No title here' })
})

test('the title leads with the ticket number of the task worked on', () => {
  const ev = (title: string) => ({ at: 1, project: 'p', kind: 'started' as const, title, url: `https://n/${title}` })
  expect(ticketIds([ev('M1-02 · Playground: floor, light, camera'), ev('M1-02 · again'), ev('M1-03 · Camera')])).toEqual(['M1-02', 'M1-03'])
  expect(ticketIds([ev('Fix the build')])).toEqual([])
  // the model's own ID, whatever separator it used, gets " - "
  expect(withTicket('M1-02 - First playground scene created', [])).toBe('M1-02 - First playground scene created')
  expect(withTicket('M1-02: First playground scene', [])).toBe('M1-02 - First playground scene')
  expect(withTicket('M1-02 · First playground scene', [])).toBe('M1-02 - First playground scene')
  expect(withTicket('M1-02 First playground scene', [])).toBe('M1-02 - First playground scene')
  // /board task IDs the model left out go in front, once
  expect(withTicket('First playground scene', ['M1-02'])).toBe('M1-02 - First playground scene')
  expect(withTicket('M1-02 - Playground', ['M1-02', 'M1-03'])).toBe('M1-02, M1-03 - Playground')
  // no task, no prefix
  expect(withTicket('Board updates', [])).toBe('Board updates')
  expect(withTicket('Tuned the LOD-2 meshes', [])).toBe('Tuned the LOD-2 meshes')
})

// ---------- the pane ----------

test('/devlog drafts and shows Post, Edit, Cancel, posting nothing', OPTS, async ($, on) => {
  mock.store(on)
  const m = engine(on)
  await start($)
  await devlog($, 'spawner works')
  expect(m.prompts[0]).toContain('did step 1')
  expect(m.appends).toHaveLength(0)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'Built the enemy spawner.' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /10\/11\/26 \|\| Enemy spawner basics/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Title:/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'spawner works' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'post' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'edit' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'cancel' })).toBeDefined()
    await ui.unmount()
  }
  expect(m.appends).toHaveLength(0)
})

test('Cancel discards the draft and posts nothing', OPTS, async ($, on) => {
  mock.store(on)
  const m = engine(on)
  await start($)
  await devlog($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'cancel' })
  expect(await ui.find({ type: 'Text', text: /No draft/ })).toBeDefined()
  expect(m.appends).toHaveLength(0)
  await ui.unmount()
})

test('Edit changes the text that Post sends', OPTS, async ($, on) => {
  mock.store(on)
  const m = engine(on)
  await start($)
  await devlog($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'edit' })
  await ui.input({ key: 'draft-title', text: 'Renamed', kind: 'change' })
  await ui.input({ key: 'draft-text', text: 'My own words.' })
  expect(m.appends).toHaveLength(0)
  await ui.press({ key: 'post' })
  expect(m.appends).toHaveLength(1)
  expect(m.appends[0]).toEqual({
    page_id: PAGE,
    command: 'insert_content',
    content: '<toggle heading="h2">\n10/11/26 || Renamed\n\nMy own words.\n</toggle>\n',
    position: { type: 'end' },
  })
  expect(await ui.find({ type: 'Text', text: /Posted to the Notion devlog/ })).toBeDefined()
  await ui.unmount()
})

test('Post appends to the devlog page and the next /devlog starts after it', OPTS, async ($, on) => {
  mock.store(on)
  const m = engine(on)
  await start($)
  await devlog($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'post' })
  expect(m.appends).toHaveLength(1)
  expect(String(m.appends[0]?.content)).toContain('**Files**')
  await ui.unmount()

  // Nothing new: no model call, no draft.
  await devlog($)
  expect(m.prompts).toHaveLength(1)
  const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await again.find({ type: 'Text', text: /Nothing new since the last/ })).toBeDefined()
  await again.unmount()

  // New work: only the new messages are read.
  m.messages = [...m.messages, { role: 'user', text: 'step new', toolUses: [] }, { role: 'assistant', text: 'did the new step', toolUses: [] }]
  await devlog($)
  expect(m.prompts).toHaveLength(2)
  expect(m.prompts[1]).toContain('did the new step')
  expect(m.prompts[1]).not.toContain('did step 0')
})

test('a Notion error keeps the draft and the since-last point', OPTS, async ($, on) => {
  mock.store(on)
  const m = engine(on, { notion: 'error' })
  await start($)
  await devlog($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'post' })
  expect(await ui.find({ type: 'Text', text: /Not posted: Forbidden/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'post' })).toBeDefined()
  await ui.unmount()
  await devlog($)
  expect(m.prompts).toHaveLength(2)
  expect(m.prompts[1]).toContain('did step 0')
})

test('a failed model call shows why and posts nothing', OPTS, async ($, on) => {
  mock.store(on)
  const m = engine(on, { model: 'fail' })
  await start($)
  await devlog($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Couldn't write the draft/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'post' })).toBeUndefined()
  expect(m.appends).toHaveLength(0)
  await ui.unmount()
})

test('with no devlog page set, Post says so and posts nothing', async ($, on) => {
  mock.store(on)
  const m = engine(on)
  await start($)
  await devlog($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'post' })
  expect(await ui.find({ type: 'Text', text: /no devlog page is set/ })).toBeDefined()
  expect(m.appends).toHaveLength(0)
  await ui.unmount()
})
