import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import type { Bookmark, BookmarkView } from '../types'

const PLUGIN = 'bookmarks'
const PANE = 'bookmarks'
const STORE_KEY = 'bookmarks-v1'
const MAX = 500

const ORANGE = '#F97316'
const ORANGE_SOFT = '#FB923C'

// The list mirrors $.store (kept across sessions) so drawings redraw on write.
const listAtom = atom({ plugin: 'bookmarks', key: 'list' } as const, [], {
  shape: 'bookmarks-1',
})
const viewAtom = atom({ plugin: 'bookmarks', key: 'view' } as const, {
  query: '',
  showAll: false,
  confirmDelete: '',
})
const markersAtom = atom({ plugin: 'bookmarks', key: 'markers' } as const, {})
const sessionAtom = atom({ plugin: 'bookmarks', key: 'sessionId' } as const, '')

type $ = EngineInterface

// ---------- pure helpers (exported for tests) ----------

export function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function excerpt(text: string, max: number): string {
  const flat = squash(text)
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return (space > max * 0.6 ? cut.slice(0, space) : cut) + '…'
}

function isCommandEcho(text: string): boolean {
  const t = text.trim()
  return (
    t.startsWith('/') ||
    t.includes('<command-name>') ||
    t.includes('<local-command') ||
    t.includes('<command-message>')
  )
}

export function pickExcerpts(messages: readonly SessionMessage[]): {
  user: string
  assistant: string
  first: string
} {
  const prompts = messages.filter(
    m => m.role === 'user' && m.text.trim() !== '' && !isCommandEcho(m.text),
  )
  const replies = messages.filter(m => m.role === 'assistant' && m.text.trim() !== '')

  return {
    user: prompts.at(-1)?.text ?? '',
    assistant: replies.at(-1)?.text ?? '',
    first: prompts[0]?.text ?? '',
  }
}

export function autoLabel(user: string, assistant: string, when: number): string {
  const source = squash(user) || squash(assistant)
  if (source === '') return `Bookmark ${clockTime(when)}`
  const words = source.split(' ').slice(0, 7).join(' ')

  return excerpt(words, 48)
}

function clockTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = new Date(ms)

  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function matches(b: Bookmark, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  return [b.label, b.note, b.user, b.assistant, b.sessionLabel].some(s =>
    s.toLowerCase().includes(q),
  )
}

export function visible(list: readonly Bookmark[], view: BookmarkView, sessionId: string): Bookmark[] {
  return list
    .filter(b => view.showAll || b.sessionId === sessionId)
    .filter(b => matches(b, view.query))
    .sort((a, b) => b.createdAt - a.createdAt)
}

export function asText(b: Bookmark): string {
  const lines = [`🔖 ${b.label}`, new Date(b.createdAt).toLocaleString()]
  if (b.note !== '' && b.note !== b.label) lines.push(`Note: ${b.note}`)
  if (b.user !== '') lines.push(`You: ${b.user}`)
  if (b.assistant !== '') lines.push(`Claude: ${b.assistant}`)
  if (b.sessionLabel !== '') lines.push(`Session: ${b.sessionLabel} (${b.sessionId})`)
  return lines.join('\n')
}

// ---------- storage ----------

function isBookmark(v: unknown): v is Bookmark {
  if (typeof v !== 'object' || v === null) return false
  const b = v as Record<string, unknown>
  return typeof b.id === 'string' && typeof b.createdAt === 'number' && typeof b.label === 'string'
}

async function loadStore($: $): Promise<Bookmark[]> {
  const raw = await $.store.get(STORE_KEY)
  if (!Array.isArray(raw)) return []
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  return raw.filter(isBookmark).map(b => ({
    id: b.id,
    createdAt: b.createdAt,
    label: b.label,
    note: str(b.note),
    user: str(b.user),
    assistant: str(b.assistant),
    sessionId: str(b.sessionId),
    sessionLabel: str(b.sessionLabel),
  }))
}

/** Read-modify-write against the store, so other sessions' saves are kept. */
async function mutate($: $, fn: (list: Bookmark[]) => Bookmark[]): Promise<Bookmark[]> {
  const next = fn(await loadStore($)).slice(-MAX)
  await $.store.set(STORE_KEY, next)
  await update($, listAtom, () => next)
  return next
}

