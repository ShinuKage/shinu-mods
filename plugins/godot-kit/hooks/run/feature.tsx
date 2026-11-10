// Feature 2: the /play run panel (Claude Code ships its own /run). Launches the game with Godot, streams its
// stdout/stderr into a pane beside the chat, picks out errors and warnings,
// and gives Claude two tools: read the output, and start or stop a run.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, On, ProcessSpawnChunk, ProcessSpawnResult, RenderInput, Timer } from 'claude-code'

import type { RunIssue, RunLine, RunState } from '../../types'

import { consoleBuild, findGodot, resolveProject } from '../shared/config'
import type { KitConfig } from '../shared/config'
import { Classifier, EMPTY_RUN, LineSplitter, addIssue, capLines, endStatus, isLive, outputText, parseRunArgs, statusLabel } from './logic'

// Change the tag when RunState's fields change.
const run = atom({ plugin: 'godot-kit', key: 'run' } as const, EMPTY_RUN, { shape: 'run-1' })

export const RUN_PANE = 'godot-run'
export const OUTPUT_TOOL = 'mcp__godot-kit__godot_run_output'
export const RUN_TOOL = 'mcp__godot-kit__godot_run'
/** How often streamed lines are written to the pane's state. */
export const FLUSH_MS = 250
/** How long Stop waits for the child to end before killing it by its marker. */
export const STOP_GRACE_MS = 1500

const ORANGE = '#F97316'
const GREEN = '#22C55E'
const RED = '#EF4444'
const AMBER = '#FB923C'

let config: KitConfig = { godotPath: '', projectPath: '', checkTimeoutMs: 20_000 }

/** The run in flight in this load. A reload unloads the module, which kills its child. */
type Live = {
  id: number
  marker: string
  stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  isStopping: boolean
  sawCrash: boolean
  pending: RunLine[]
  issues: RunIssue[]
  flush: Timer | undefined
  ended: Promise<void>
}
let live: Live | undefined

/** The words a run's processes carry, so Stop can find them even if the stream cannot end them. */
export function markerOf(id: number, startedAt: number): string {
  return `--godot-kit-run=${id}-${startedAt}`
}

function after($: EngineInterface, ms: number): Promise<'timeout'> {
  return new Promise(resolve => {
    $.clock.after(ms, () => resolve('timeout'))
  })
}

/** Kills every process whose command line holds `marker` (the console wrapper and the game). */
async function killByMarker($: EngineInterface, marker: string): Promise<void> {
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
  await $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 10_000 }).catch(() => undefined)
}

async function flush($: EngineInterface, one: Live): Promise<void> {
  one.flush?.cancel()
  one.flush = undefined
  const more = one.pending
  one.pending = []
  const issues = one.issues.reduce<RunIssue[]>(addIssue, [])
  await update($, run, state => {
    if (state.id !== one.id) return state
    const capped = capLines(state.lines, more, state.dropped)
    return { ...state, ...capped, issues, status: state.status === 'starting' ? 'running' : state.status }
  })
}

function scheduleFlush($: EngineInterface, one: Live): void {
  if (one.flush !== undefined) return
  one.flush = $.clock.after(FLUSH_MS, () => void flush($, one))
}

/** Reads the child's stream to its end: the loop is the child's life. */
async function pump($: EngineInterface, one: Live, done: () => void): Promise<void> {
  const splitters = { stdout: new LineSplitter(), stderr: new LineSplitter() }
  const readers = { stdout: new Classifier(), stderr: new Classifier() }
  const take = (text: string, stream: 'stdout' | 'stderr') => {
    const { line, issue } = readers[stream].read(text, stream)
    if (issue !== undefined) one.issues.push(issue)
    if (line.kind === 'error' && !issue) one.sawCrash = true
    one.pending.push(line)
  }
  let code: number | null = null
  let detail = ''
  let isStarted = false
  try {
    for (;;) {
      const step = await one.stream.next()
      if (!isStarted) {
        isStarted = true
        await update($, run, (state): RunState => (state.id === one.id && state.status === 'starting' ? { ...state, status: 'running' } : state))
      }
      if (step.done === true) {
        code = step.value.code
        break
      }
      for (const text of splitters[step.value.stream].push(step.value.text)) take(text, step.value.stream)
      scheduleFlush($, one)
    }
  } catch (error) {
    if (!isStarted) detail = error instanceof Error ? error.message : String(error)
  }
  for (const stream of ['stdout', 'stderr'] as const) for (const text of splitters[stream].flush()) take(text, stream)
  await flush($, one)
  const now = await $.clock.now()
  const status = detail !== '' ? 'failed' : endStatus(code, one.isStopping, one.sawCrash)
  await update($, run, state => (state.id !== one.id ? state : { ...state, status, code, endedAt: now, detail }))
  if (live === one) live = undefined
  done()
  if (status === 'crashed') void $.ui.open({ id: RUN_PANE, title: 'Godot run' })
}

