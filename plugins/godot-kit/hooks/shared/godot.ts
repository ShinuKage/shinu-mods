// Running Godot headless. Shared by the script check and /play.
import type { EngineInterface } from 'claude-code'

export type GodotRun =
  | { kind: 'ran'; exitCode: number; output: string }
  | { kind: 'missing'; detail: string }
  | { kind: 'timeout'; detail: string }

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g

/**
 * Runs Godot once and never throws: a Godot that cannot start reads as
 * `missing`, one still running at `timeoutMs` as `timeout` (and is killed).
 */
export async function runGodot(
  $: EngineInterface,
  godot: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<GodotRun> {
  const startedAt = await $.clock.now()
  try {
    const ran = await $.process.run([godot, ...args], { timeoutMs })
    const output = `${ran.stdout}\n${ran.stderr}`.replace(ANSI, '')
    return { kind: 'ran', exitCode: ran.exitCode, output }
  } catch (error) {
    const elapsed = (await $.clock.now()) - startedAt
    const words = error instanceof Error ? error.message : String(error)
    if (elapsed >= timeoutMs - 250 || /time(d)? ?out|still running/i.test(words)) {
      return { kind: 'timeout', detail: `Godot ran past ${Math.round(timeoutMs / 1000)}s` }
    }
    return { kind: 'missing', detail: `Godot could not start: ${godot}` }
  }
}