async function refresh($: $): Promise<void> {
  const list = await loadStore($)
  await update($, listAtom, () => list)
}

async function sessionIdOf($: $): Promise<string> {
  const known = await read($, sessionAtom)
  if (known !== '') return known
  const id = await $.session.id().catch(() => '')
  if (id !== '') await update($, sessionAtom, () => id)
  return id
}

function toast($: $, text: string): void {
  try {
    $.ui.toast(text)
  } catch {
    // no surface to toast on
  }
}

function newId(now: number): string {
  const rand = Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, '0')
  return `bm-${now.toString(36)}-${rand}`
}

export async function saveBookmark($: $, args: string): Promise<Bookmark> {
  const now = await $.clock.now()
  const found = await $.session.messages().catch(() => [] as SessionMessage[])
  const messages = Array.isArray(found) ? found : []
  const picked = pickExcerpts(messages)
  const note = squash(args)
  const bookmark: Bookmark = {
    id: newId(now),
    createdAt: now,
    note,
    label: note !== '' ? excerpt(note, 80) : autoLabel(picked.user, picked.assistant, now),
    user: excerpt(picked.user, 220),
    assistant: excerpt(picked.assistant, 220),
    sessionId: await sessionIdOf($),
    sessionLabel: excerpt(picked.first, 48),
  }
  await mutate($, list => [...list, bookmark])

  // A marker row at the transcript's end: what Jump scrolls back to.
  const placed = await $.ui.place({ id: bookmark.id }).catch(() => undefined)
  if (placed?.requestId) {
    const requestId = placed.requestId
    await update($, markersAtom, m => ({ ...m, [bookmark.id]: requestId }))
  }

  return bookmark
}