/** Stops the run in flight, if any: ends its stream, then kills it by marker if it lingers. */
export async function stopRun($: EngineInterface): Promise<void> {
  const one = live
  if (one === undefined) return
  one.isStopping = true
  await update($, run, (state): RunState => (state.id === one.id ? { ...state, status: 'stopping' } : state))
  void one.stream.return(undefined as never).catch(() => undefined)
  if ((await Promise.race([one.ended.then(() => 'ended' as const), after($, STOP_GRACE_MS)])) === 'ended') return
  await killByMarker($, one.marker)
  await Promise.race([one.ended, after($, 3000)])
}

export type StartAsk = { scene: string; isHeadless: boolean; by: 'person' | 'claude' }

/** Starts a run (stopping the one in flight first). Resolves once it is started or has failed. */
export async function startRun($: EngineInterface, ask: StartAsk): Promise<RunState> {
  await stopRun($)
  const previous = await read($, run)
  const id = previous.id + 1
  const now = await $.clock.now()
  const base: RunState = { ...EMPTY_RUN, id, scene: ask.scene, isHeadless: ask.isHeadless, by: ask.by, startedAt: now, status: 'starting' }

  const project = await resolveProject($, config)
  if (project === undefined) {
    const failed = { ...base, status: 'failed' as const, endedAt: now, detail: 'no Godot project found (set projectPath, or open the session in the project folder)' }
    await update($, run, () => failed)
    return failed
  }
  const godot = await findGodot($, config)
  if (godot === undefined) {
    const failed = { ...base, project, status: 'failed' as const, endedAt: now, detail: 'Godot not found (set godotPath)' }
    await update($, run, () => failed)
    return failed
  }

  const marker = markerOf(id, now)
  const argv = [await consoleBuild($, godot), '--path', project, ...(ask.isHeadless ? ['--headless'] : []), ...(ask.scene === '' ? [] : [ask.scene]), '--', marker]
  const started = { ...base, project }
  await update($, run, () => started)

  let done = () => {}
  const ended = new Promise<void>(resolve => (done = resolve))
  const one: Live = {
    id,
    marker,
    stream: $.process.spawn({ argv, cwd: project }),
    isStopping: false,
    sawCrash: false,
    pending: [],
    issues: [],
    flush: undefined,
    ended,
  }
  live = one
  void pump($, one, done)
  return started
}

/** On load: a run the previous load left marked live was killed with that load; say so and make sure. */
export async function settleOrphan($: EngineInterface): Promise<void> {
  const state = await read($, run)
  if (!isLive(state.status) || live !== undefined) return
  await killByMarker($, markerOf(state.id, state.startedAt))
  const now = await $.clock.now()
  await update($, run, (s): RunState => (s.id === state.id ? { ...s, status: 'stopped', endedAt: now, detail: 'stopped by a reload' } : s))
}

// ---- Command, tools, pane ---------------------------------------------------

export async function onRunCommand($: EngineInterface, args: string): Promise<{ text: string }> {
  const { scene, isHeadless } = parseRunArgs(args)
  void $.ui.open({ id: RUN_PANE, title: 'Godot run' })
  const wasLive = live !== undefined
  const state = await startRun($, { scene, isHeadless: isHeadless ?? false, by: 'person' })
  if (state.status === 'failed') return { text: `godot-kit: could not start the game: ${state.detail}.` }
  const what = scene === '' ? 'the main scene' : scene
  return { text: `godot-kit: ${wasLive ? 'restarted' : 'started'} ${what}${isHeadless ? ' (headless)' : ''}. Output streams in the Godot run pane.` }
}

export type OutputInput = { lines?: unknown; errorsOnly?: unknown }
export type RunInput = { action?: unknown; scene?: unknown; headless?: unknown; waitSec?: unknown }

export async function onOutputTool($: EngineInterface, e: OutputInput): Promise<{ result: string }> {
  const lines = typeof e.lines === 'number' ? e.lines : 80
  return { result: outputText(await read($, run), lines, e.errorsOnly === true) }
}

export async function onRunTool($: EngineInterface, e: RunInput): Promise<{ result: string }> {
  if (e.action === 'stop') {
    const wasLive = live !== undefined
    await stopRun($)
    return { result: wasLive ? 'Stopped the game.' : 'No game was running.' }
  }
  const scene = typeof e.scene === 'string' ? parseRunArgs(e.scene).scene : ''
  void $.ui.open({ id: RUN_PANE, title: 'Godot run' })
  const started = await startRun($, { scene, isHeadless: e.headless === true, by: 'claude' })
  if (started.status === 'failed') return { result: `Could not start the game: ${started.detail}.` }
  const wait = Math.max(1, Math.min(8, typeof e.waitSec === 'number' ? e.waitSec : 4)) * 1000
  const one = live
  await Promise.race([one?.ended ?? Promise.resolve(), after($, wait)])
  if (one !== undefined && live === one) await flush($, one)
  return { result: outputText(await read($, run), 60, false) }
}

