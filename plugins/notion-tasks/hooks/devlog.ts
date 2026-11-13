// /devlog: pure parts (digest, files, entry text) and the $.store bookkeeping
// (board events, the "since last devlog" point per project).
import type { EngineInterface, SessionMessage } from 'claude-code'

type $ = EngineInterface

export const EVENTS_KEY = 'board-events-v1'
export const LAST_KEY = 'devlog-last-v1'
const MAX_EVENTS = 300

export type BoardEvent = {
  at: number
  project: string
  kind: 'started' | 'done'
  title: string
  url: string
}

/** Where the previous /devlog for a project stopped reading. */
export type LastPoint = { sessionId: string; messageCount: number; at: number }

// ---------- store ----------

function isEvent(v: unknown): v is BoardEvent {
  if (typeof v !== 'object' || v === null) return false
  const e = v as Record<string, unknown>
  return typeof e.at === 'number' && typeof e.project === 'string' && typeof e.title === 'string' &&
    typeof e.url === 'string' && (e.kind === 'started' || e.kind === 'done')
}

export async function loadEvents($: $): Promise<BoardEvent[]> {
  const raw = await $.store.get(EVENTS_KEY).catch(() => undefined)
  return Array.isArray(raw) ? raw.filter(isEvent) : []
}

export async function recordEvent($: $, ev: Omit<BoardEvent, 'at' | 'project'>): Promise<void> {
  try {
    const at = await $.clock.now()
    const project = await $.session.cwd()
    const list = await loadEvents($)
    await $.store.set(EVENTS_KEY, [...list, { ...ev, at, project }].slice(-MAX_EVENTS))
  } catch {
    // bookkeeping only: never fail a start or a done over it
  }
}

export async function loadLast($: $, project: string): Promise<LastPoint | undefined> {
  const raw = await $.store.get(LAST_KEY).catch(() => undefined)
  if (typeof raw !== 'object' || raw === null) return undefined
  const p = (raw as Record<string, unknown>)[project]
  if (typeof p !== 'object' || p === null) return undefined
  const l = p as Record<string, unknown>
  if (typeof l.sessionId !== 'string' || typeof l.messageCount !== 'number' || typeof l.at !== 'number') return undefined
  return { sessionId: l.sessionId, messageCount: l.messageCount, at: l.at }
}

export async function saveLast($: $, project: string, point: LastPoint): Promise<void> {
  const raw = await $.store.get(LAST_KEY).catch(() => undefined)
  const all = typeof raw === 'object' && raw !== null ? { ...(raw as Record<string, unknown>) } : {}
  all[project] = point
  await $.store.set(LAST_KEY, all)
}

// ---------- pure ----------