// ---------- hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'bookmark',
      description: 'Bookmark this point in the session: /bookmark [note]',
    })
    await $.command.register({
      name: 'bookmarks',
      description: 'Open the bookmarks pane',
    })
    await refresh($).catch(() => undefined)
    await sessionIdOf($)

    return next(e)
  })

  on('command.run', { command: 'bookmark' }, async ($, e) => {
    const b = await saveBookmark($, e.args)
    toast($, `🔖 Bookmarked: ${b.label}`)

    return {}
  })

  on('command.run', { command: 'bookmarks' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Bookmarks' })

    return {}
  })

  // The marker row /bookmark leaves in the transcript.
  on('ui.render', { component: 'Placed' }, async ($, e, next) => {
    if (e.props.plugin !== PLUGIN) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const b = (await read($, listAtom)).find(one => one.id === e.props.id)
    if (b === undefined) {
      return (
        <Box>
          <Text dimColor>🔖 bookmark removed</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="row">
        <Text color={ORANGE} bold>
          🔖 Bookmark{' '}
        </Text>
        <Text>{b.label}</Text>
        <Text dimColor> · {clockTime(b.createdAt)}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    // The mobile app draws no text field yet: no search box there.
    const Input = 'Input' in els ? els.Input : undefined
    const list = await read($, listAtom)
    const view = await read($, viewAtom)
    const markers = await read($, markersAtom)
    const sessionId = await read($, sessionAtom)
    const now = await $.clock.now()
    const shown = visible(list, view, sessionId)
    const hereCount = list.filter(b => b.sessionId === sessionId).length

    const setView = (fn: (v: BookmarkView) => BookmarkView) => update($, viewAtom, fn)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
          <Text color={ORANGE} bold>
            🔖 Bookmarks
          </Text>
          <Text dimColor>
            {shown.length} shown · {hereCount} here · {list.length} total
          </Text>
        </Box>

        {Input !== undefined && (
          <Input
            key="search"
            placeholder="Search notes and excerpts"
            value={view.query}
            submitLabel="filter"
            onInput={(value: string) => void setView(v => ({ ...v, query: value }))}
            onSubmit={(value: string) => void setView(v => ({ ...v, query: value }))}
          />
        )}

        <Box flexDirection="row" marginTop={1} marginBottom={1}>
          <Button
            key="scope:here"
            label="This session"
            variant={view.showAll ? 'secondary' : 'primary'}
            onPress={() => void setView(v => ({ ...v, showAll: false }))}
          />
          <Text> </Text>
          <Button
            key="scope:all"
            label="All sessions"
            variant={view.showAll ? 'primary' : 'secondary'}
            onPress={() => void setView(v => ({ ...v, showAll: true }))}
          />
          {view.query !== '' && <Text> </Text>}
          {view.query !== '' && (
            <Button
              key="clear"
              label="Clear search"
              plain
              onPress={() => void setView(v => ({ ...v, query: '' }))}
            />
          )}
        </Box>

        {shown.length === 0 && (
          <Text dimColor>
            {list.length === 0
              ? 'No bookmarks yet. Type /bookmark [note] to save this point.'
              : view.query !== ''
                ? 'Nothing matches that search.'
                : view.showAll
                  ? 'No bookmarks.'
                  : 'No bookmarks in this session. Try All sessions.'}
          </Text>
        )}

        {shown.map(b => {
          const marker = markers[b.id]
          const isHere = b.sessionId === sessionId
          const confirming = view.confirmDelete === b.id

          return (
            <Box
              key={`bm:${b.id}`}
              flexDirection="column"
              borderStyle="round"
              borderColor={ORANGE_SOFT}
              borderDimColor
              hover={{ borderColor: ORANGE, borderDimColor: false }}
              paddingX={1}
              marginBottom={1}
            >
              <Box flexDirection="row" justifyContent="space-between">
                <Text bold color={ORANGE}>
                  {b.label}
                </Text>
                <Text dimColor>{ago(b.createdAt, now)}</Text>
              </Box>
              {b.note === '' && <Text dimColor italic>auto label</Text>}
              {b.user !== '' && (
                <Text dimColor wrap="wrap">
                  You: {b.user}
                </Text>
              )}
              {b.assistant !== '' && (
                <Text dimColor wrap="wrap">
                  Claude: {b.assistant}
                </Text>
              )}
              {!isHere && b.sessionLabel !== '' && (
                <Text dimColor italic>
                  from: {b.sessionLabel}
                </Text>
              )}
              <Box flexDirection="row" marginTop={1}>
                {marker !== undefined && (
                  <Button
                    key={`jump:${b.id}`}
                    label="Jump"
                    variant="primary"
                    onPress={async () => {
                      try {
                        const r = await $.ui.scroll({ to: { requestId: marker }, block: 'center' })
                        if ('deny' in r) toast($, `Can't jump there: ${String(r.deny)}`)
                      } catch (err) {
                        toast($, `Can't jump there: ${err instanceof Error ? err.message : String(err)}`)
                      }
                    }}
                  />
                )}
                {marker !== undefined && <Text> </Text>}
                <Button
                  key={`copy:${b.id}`}
                  label="Copy"
                  onPress={async press => {
                    const r = await $.ui.copy({ text: asText(b), surface: press.surface })
                    toast($, r.isCopied ? 'Bookmark copied' : `Copy failed: ${r.reason}`)
                  }}
                />
                <Text> </Text>
                <Button
                  key={`del:${b.id}`}
                  label={confirming ? 'Confirm delete' : 'Delete'}
                  variant={confirming ? 'primary' : 'secondary'}
                  onPress={async () => {
                    if (!confirming) {
                      await setView(v => ({ ...v, confirmDelete: b.id }))
                      return
                    }
                    await mutate($, l => l.filter(one => one.id !== b.id))
                    await setView(v => ({ ...v, confirmDelete: '' }))
                  }}
                />
                {confirming && <Text> </Text>}
                {confirming && (
                  <Button
                    key={`keep:${b.id}`}
                    label="Cancel"
                    plain
                    onPress={() => void setView(v => ({ ...v, confirmDelete: '' }))}
                  />
                )}
                {marker === undefined && (
                  <Text dimColor>
                    {'  '}
                    {isHere ? 'no marker since restart' : 'other session: no jump'}
                  </Text>
                )}
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  })
}