export async function registerRunTools($: EngineInterface): Promise<void> {
  await $.command.register({ name: 'play', description: 'Run the Godot game beside the chat (optionally a scene: /play res://scenes/x.tscn; add --headless)', argumentHint: '[res://scene.tscn] [--headless]' })
  await $.tool.register({
    name: 'godot_run_output',
    description:
      'Read the output of the Godot game run the person started with /play (or godot_run): its state (running, exited, crashed), the errors and warnings it printed with their res://file:line, and the last lines of stdout/stderr. Use it when the person mentions a crash, an error or what the game printed.',
    inputSchema: {
      type: 'object',
      properties: {
        lines: { type: 'number', description: 'How many of the last output lines to include (default 80, max 400).' },
        errorsOnly: { type: 'boolean', description: 'Only the state and the errors/warnings, no output lines.' },
      },
    },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'godot_run',
    description:
      'Start the Godot game (restarting a run in flight) or stop it. The run shows in the person\'s Godot run pane. Returns the first output after waitSec seconds; read more later with godot_run_output.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop'], description: 'start (default) or stop.' },
        scene: { type: 'string', description: 'A scene to run instead of the main scene, e.g. res://scenes/level.tscn.' },
        headless: { type: 'boolean', description: 'Run without a window (default false).' },
        waitSec: { type: 'number', description: 'Seconds to wait before returning the first output (1-8, default 4).' },
      },
    },
    isDeferred: false,
  })
}

function since(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

const LINE_COLOR: Record<RunLine['kind'], string | undefined> = {
  out: undefined,
  err: undefined,
  warning: AMBER,
  error: RED,
  trace: undefined,
}

export async function renderRunPane($: EngineInterface, e: RenderInput) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const state = await read($, run)
  const now = await $.clock.now()
  const isRunning = isLive(state.status)
  const errors = state.issues.filter(i => i.kind === 'error').length
  const warnings = state.issues.length - errors
  const stateColor = isRunning ? GREEN : state.status === 'crashed' || state.status === 'failed' ? RED : undefined
  const bodyRows = e.props && 'scroll' in e.props ? (e.props.scroll as { bodyRows: number }).bodyRows : 24
  const room = Math.max(5, bodyRows - 6)
  const tail = state.lines.slice(-room)
  const what = state.scene === '' ? 'main scene' : state.scene
  const timing = state.startedAt === 0 ? '' : isRunning ? ` · ${since(state.startedAt, now)}` : state.endedAt > 0 ? ` · ran ${since(state.startedAt, state.endedAt)}` : ''

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text>
          <Text color={ORANGE} weight="bold">Godot run</Text>
          <Text dimColor>{state.id === 0 ? '' : `  #${state.id} · ${what}${state.isHeadless ? ' · headless' : ''}${state.by === 'claude' ? ' · by Claude' : ''}`}</Text>
        </Text>
        <Box flexDirection="row" gap={1}>
          {isRunning && <Button key="stop" label="Stop" onPress={() => void stopRun($)} />}
          <Button
            key="restart"
            variant="primary"
            label={state.id === 0 ? 'Run' : isRunning ? 'Restart' : 'Run again'}
            onPress={() => void startRun($, { scene: state.scene, isHeadless: state.isHeadless, by: 'person' })}
          />
        </Box>
      </Box>
      <Text>
        <Text color={stateColor} weight="semibold">{isRunning ? '● ' : ''}{statusLabel(state)}</Text>
        <Text dimColor>{timing}</Text>
        {errors > 0 && <Text color={RED}>{`  ✗ ${errors} error${errors === 1 ? '' : 's'}`}</Text>}
        {warnings > 0 && <Text color={AMBER}>{`  ⚠ ${warnings} warning${warnings === 1 ? '' : 's'}`}</Text>}
      </Text>
      <Box flexDirection="column">
        {state.id === 0 && <Text dimColor>Type /play to start the game. Claude can read its output.</Text>}
        {state.dropped + state.lines.length > tail.length && (
          <Text dimColor>{`… ${state.dropped + state.lines.length - tail.length} earlier lines`}</Text>
        )}
        {tail.map(line => (
          <Text mono color={LINE_COLOR[line.kind]} dimColor={line.kind === 'trace'}>{line.text === '' ? ' ' : line.text}</Text>
        ))}
      </Box>
    </Box>
  )
}

// ---- Wiring -----------------------------------------------------------------

/** Whether a tool call is one of this feature's own tools (served from register.tsx). */
export function isRunTool(tool: string): boolean {
  return tool === OUTPUT_TOOL || tool === RUN_TOOL
}

/** Answers this feature's own tools. */
export async function onRunToolCall($: EngineInterface, e: { tool: unknown } & OutputInput & RunInput): Promise<{ result: string }> {
  return String(e.tool) === OUTPUT_TOOL ? onOutputTool($, e) : onRunTool($, e)
}

/** Called from the mod's one session.start hook. */
export async function onRunSessionStart($: EngineInterface): Promise<void> {
  await registerRunTools($)
  await settleOrphan($)
}

export function registerRun(on: On, cfg: KitConfig): void {
  config = cfg
  on('command.run', { command: 'play' }, async ($, e) => onRunCommand($, e.args))
  on('ui.render', { component: 'Pane', requestId: RUN_PANE }, async ($, e) => renderRunPane($, e))
}
