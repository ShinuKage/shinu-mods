import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const PANE = {
  plugin: 'bookmarks',
  component: 'Pane',
  requestId: 'bookmarks',
  props: {
    title: 'Bookmarks',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

let placed = 0

function engine(on: On, opts: { sessionId?: string; now?: number } = {}) {
  let now = opts.now ?? Date.UTC(2026, 10, 9, 12, 0, 0)
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.place', () => ({ value: { isPlaced: true, requestId: `row-${++placed}` } }))
  on('session.id', () => ({ value: opts.sessionId ?? 'sess-A' }))
  on('clock.now', () => ({ value: (now += 1000) }))
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'Refactor the login form to use hooks', toolUses: [] },
      { role: 'assistant', text: 'Done: the form now uses useState and useEffect.', toolUses: [] },
      { role: 'user', text: '/bookmark', toolUses: [] },
    ],
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.run', () => ({}))
}

const start = ($: Engine) =>
  $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

const bm = ($: Engine, args: string) =>
  $.command.run({
    command: 'bookmark',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })


test('add, list newest first, auto label and excerpts', async ($, on) => {
  mock.store(on)
  engine(on)
  await start($)

  await bm($, '')
  await bm($, 'before the big refactor')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const labels = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    const iNote = labels.indexOf('before the big refactor')
    const iAuto = labels.indexOf('Refactor the login form to use hooks')
    expect(iNote).toBeGreaterThan(-1)
    expect(iAuto).toBeGreaterThan(iNote) // newest first
    expect(await ui.find({ type: 'Text', text: /You: Refactor the login form/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Claude: Done: the form/ })).toBeDefined()
    expect(await ui.findAll({ type: 'Button', key: undefined })).toBeDefined()
    await ui.unmount()
  }
})

test('delete asks to confirm, then removes from the pane and the store', async ($, on) => {
  mock.store(on)
  engine(on)
  await start($)
  await bm($, 'keep me')
  await bm($, 'drop me')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const buttons = await ui.findAll({ type: 'Button' })
  const del = buttons.find(b => b.key?.startsWith('del:'))! // newest: "drop me"
  await ui.press({ key: del.key! })
  expect(await ui.find({ type: 'Button', text: /Confirm delete/ })).toBeDefined()
  await ui.press({ key: del.key! })

  expect(await ui.find({ type: 'Text', text: 'drop me' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'keep me' })).toBeDefined()
  await ui.unmount()

  // /bookmarks reloads the list from the store: the deleted one must stay gone.
  await $.command.run({
    command: 'bookmarks',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  const again = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await again.find({ type: 'Text', text: 'drop me' })).toBeUndefined()
  expect(await again.find({ type: 'Text', text: 'keep me' })).toBeDefined()
  await again.unmount()
})

test('search filters, and the session toggle shows other sessions', async ($, on) => {
  mock.store(on, {
    'bookmarks-v1': [
      {
        id: 'bm-old-1', createdAt: 1, note: 'from yesterday', label: 'from yesterday',
        user: 'old prompt', assistant: 'old reply', sessionId: 'sess-OLD', sessionLabel: 'old session',
      },
    ],
  })
  engine(on)
  await start($)
  await bm($, 'alpha point')
  await bm($, 'beta point')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'from yesterday' })).toBeUndefined()

  await ui.input({ key: 'search', text: 'alpha' })
  expect(await ui.find({ type: 'Text', text: 'alpha point' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'beta point' })).toBeUndefined()

  await ui.input({ key: 'search', text: '' })
  await ui.press({ key: 'scope:all' })
  expect(await ui.find({ type: 'Text', text: 'from yesterday' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /from: old session/ })).toBeDefined()
  // A bookmark from another session has no marker row to jump to.
  expect(await ui.find({ type: 'Button', key: 'jump:bm-old-1' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /other session: no jump/ })).toBeDefined()
  await ui.unmount()
})

test('bookmarks persist across a reload: a fresh load reads them from the store', async ($, on) => {
  // What an earlier load wrote: the store survives, the module's state starts over.
  mock.store(on, {
    'bookmarks-v1': [
      {
        id: 'bm-a', createdAt: 1000, note: 'saved earlier', label: 'saved earlier',
        user: 'u', assistant: 'a', sessionId: 'sess-A', sessionLabel: 's',
      },
    ],
  })
  engine(on)
  await start($)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'saved earlier' })).toBeDefined()
  // No marker in this process, so no Jump.
  expect(await ui.find({ type: 'Button', key: 'jump:bm-a' })).toBeUndefined()
  await ui.unmount()
})

test('a fresh bookmark can jump to its marker row', async ($, on) => {
  mock.store(on)
  engine(on)
  await start($)
  await bm($, 'jump here')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const jump = (await ui.findAll({ type: 'Button' })).find(b => b.key?.startsWith('jump:'))
  expect(jump).toBeDefined()
  // The kit has no transcript to scroll; the press must still settle cleanly
  // (a failed jump becomes a toast, never a skipped hook).
  await ui.press({ key: jump!.key! })
  await ui.unmount()
})

test('the empty pane says how to start', async ($, on) => {
  mock.store(on)
  engine(on)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect(await ui.find({ type: 'Text', text: /No bookmarks yet/ })).toBeDefined()
  await ui.unmount()
})
