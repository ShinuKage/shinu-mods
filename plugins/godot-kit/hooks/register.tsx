// godot-kit: one module per feature, all reading the shared KitConfig.
//   1. script check  (./script-check)  after .gd edits
//   2. /play panel   (./run)           launches the game, streams output
//   3. scene tree    (./scene)         /scene pane, marks what Claude's .tscn edits changed
// The engine takes one unmatched hook per event per mod, so session.start,
// session.end and tool.call live here and call into each feature.
import type { Register } from 'claude-code'

import { isRunTool, onRunSessionStart, onRunToolCall, registerRun, stopRun } from './run/feature'
import type { OutputInput, RunInput } from './run/feature'
import { onSceneSessionStart, onSceneToolCall, registerScene } from './scene/feature'
import type { SceneToolInput } from './scene/feature'
import { onSessionStart as onScriptCheckStart, onToolCall as onScriptCheckToolCall, registerScriptCheck } from './script-check/feature'
import type { ToolInput, ToolNext } from './script-check/feature'
import { readConfig } from './shared/config'

export const register: Register = (on, options) => {
  const cfg = readConfig(options)
  registerScriptCheck(on, cfg)
  registerRun(on, cfg)
  registerScene(on, cfg)

  on('session.start', async ($, e, next) => {
    await onScriptCheckStart($)
    await onRunSessionStart($)
    await onSceneSessionStart($)
    return next(e)
  })
  on('session.end', async ($, e, next) => {
    await stopRun($).catch(() => undefined)
    return next(e)
  })
  // The mod's own tools are answered here. Every other call goes through the
  // scene viewer, then the script check, then the tool itself; neither blocks
  // or breaks it (the .catch passes it on).
  on('tool.call', async ($, e, next) => {
    if (isRunTool(String(e.tool))) return (await onRunToolCall($, e as unknown as ToolInput & OutputInput & RunInput)) as never
    return onSceneToolCall($, e as SceneToolInput, x => onScriptCheckToolCall($, x as ToolInput, next as unknown as ToolNext))
  }).catch(($, e, next) =>
    next.called || !isRunTool(String(e.tool)) ? next(e) : ({ result: 'godot-kit: the run tool failed; ask the person to check the Godot run pane.' } as never),
  )
}
