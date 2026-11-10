import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, Task } from '../types'
import { fetchPage, queryRows, updateProperties } from './notion'
import { OPEN_FILTER, PROP, STATUS, buildTaskPrompt, listTasks } from './tasks'
import { recordEvent } from './devlog'
import { devlogHooks } from './devlog-feature'

type $ = EngineInterface

const PANE = 'notion-tasks'
const TITLE = 'Notion tasks'

const ORANGE = '#F97316'
const ORANGE_SOFT = '#FB923C'
const RED = '#EF4444'

const STATUS_COLOR: Record<string, string> = {
  [STATUS.todo]: '#6B7280',
  [STATUS.progress]: '#3B82F6',
  [STATUS.done]: '#22C55E',
}
const PRIORITY_COLOR: Record<string, string> = { High: RED, Medium: '#EAB308', Low: '#9CA3AF' }

const EMPTY: Board = { tasks: [], isLoading: false, error: '', loadedAt: 0 }

const boardAtom = atom({ plugin: 'notion-tasks', key: 'board' } as const, EMPTY, {
  shape: 'board-1',
})
const busyAtom = atom({ plugin: 'notion-tasks', key: 'isBusy' } as const, false)
const workingAtom = atom({ plugin: 'notion-tasks', key: 'working' } as const, {})

export type Config = { dataSource: string; writeBack: boolean; devlogPage: string }

export function configOf(options: Readonly<Record<string, unknown>>): Config {
  const ds = options.dataSource
  const page = options.devlogPage
  return {
    dataSource: typeof ds === 'string' && ds.trim() !== '' ? ds.trim() : '',
    writeBack: options.writeBack !== false,
    devlogPage: typeof page === 'string' ? page.trim() : '',
  }
}

function toast($: $, text: string): void {
  try {
    $.ui.toast(text)
  } catch {
    // no surface to toast on
  }
}

async function setWorking($: $, id: string, what: string | undefined): Promise<void> {
  await update($, workingAtom, w => {
    const next: Record<string, string> = { ...w }
    if (what === undefined) delete next[id]
    else next[id] = what
    return next
  })
}

export async function loadTasks($: $, cfg: Config): Promise<void> {
  await update($, boardAtom, b => ({ ...b, isLoading: true }))
  if (cfg.dataSource === '') {
    await update($, boardAtom, b => ({ ...b, isLoading: false, error: 'No Notion data source is set (plugin option dataSource).' }))
    return
  }
  const r = await queryRows($, cfg.dataSource, { filter: OPEN_FILTER })
  const now = await $.clock.now().catch(() => 0)
  if (!r.ok) {
    await update($, boardAtom, b => ({ ...b, isLoading: false, error: r.error }))
    return
  }
  await update($, boardAtom, () => ({ tasks: listTasks(r.value), isLoading: false, error: '', loadedAt: now }))
}

/** ▶: fetch the page now, hand it to Claude, then (if allowed) mark it In progress. */
export async function startTask($: $, cfg: Config, task: Task): Promise<void> {
  await setWorking($, task.id, 'starting')
  try {
    const page = await fetchPage($, task.id)
    const text = buildTaskPrompt(task, page.ok ? page.value.body : undefined, cfg)
    const sent = await $.prompt.submit({ text, asUser: true })
    if (sent.drop !== undefined) {
      toast($, `Task not sent: ${sent.drop}`)
      return
    }
    await recordEvent($, { kind: 'started', title: task.title, url: task.url })
    if (cfg.writeBack && task.status !== STATUS.progress) {
      const w = await updateProperties($, task.id, { [PROP.status]: STATUS.progress })
      if (!w.ok) toast($, `Sent to Claude, but Notion status not updated: ${w.error}`)
    }
    toast($, (await read($, busyAtom)) ? `Queued: ${task.title}` : `Started: ${task.title}`)
  } finally {
    await setWorking($, task.id, undefined)
  }
  await loadTasks($, cfg)
}

