// Pure task logic: rows -> tasks, which to list, their order, and the message
// Claude receives. No engine calls here, so tests reach it directly.
import type { Task } from '../types'
import { pageIdOf, type Row } from './notion'

export const PROP = {
  title: 'Name',
  status: 'Status',
  priority: 'Priority',
  description: 'Description',
} as const

export const STATUS = { todo: 'To do', progress: 'In progress', done: 'Done' } as const

const STATUS_RANK: Record<string, number> = { [STATUS.progress]: 0, [STATUS.todo]: 1 }
const PRIORITY_RANK: Record<string, number> = { High: 0, Medium: 1, Low: 2 }

function str(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  return ''
}

export function toTask(row: Row): Task | undefined {
  const url = str(row.url)
  if (url === '') return undefined
  return {
    id: pageIdOf(url),
    url,
    title: str(row[PROP.title]).trim() || 'Untitled',
    status: str(row[PROP.status]) || STATUS.todo,
    priority: str(row[PROP.priority]),
    description: str(row[PROP.description]),
  }
}

/** Not Done: what the pane lists. */
export function isOpen(t: Task): boolean {
  return t.status !== STATUS.done
}

/** In progress first, then High -> Low -> no priority, then by title. */
export function compareTasks(a: Task, b: Task): number {
  const s = (STATUS_RANK[a.status] ?? 2) - (STATUS_RANK[b.status] ?? 2)
  if (s !== 0) return s
  const p = (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3)
  if (p !== 0) return p
  return a.title.localeCompare(b.title)
}

export function listTasks(rows: readonly Row[]): Task[] {
  return rows
    .map(toTask)
    .filter((t): t is Task => t !== undefined && isOpen(t))
    .sort(compareTasks)
}

/** The Notion filter matching `isOpen`, so Done rows never leave Notion. */
export const OPEN_FILTER = {
  type: 'group',
  operator: 'and',
  filters: [
    {
      type: 'property',
      property: PROP.status,
      propertyType: 'status',
      operator: 'status_is_not',
      value: { type: 'is_option', value: STATUS.done },
    },
  ],
} as const

/**
 * The message Claude receives for a started task. `body` is the page content
 * fetched at click time; undefined when the fetch failed.
 */
export function buildTaskPrompt(task: Task, body: string | undefined, opts: { writeBack: boolean }): string {
  const meta = [
    `Status: ${task.status}${opts.writeBack && task.status !== STATUS.progress ? ` → ${STATUS.progress}` : ''}`,
    task.priority !== '' ? `Priority: ${task.priority}` : '',
  ]
    .filter(s => s !== '')
    .join(' · ')
  const lines = [
    'Please work on this task from my Notion task board.',
    '',
    `## ${task.title}`,
    meta,
    `Notion page: ${task.url}`,
  ]
  if (task.description.trim() !== '') lines.push('', task.description.trim())
  if (body !== undefined && body.trim() !== '') {
    lines.push('', '### Task page', '', body.trim())
  } else if (body === undefined) {
    lines.push('', '(The task page body could not be fetched from Notion; the details above are all I have.)')
  }
  lines.push(
    '',
    opts.writeBack
      ? "When you're done, summarize what you did. Leave the task's status in Notion alone: I'll mark it Done from the /board panel."
      : "When you're done, summarize what you did.",
  )
  return lines.join('\n')
}