/** First message index to read: after the last point when it is this session's. */
export function startIndex(last: LastPoint | undefined, sessionId: string, total: number): number {
  if (last === undefined || last.sessionId !== sessionId) return 0
  return Math.min(Math.max(0, last.messageCount), total)
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** Files changed by Edit/Write tools in these messages, in first-touch order. */
export function filesTouched(messages: readonly SessionMessage[]): string[] {
  const seen: string[] = []
  for (const m of messages) {
    for (const t of m.toolUses) {
      if (!EDIT_TOOLS.has(t.tool)) continue
      const p = t.input.file_path ?? t.input.notebook_path
      if (typeof p === 'string' && !seen.includes(p)) seen.push(p)
    }
  }
  return seen
}

function squash(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

function isEcho(text: string): boolean {
  return /<command-name>|<local-command|<command-message>/.test(text)
}

/** A compact transcript for the drafting model: newest kept when too long. */
export function digest(messages: readonly SessionMessage[], maxChars = 12000): string {
  const lines: string[] = []
  for (const m of messages) {
    if (m.role === 'user' && m.text.trim() !== '' && !isEcho(m.text)) lines.push(`USER: ${squash(m.text, 400)}`)
    if (m.role === 'assistant') {
      if (m.text.trim() !== '') lines.push(`CLAUDE: ${squash(m.text, 500)}`)
      for (const t of m.toolUses) {
        const target = t.input.file_path ?? t.input.command ?? t.input.pattern ?? ''
        lines.push(`  tool ${t.tool}${typeof target === 'string' && target !== '' ? ` ${squash(target, 120)}` : ''}${t.isError === true ? ' (error)' : ''}`)
      }
    }
  }
  let out = lines.join('\n')
  if (out.length > maxChars) out = `…\n${out.slice(out.length - maxChars)}`
  return out
}

export const DRAFT_SYSTEM =
  'You write short game-dev devlog entries from a coding session transcript. ' +
  'Output Markdown only, exactly this shape and nothing else:\n' +
  'Title: a tiny title for the session, 3 to 6 words, no trailing period. ' +
  'If the session worked on a task with an ID like M1-02, start with the ID and " - ", ' +
  'e.g. "Title: M1-02 - First playground scene created"\n' +
  'One plain sentence summarizing the session.\n\n' +
  '**Done**\n- bullet\n\n**Open problems**\n- bullet (or "- None")\n\n' +
  'At most 6 Done bullets, terse, past tense, concrete. No headings, no file list, no preamble.'

export function draftPrompt(transcript: string): string {
  return `Transcript of the work since the last devlog:\n\n${transcript}\n\nWrite the entry.`
}

/** The parts the mod writes itself: files, /board tasks (linked), the note. */
export function extras(files: readonly string[], events: readonly BoardEvent[], note: string): string {
  const parts: string[] = []
  if (files.length > 0) {
    const shown = files.slice(0, 12).map(f => `- \`${f.replace(/\\/g, '/').split('/').slice(-3).join('/')}\``)
    if (files.length > 12) shown.push(`- …and ${files.length - 12} more`)
    parts.push(`**Files**\n${shown.join('\n')}`)
  }
  if (events.length > 0) {
    const byTask = new Map<string, BoardEvent>()
    for (const e of events) byTask.set(e.url, byTask.get(e.url)?.kind === 'done' ? byTask.get(e.url)! : e)
    const rows = [...byTask.values()].map(e => `- ${e.kind === 'done' ? 'Completed' : 'Started'}: [${e.title}](${e.url})`)
    parts.push(`**Tasks**\n${rows.join('\n')}`)
  }
  if (note.trim() !== '') parts.push(`**Note**\n${note.trim()}`)
  return parts.join('\n\n')
}

export function entryBody(modelText: string, extra: string): string {
  return [modelText.trim(), extra].filter(s => s !== '').join('\n\n')
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Splits the model's `Title: …` first line off its reply. */
export function splitTitle(modelText: string): { title: string; rest: string } {
  const text = modelText.trim()
  const m = /^\**title\**\s*:\s*(.+)\n?/i.exec(text)
  if (m?.[1] === undefined) return { title: '', rest: text }
  return { title: m[1].replace(/\*+/g, '').trim().replace(/\.$/, ''), rest: text.slice(m[0].length).trim() }
}

const TICKET = /\b[A-Z][A-Z0-9]*-\d+\b/g

/** Ticket IDs (like `M1-02`) in the titles of the /board tasks, first seen first. */
export function ticketIds(events: readonly BoardEvent[]): string[] {
  const ids: string[] = []
  for (const e of events) for (const id of e.title.match(TICKET) ?? []) if (!ids.includes(id)) ids.push(id)
  return ids
}

/**
 * `M1-02 - rest`: a leading ticket ID gets the ` - ` separator, and the IDs of
 * /board tasks the title is missing go in front.
 */
export function withTicket(title: string, ids: readonly string[]): string {
  const t = title.replace(/\s+/g, ' ').trim()
  const lead = /^((?:[A-Z][A-Z0-9]*-\d+)(?:\s*[,&+]\s*[A-Z][A-Z0-9]*-\d+)*)\s*(?:[:·|–—-]\s*)?(.*)$/.exec(t)
  const have = lead?.[1] !== undefined ? (lead[1].match(TICKET) ?? []) : []
  const rest = lead?.[1] !== undefined ? (lead[2] ?? '').trim() : t
  const all = [...have, ...ids.filter(id => !have.includes(id))]
  if (all.length === 0) return t
  return rest === '' ? all.join(', ') : `${all.join(', ')} - ${rest}`
}

/** `10/11/26` (DD/MM/YY, local time). */
export function shortDate(at: number): string {
  const d = new Date(at)
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${pad(d.getFullYear() % 100)}`
}

/** The heading line: `DD/MM/YY || tiny title`. */
export function entryHeading(title: string, at: number): string {
  const t = title.replace(/\s+/g, ' ').trim()
  return t === '' ? shortDate(at) : `${shortDate(at)} || ${t}`
}

/** One entry as a collapsible h2 toggle holding the body. */
export function entryMarkdown(title: string, body: string, at: number): string {
  return `<toggle heading="h2">\n${entryHeading(title, at)}\n\n${body.trim()}\n</toggle>\n`
}
