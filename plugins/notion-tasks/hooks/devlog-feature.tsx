// /devlog [note]: draft an entry with a small model, show it with Post / Edit /
// Cancel, and append it to the Notion devlog page only on Post.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, SessionMessage } from 'claude-code'

import type { Draft } from '../types'
import {
  DRAFT_SYSTEM,
  digest,
  draftPrompt,
  entryBody,
  entryMarkdown,
  extras,
  filesTouched,
  loadEvents,
  loadLast,
  saveLast,
  startIndex,
} from './devlog'
import { appendToPage } from './notion'

type $ = EngineInterface

export const DEVLOG_PANE = 'notion-devlog'
const TITLE = 'Devlog draft'
/** Cheap, fast drafting: a digest goes to Haiku, never the whole transcript. */
export const DRAFT_MODEL = 'haiku'

const ORANGE = '#F97316'
const ORANGE_SOFT = '#FB923C'
const RED = '#EF4444'
const GREEN = '#22C55E'

const IDLE: Draft = {
  status: 'idle',
  body: '',
  error: '',
  project: '',
  sessionId: '',
  messageCount: 0,
  postedUrl: '',
}

const draftAtom = atom({ plugin: 'notion-tasks', key: 'draft' } as const, IDLE, { shape: 'draft-1' })

export type DevlogConfig = { devlogPage: string }

function toast($: $, text: string): void {
  try {
    $.ui.toast(text)
  } catch {
    // no surface to toast on
  }
}

function hasWork(messages: readonly SessionMessage[]): boolean {
  return messages.some(m => (m.role === 'assistant' && (m.text.trim() !== '' || m.toolUses.length > 0)))
}

/** Builds a draft; posts nothing. */
export async function makeDraft($: $, note: string): Promise<void> {
  await update($, draftAtom, () => ({ ...IDLE, status: 'drafting' }))
  const project = await $.session.cwd().catch(() => '')
  const sessionId = await $.session.id().catch(() => '')
  const found = await $.session.messages().catch(() => [] as SessionMessage[])
  const messages = Array.isArray(found) ? found : []
  const last = await loadLast($, project)
  const since = messages.slice(startIndex(last, sessionId, messages.length))
  const events = (await loadEvents($)).filter(e => e.project === project && e.at > (last?.at ?? 0))
  const base = { ...IDLE, project, sessionId, messageCount: messages.length }

  if (!hasWork(since) && events.length === 0 && note.trim() === '') {
    await update($, draftAtom, () => ({ ...base, status: 'error', error: 'Nothing new since the last /devlog.' }))
    return
  }

  let summary = ''
  if (hasWork(since)) {
    const r = await $.model
      .complete({ model: DRAFT_MODEL, system: DRAFT_SYSTEM, prompt: draftPrompt(digest(since)), maxTokens: 700 })
      .catch((err: unknown) => ({ isAnswered: false as const, reason: err instanceof Error ? err.message : String(err) }))
    if (!r.isAnswered) {
      await update($, draftAtom, () => ({ ...base, status: 'error', error: `Couldn't write the draft: ${String(r.reason)}` }))
      return
    }
    summary = r.text
  }
  const body = entryBody(summary, extras(filesTouched(since), events, note))
  await update($, draftAtom, () => ({ ...base, status: 'ready', body }))
}

/** Post: the only path to Notion. Moves the "since last" point on success. */
export async function postDraft($: $, cfg: DevlogConfig): Promise<void> {
  const draft = await read($, draftAtom)
  if (draft.status !== 'ready' || draft.body.trim() === '') return
  if (cfg.devlogPage === '') {
    await update($, draftAtom, (d): Draft => ({ ...d, error: 'Not posted: no devlog page is set (plugin option devlogPage).' }))
    return
  }
  await update($, draftAtom, (d): Draft => ({ ...d, status: 'posting', error: '' }))
  const now = await $.clock.now()
  const w = await appendToPage($, cfg.devlogPage, entryMarkdown(draft.body, now))
  if (!w.ok) {
    await update($, draftAtom, (d): Draft => ({ ...d, status: 'ready', error: `Not posted: ${w.error}` }))
    return
  }
  await saveLast($, draft.project, { sessionId: draft.sessionId, messageCount: draft.messageCount, at: now })
  await update($, draftAtom, (d): Draft => ({ ...d, status: 'posted', postedUrl: cfg.devlogPage }))
  toast($, 'Devlog entry posted to Notion')
}

