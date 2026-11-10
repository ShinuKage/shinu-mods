// The script check's pure parts: reading Godot's output, the status line,
// and the short note Claude reads after an edit. No `$` here.
import type { CheckState, GdError } from '../../types'

import { fileKey, fromRes } from '../shared/paths'

export const EMPTY_CHECK: CheckState = {
  files: {},
  note: null,
  noteDetail: '',
  isRunning: false,
  checkedAt: 0,
  lastCount: 0,
}

const ERROR_LINE = /^\s*(SCRIPT ERROR|ERROR):\s*(.*)$/
const AT_RES = /(res:\/\/[^\s:()]+\.gd):(\d+)/

/**
 * Godot 4 prints `SCRIPT ERROR: Parse Error: <message>` then
 * `   at: GDScript::reload (res://file.gd:<line>)`; Godot 3 puts the place on
 * an `At: res://file.gd:<line>.` line. Each distinct file:line:message once.
 */
export function parseGodotOutput(output: string, project: string): GdError[] {
  const lines = output.split(/\r?\n/)
  const seen = new Set<string>()
  const errors: GdError[] = []
  for (let i = 0; i < lines.length; i++) {
    const head = ERROR_LINE.exec(lines[i] ?? '')
    if (head === null) continue
    let message = (head[2] ?? '').trim()
    if (/^Failed to load script/i.test(message)) continue
    let place = AT_RES.exec(message)
    if (place === null) {
      for (let j = i + 1; j <= i + 2 && j < lines.length; j++) {
        const next = lines[j] ?? ''
        if (ERROR_LINE.test(next)) break
        place = AT_RES.exec(next)
        if (place !== null) break
      }
    } else {
      message = message.replace(AT_RES, '').replace(/^[\s:-]+/, '')
    }
    if (place === null) continue
    message = message
      .replace(/^GDScript::reload:\s*/, '')
      .replace(/^(Parse|Compile) Error:\s*/i, '')
      .trim()
    const res = place[1] ?? ''
    const line = Number(place[2])
    const id = `${res}:${line}:${message}`
    if (seen.has(id)) continue
    seen.add(id)
    errors.push({ file: fromRes(res, project), res, line, message })
  }
  return errors
}

/** Errors grouped by file key. */
export function byFile(errors: readonly GdError[]): Map<string, GdError[]> {
  const map = new Map<string, GdError[]>()
  for (const error of errors) {
    const key = fileKey(error.file)
    map.set(key, [...(map.get(key) ?? []), error])
  }
  return map
}

export function errorCount(state: CheckState): number {
  return Object.values(state.files).reduce((sum, list) => sum + list.length, 0)
}

/** The status line, or undefined before any check. */
export function statusText(state: CheckState): string | undefined {
  if (state.note === 'missing') return '⚠ Godot not found · set godotPath'
  if (state.note === 'timeout') return '⚠ Godot check timed out'
  if (state.note === 'failed') return '⚠ Godot check failed'
  if (state.checkedAt === 0) return undefined
  const n = errorCount(state)
  return n === 0 ? '✓ GDScript ok' : `✗ ${n} script error${n === 1 ? '' : 's'}`
}

/** Class names a script declares: `class_name Player`. */
export function declaredClasses(source: string): string[] {
  return [...source.matchAll(/^\s*class_name\s+([A-Za-z_]\w*)/gm)].map(m => m[1] ?? '').filter(Boolean)
}

/**
 * Class-like names Godot could not find: a stale global class cache (a new
 * `class_name` the editor has not scanned) reports exactly these.
 */
export function unknownClasses(errors: readonly GdError[]): string[] {
  const names = new Set<string>()
  const patterns = [
    /Identifier "([A-Z]\w*)" not declared/,
    /Could not find type "([A-Z]\w*)"/,
    /Could not resolve class "([A-Z]\w*)"/,
  ]
  for (const { message } of errors) {
    for (const pattern of patterns) {
      const hit = pattern.exec(message)
      if (hit?.[1]) names.add(hit[1])
    }
  }
  return [...names]
}

const MAX_LINES = 8

/**
 * What Claude reads after its edit: the errors in the files it touched,
 * or a one-liner when a file it had broken passes again. Undefined: nothing to say.
 */
export function contextFor(
  touched: readonly string[],
  found: ReadonlyMap<string, GdError[]>,
  wasBad: ReadonlySet<string>,
): string | undefined {
  const errors = touched.flatMap(file => found.get(fileKey(file)) ?? [])
  if (errors.length > 0) {
    const files = [...new Set(errors.map(e => e.res))]
    const head = `godot-kit: Godot reports ${errors.length} GDScript error${errors.length === 1 ? '' : 's'} in ${files.join(', ')}. Fix before moving on:`
    const lines = errors.slice(0, MAX_LINES).map(e => `${e.res}:${e.line}: ${e.message}`)
    if (errors.length > MAX_LINES) lines.push(`(+${errors.length - MAX_LINES} more)`)
    return [head, ...lines].join('\n')
  }
  const fixed = touched.filter(file => wasBad.has(fileKey(file)))
  if (fixed.length > 0) return `godot-kit: ${fixed.length === 1 ? 'the script now passes' : 'these scripts now pass'} the Godot check.`
  return undefined
}