/** ✓ Done: set the task's Status to Done; only with write-back on. */
export async function finishTask($: $, cfg: Config, task: Task): Promise<void> {
  if (!cfg.writeBack) return
  await setWorking($, task.id, 'finishing')
  const w = await updateProperties($, task.id, { [PROP.status]: STATUS.done })
  await setWorking($, task.id, undefined)
  toast($, w.ok ? `Done: ${task.title}` : `Couldn't mark done: ${w.error}`)
  if (w.ok) {
    await recordEvent($, { kind: 'done', title: task.title, url: task.url })
    await loadTasks($, cfg)
  }
}

function ago(ms: number, now: number): string {
  if (ms === 0) return 'never'
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`
}

export const register: Register = (on, options) => {
  const cfg = configOf(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'board', description: 'Open your Notion tasks; ▶ hands one to Claude' })
    await $.command.register({
      name: 'devlog',
      description: 'Draft a devlog entry for the work since the last one; posts to Notion only when you press Post',
    })
    return next(e)
  })

  devlogHooks(on, cfg)

  on('command.run', { command: 'board' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    await loadTasks($, cfg)
    return {}
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await update($, busyAtom, () => true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!('agentId' in e) || e.agentId === undefined) await update($, busyAtom, () => false)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const board = await read($, boardAtom)
    const isBusy = await read($, busyAtom)
    const working = await read($, workingAtom)
    const now = await $.clock.now().catch(() => 0)

    const refresh = (
      <Button key="refresh" label={board.isLoading ? '↻ Loading…' : '↻'} plain onPress={() => loadTasks($, cfg)} />
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
          <Text color={ORANGE} bold>
            ☰ Tasks
          </Text>
          <Box flexDirection="row">
            <Text dimColor>
              {board.tasks.length} open · {board.isLoading ? 'loading' : ago(board.loadedAt, now)}{' '}
            </Text>
            {refresh}
          </Box>
        </Box>

        {isBusy && (
          <Text dimColor italic>
            Claude is busy: ▶ queues the task to run after this turn.
          </Text>
        )}

        {board.error !== '' && (
          <Box
            key="error"
            flexDirection="column"
            borderStyle="round"
            borderColor={RED}
            paddingX={1}
            marginBottom={1}
          >
            <Text color={RED} bold>
              Can't reach Notion
            </Text>
            <Text dimColor wrap="wrap">
              {board.error}
            </Text>
            <Box flexDirection="row" marginTop={1}>
              <Button key="retry" label="Retry" variant="primary" onPress={() => loadTasks($, cfg)} />
            </Box>
          </Box>
        )}

        {board.error === '' && board.tasks.length === 0 && (
          <Text dimColor>
            {board.isLoading || board.loadedAt === 0 ? 'Loading tasks from Notion…' : 'No open tasks. Add some in Notion, then ↻.'}
          </Text>
        )}

        {board.tasks.map(task => {
          const doing = working[task.id]
          return (
            <Box
              key={`task:${task.id}`}
              flexDirection="column"
              borderStyle="round"
              borderColor={ORANGE_SOFT}
              borderDimColor
              hover={{ borderColor: ORANGE, borderDimColor: false }}
              paddingX={1}
              marginBottom={1}
            >
              <Text bold wrap="wrap">
                {task.title}
              </Text>
              <Box flexDirection="row">
                <Text color="#FFFFFF" backgroundColor={STATUS_COLOR[task.status] ?? '#6B7280'}>
                  {` ${task.status} `}
                </Text>
                {task.priority !== '' && (
                  <Text color={PRIORITY_COLOR[task.priority] ?? '#9CA3AF'}> ● {task.priority}</Text>
                )}
              </Box>
              {task.description !== '' && (
                <Text dimColor wrap="wrap">
                  {task.description}
                </Text>
              )}
              <Box flexDirection="row" marginTop={1}>
                {doing !== undefined ? (
                  <Text color={ORANGE} italic>
                    {doing === 'starting' ? 'Sending to Claude…' : 'Marking done…'}
                  </Text>
                ) : (
                  <Button
                    key={`start:${task.id}`}
                    label={isBusy ? '▶ Queue' : '▶ Start'}
                    variant="primary"
                    onPress={() => startTask($, cfg, task)}
                  />
                )}
                {doing === undefined && cfg.writeBack && <Text> </Text>}
                {doing === undefined && cfg.writeBack && (
                  <Button key={`done:${task.id}`} label="✓ Done" onPress={() => finishTask($, cfg, task)} />
                )}
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  })
}
