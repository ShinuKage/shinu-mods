/** One error Godot reported for a script. */
export type GdError = {
  /** Absolute path, forward slashes. */
  file: string
  /** The same file as Godot names it: res://... */
  res: string
  line: number
  message: string
}

/** Why the last check could not give an answer; null when it did. */
export type CheckNote = 'missing' | 'timeout' | 'failed'

export type CheckState = {
  /** Absolute file (forward slashes, lower-cased on Windows) -> its errors. Only files with errors are kept. */
  files: Record<string, GdError[]>
  note: CheckNote | null
  /** Short words about the note (the path tried, the timeout). */
  noteDetail: string
  isRunning: boolean
  /** When the last check finished, ms since the epoch; 0 before the first. */
  checkedAt: number
  /** How many scripts the last check covered. */
  lastCount: number
}

/** How one output line of a run is drawn. */
export type RunLineKind = 'out' | 'err' | 'warning' | 'error' | 'trace'

export type RunLine = { text: string; kind: RunLineKind }

/** An error or warning the run printed, with where it came from. */
export type RunIssue = {
  kind: 'error' | 'warning'
  message: string
  /** res://file.gd:line from its backtrace or `at:` line; '' when none. */
  place: string
}

export type RunStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'exited' | 'crashed' | 'failed'

export type RunState = {
  /** Which run this is; 0 before the first. */
  id: number
  status: RunStatus
  /** Exit code once it ended; null while running or when unknown. */
  code: number | null
  project: string
  /** res://... scene asked for; '' for the main scene. */
  scene: string
  isHeadless: boolean
  /** Who started it: the person's /run or Claude's tool. */
  by: 'person' | 'claude'
  startedAt: number
  endedAt: number
  /** The last lines (capped), oldest first. */
  lines: RunLine[]
  /** Lines dropped off the front by the cap. */
  dropped: number
  issues: RunIssue[]
  /** Why it could not start; '' otherwise. */
  detail: string
}

/** One node of a .tscn scene. */
export type SceneNode = {
  /** '.' for the root, else the path from the root: 'Player/Sprite'. */
  path: string
  name: string
  /** '' for an instanced scene's root, which takes its type from that scene. */
  type: string
  /** null for the root; '.' for the root's children. */
  parent: string | null
  /** res:// path of the scene this node instances; '' when it is not one. */
  instance: string
  /** res:// path of its script; ''. */
  script: string
  groups: string[]
  /** unique_name_in_owner (shown with % as in Godot). */
  isUnique: boolean
  line: number
}

export type SceneMove = { path: string; from: string }

export type SceneDiff = {
  added: string[]
  removed: { path: string; name: string; type: string; parent: string }[]
  /** Nodes now at `path` that used to sit under `from`. */
  moved: SceneMove[]
  /** Same path, other type, script or instance. */
  changed: string[]
}

export type SceneView = {
  /** Absolute path of the scene shown; '' before any. */
  file: string
  res: string
  project: string
  nodes: SceneNode[]
  /** Changes made by Claude's last edit of this scene; null when it was opened, not edited. */
  diff: SceneDiff | null
  issues: string[]
  /** When the scene was last read, ms since the epoch. */
  readAt: number
  /** Why it could not be read; '' otherwise. */
  error: string
  /** Paths of instance nodes the person expanded. */
  expanded: string[]
  /** Instanced scenes read so far: res:// path -> its nodes. */
  sub: Record<string, SceneNode[]>
}

declare module 'claude-code' {
  interface PluginState {
    'godot-kit': {
      check: Shaped<CheckState>
      run: Shaped<RunState>
      scene: Shaped<SceneView>
    }
  }
}
