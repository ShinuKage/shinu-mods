// The /play run panel's pure parts: splitting a stream into lines, telling errors
// and warnings apart, the buffer cap, and the text Claude's tools return.
import type { RunIssue, RunLine, RunLineKind, RunState, RunStatus } from '../../types'

export const MAX_LINES = 2000
const MAX_ISSUES = 100

export const EMPTY_RUN: RunState = {
  id: 0,
  status: 'idle',
  code: null,
  project: '',
  scene: '',
  isHeadless: false,
  by: 'person',
  startedAt: 0,
  endedAt: 0,
  lines: [],
  dropped: 0,
  issues: [],
  detail: '',
}

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g
const ERROR_HEAD = /^(USER )?(SCRIPT )?ERROR:\s*(.*)$/
const WARNING_HEAD = /^(USER )?(SCRIPT )?WARNING:\s*(.*)$/
const CRASH = /CrashHandlerException|Program crashed with signal|^={20,}$|Dumping the backtrace/
const RES_PLACE = /res:\/\/[^\s:()]+:\d+/

/** Splits pieces of one stream into whole lines, holding a trailing partial line. */
export class LineSplitter {
  private rest = ''
  push(text: string): string[] {
    const all = (this.rest + text).replace(ANSI, '').split('\n')
    this.rest = all.pop() ?? ''
    return all.map(line => line.replace(/\r$/, ''))
  }
  flush(): string[] {
    const last = this.rest.replace(/\r$/, '')
    this.rest = ''
    return last === '' ? [] : [last]
  }
}

/**
 * Reads lines of one stream in order. An `ERROR:` / `WARNING:` line opens an
 * issue; the indented `at:` and backtrace lines after it belong to it and
 * give it its place (`res://file.gd:line`).
 */
export class Classifier {
  private open: RunIssue | undefined
  read(text: string, stream: 'stdout' | 'stderr'): { line: RunLine; issue?: RunIssue } {
    const error = ERROR_HEAD.exec(text)
    const warning = error === null ? WARNING_HEAD.exec(text) : null
    if (error !== null || warning !== null) {
      const kind = error !== null ? 'error' : 'warning'
      const head = (error ?? warning) as RegExpExecArray
      const message = (head[3] ?? '').trim()
      const place = RES_PLACE.exec(message)?.[0] ?? ''
      this.open = { kind, message, place }
      return { line: { text, kind }, issue: this.open }
    }
    if (CRASH.test(text)) {
      this.open = undefined
      return { line: { text, kind: 'error' } }
    }
    const isIndented = /^\s+\S/.test(text)
    if (isIndented && this.open !== undefined) {
      const place = RES_PLACE.exec(text)?.[0]
      if (place !== undefined && this.open.place === '') this.open.place = place
      return { line: { text, kind: 'trace' } }
    }
    if (RES_PLACE.test(text) && isIndented) return { line: { text, kind: 'trace' } }
    this.open = undefined
    const kind: RunLineKind = stream === 'stderr' ? 'err' : 'out'
    return { line: { text, kind } }
  }
}

/** Appends lines, keeping the last MAX_LINES; says how many fell off the front. */
export function capLines(lines: readonly RunLine[], more: readonly RunLine[], dropped: number, max = MAX_LINES) {
  const all = [...lines, ...more]
  const cut = Math.max(0, all.length - max)
  return { lines: cut > 0 ? all.slice(cut) : all, dropped: dropped + cut }
}

/** Adds an issue unless the same message at the same place is already listed. */
export function addIssue(issues: readonly RunIssue[], issue: RunIssue): RunIssue[] {
  if (issues.some(i => i.kind === issue.kind && i.message === issue.message && i.place === issue.place)) return [...issues]
  return [...issues, { ...issue }].slice(-MAX_ISSUES)
}

export function isLive(status: RunStatus): boolean {
  return status === 'starting' || status === 'running' || status === 'stopping'
}

/** How a finished run is called, from its exit code and whether we stopped it. */
export function endStatus(code: number | null, wasStopped: boolean, sawCrash: boolean): RunStatus {
  if (wasStopped) return 'stopped'
  if (sawCrash) return 'crashed'
  if (code === 0) return 'exited'
  return 'crashed'
}

export function statusLabel(run: RunState): string {
  switch (run.status) {
    case 'idle':
      return 'Not started'
    case 'starting':
      return 'Starting…'
    case 'running':
      return 'Running'
    case 'stopping':
      return 'Stopping…'
    case 'stopped':
      return 'Stopped'
    case 'exited':
      return `Exited, code ${run.code ?? 0}`
    case 'crashed':
      return run.code === null ? 'Crashed' : `Crashed, code ${run.code}`
    case 'failed':
      return `Could not start: ${run.detail}`
  }
}

/** `/play res://scenes/x.tscn --headless` -> its scene and mode. Relative scenes get res://. */
export function parseRunArgs(args: string): { scene: string; isHeadless: boolean | undefined } {
  let isHeadless: boolean | undefined
  const rest: string[] = []
  for (const word of args.trim().split(/\s+/).filter(Boolean)) {
    if (word === '--headless') isHeadless = true
    else if (word === '--windowed') isHeadless = false
    else rest.push(word)
  }
  const raw = rest.join(' ').replace(/\\/g, '/')
  const scene = raw === '' ? '' : raw.startsWith('res://') ? raw : `res://${raw.replace(/^\.?\//, '')}`
  return { scene, isHeadless }
}

/** What Claude's godot_run_output tool returns: state, issues, then the last lines. */
export function outputText(run: RunState, lineCount: number, errorsOnly: boolean): string {
  if (run.id === 0) return 'No game run yet in this session. The person starts one with /play (or call godot_run).'
  const what = run.scene === '' ? 'main scene' : run.scene
  const head = `Godot run #${run.id} (${what}${run.isHeadless ? ', headless' : ''}) in ${run.project}: ${statusLabel(run)}.`
  const errors = run.issues.filter(i => i.kind === 'error')
  const warnings = run.issues.filter(i => i.kind === 'warning')
  const issueLines = run.issues.map(i => `${i.kind === 'error' ? 'ERROR' : 'WARNING'}: ${i.message}${i.place === '' ? '' : ` (${i.place})`}`)
  const parts = [head, `${errors.length} error${errors.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}.`]
  if (issueLines.length > 0) parts.push('', 'Issues:', ...issueLines)
  if (!errorsOnly) {
    const n = Math.max(1, Math.min(400, lineCount))
    const tail = run.lines.slice(-n)
    const skipped = run.dropped + run.lines.length - tail.length
    parts.push('', `Last ${tail.length} line${tail.length === 1 ? '' : 's'}${skipped > 0 ? ` (${skipped} earlier not shown)` : ''}:`, ...tail.map(l => l.text))
  }
  return parts.join('\n')
}