export function devlogHooks(on: On, cfg: DevlogConfig): void {
  on('command.run', { command: 'devlog' }, async ($, e) => {
    await $.ui.open({ id: DEVLOG_PANE, title: TITLE })
    await makeDraft($, e.args)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: DEVLOG_PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = 'Input' in els ? els.Input : undefined
    const d = await read($, draftAtom)
    const set = (fn: (x: Draft) => Draft) => update($, draftAtom, fn)

    const header = (
      <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
        <Text color={ORANGE} bold>
          📓 Devlog
        </Text>
        <Text dimColor>
          {d.status === 'posted' ? 'posted' : d.status === 'idle' ? '' : 'draft, not posted'}
        </Text>
      </Box>
    )

    if (d.status === 'idle') {
      return (
        <Box flexDirection="column">
          {header}
          <Text dimColor>No draft. Type /devlog [note] to write one.</Text>
        </Box>
      )
    }
    if (d.status === 'drafting') {
      return (
        <Box flexDirection="column">
          {header}
          <Text color={ORANGE} italic>
            Writing the draft…
          </Text>
        </Box>
      )
    }
    if (d.status === 'posted') {
      return (
        <Box flexDirection="column">
          {header}
          <Text color={GREEN} bold>
            ✓ Posted to the Notion devlog.
          </Text>
          <Text dimColor>The next /devlog starts from here.</Text>
        </Box>
      )
    }
    if (d.status === 'error' && d.body === '') {
      return (
        <Box flexDirection="column">
          {header}
          <Text color={RED} wrap="wrap">
            {d.error}
          </Text>
          <Box flexDirection="row" marginTop={1}>
            <Button key="close" label="Close" onPress={() => set(() => IDLE)} />
          </Box>
        </Box>
      )
    }

    const isEditing = d.status === 'editing' && Input !== undefined
    return (
      <Box flexDirection="column">
        {header}
        {d.error !== '' && (
          <Text color={RED} wrap="wrap">
            {d.error}
          </Text>
        )}
        {isEditing ? (
          <Input
            key="draft-text"
            rows={14}
            value={d.body}
            submitLabel="save"
            onInput={(value: string) => void set((x): Draft => ({ ...x, body: value }))}
            onSubmit={(value: string) => void set((x): Draft => ({ ...x, body: value, status: 'ready' }))}
          />
        ) : (
          <Box
            key="draft"
            flexDirection="column"
            borderStyle="round"
            borderColor={ORANGE_SOFT}
            paddingX={1}
          >
            {d.body.split('\n').map(line => (
              <Text wrap="wrap" bold={line.startsWith('**')}>
                {line === '' ? ' ' : line.replace(/\*\*/g, '')}
              </Text>
            ))}
          </Box>
        )}
        <Box flexDirection="row" marginTop={1}>
          {isEditing ? (
            <Button key="save" label="Save edit" variant="primary" onPress={() => set((x): Draft => ({ ...x, status: 'ready' }))} />
          ) : d.status === 'posting' ? (
            <Text color={ORANGE} italic>
              Posting…
            </Text>
          ) : (
            <Button key="post" label="Post" variant="primary" onPress={() => postDraft($, cfg)} />
          )}
          <Text> </Text>
          {!isEditing && Input !== undefined && d.status === 'ready' && (
            <Button key="edit" label="Edit" onPress={() => set((x): Draft => ({ ...x, status: 'editing' }))} />
          )}
          {!isEditing && Input !== undefined && d.status === 'ready' && <Text> </Text>}
          {d.status !== 'posting' && (
            <Button
              key="cancel"
              label="Cancel"
              plain
              onPress={async () => {
                await set(() => IDLE)
                toast($, 'Devlog draft discarded; nothing was posted')
              }}
            />
          )}
        </Box>
      </Box>
    )
  })
}
