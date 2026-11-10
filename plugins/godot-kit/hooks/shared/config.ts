// The settings every godot-kit feature shares: where Godot is, which project.
// Stage 2 (/play) and stage 3 (scene tree) read the same KitConfig and helpers.
import type { EngineInterface, PluginOptions } from 'claude-code'

import { dirname, fileKey, isInside, join, norm } from './paths'

export type KitConfig = {
  /** The person's Godot executable; '' to auto-detect. */
  godotPath: string
  /** The one project to work in; '' for any folder holding project.godot. */
  projectPath: string
  checkTimeoutMs: number
}

export function readConfig(options: PluginOptions): KitConfig {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
  const seconds = typeof options.checkTimeoutSec === 'number' ? options.checkTimeoutSec : 20
  return {
    godotPath: text(options.godotPath),
    projectPath: text(options.projectPath),
    checkTimeoutMs: Math.min(600, Math.max(2, seconds)) * 1000,
  }
}

// ---- Finding Godot ------------------------------------------------------

/** Cached per load: a reload (or a config change) looks again. */
let godotFound: string | undefined

/** Prefer the console build (it prints to the pipe), then the newest version. */
export function rankGodot(names: readonly string[]): string[] {
  return names
    .filter(n => /^godot.*\.exe$/i.test(n))
    .sort((a, b) => {
      const ca = /console/i.test(a) ? 0 : 1
      const cb = /console/i.test(b) ? 0 : 1
      if (ca !== cb) return ca - cb
      return b.localeCompare(a, undefined, { numeric: true })
    })
}

async function godotIn($: EngineInterface, dir: string, depth: number): Promise<string | undefined> {
  const entries = await $.fs.list(dir).catch(() => [])
  const files = entries.filter(x => x.kind === 'file').map(x => x.name)
  const best = rankGodot(files.filter(n => /\.exe$/i.test(n)))[0]
  if (best !== undefined) return join(dir, best)
  if (depth <= 0) return undefined
  for (const sub of entries.filter(x => x.kind === 'dir' && /^godot/i.test(x.name))) {
    const inner = await godotIn($, join(dir, sub.name), depth - 1)
    if (inner !== undefined) return inner
  }
  return undefined
}

/** The places Godot usually lands on Windows, plus a Games folder per drive. */
async function candidateDirs($: EngineInterface): Promise<string[]> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  const programs = await $.env.get('ProgramFiles')
  const programsX86 = await $.env.get('ProgramFiles(x86)')
  const local = await $.env.get('LOCALAPPDATA')
  const dirs: string[] = []
  if (programs) dirs.push(programs)
  if (programsX86) dirs.push(programsX86, join(programsX86, 'Steam/steamapps/common/Godot Engine'))
  if (local) dirs.push(join(local, 'Programs'))
  if (home) {
    dirs.push(
      join(home, 'scoop/apps/godot/current'),
      join(home, 'Downloads'),
      join(home, 'Desktop'),
      join(home, 'Godot'),
    )
  }
  for (const drive of ['C', 'D', 'E']) dirs.push(`${drive}:/Godot`, `${drive}:/Games`, `${drive}:/SteamLibrary/steamapps/common/Godot Engine`)
  return dirs.map(norm)
}

/**
 * The Godot executable to run, or undefined when there is none.
 * The configured path wins; otherwise the usual folders, then `godot` on PATH.
 */
export async function findGodot($: EngineInterface, cfg: KitConfig): Promise<string | undefined> {
  if (cfg.godotPath !== '') {
    return (await $.fs.exists(cfg.godotPath)) ? cfg.godotPath : undefined
  }
  if (godotFound !== undefined && (await $.fs.exists(godotFound))) return godotFound
  for (const dir of await candidateDirs($)) {
    const found = await godotIn($, dir, 1)
    if (found !== undefined) return (godotFound = found)
  }
  for (const name of ['godot', 'godot4']) {
    const ran = await $.process.run([name, '--version'], { timeoutMs: 5000 }).catch(() => undefined)
    if (ran !== undefined && ran.exitCode === 0) return (godotFound = name)
  }
  return undefined
}

/** Forget a Godot path that stopped working, so the next call looks again. */
export function forgetGodot(): void {
  godotFound = undefined
}

// ---- Finding the project ------------------------------------------------

const projectOfDir = new Map<string, string | null>()
/** The project a file was last found in; kept in $.store so it outlives reloads and sessions. */
let lastProject: string | undefined

async function rememberProject($: EngineInterface, dir: string): Promise<void> {
  if (lastProject === dir) return
  lastProject = dir
  await $.store.set('lastProject', dir).catch(() => undefined)
}

async function recalledProject($: EngineInterface): Promise<string | undefined> {
  if (lastProject !== undefined) return lastProject
  const stored = await $.store.get('lastProject').catch(() => undefined)
  if (typeof stored !== 'string' || !(await $.fs.exists(join(stored, 'project.godot')))) return undefined
  return (lastProject = stored)
}

/** The Godot project (folder holding project.godot) a file belongs to, if any. */
export async function findProject($: EngineInterface, cfg: KitConfig, file: string): Promise<string | undefined> {
  if (cfg.projectPath !== '') {
    if (!isInside(file, cfg.projectPath)) return undefined
    return (await $.fs.exists(join(cfg.projectPath, 'project.godot'))) ? norm(cfg.projectPath) : undefined
  }
  const seen: string[] = []
  let dir = dirname(file)
  for (let i = 0; i < 40; i++) {
    const cached = projectOfDir.get(fileKey(dir))
    if (cached !== undefined) {
      for (const d of seen) projectOfDir.set(d, cached)
      if (cached !== null) await rememberProject($, cached)
      return cached ?? undefined
    }
    seen.push(fileKey(dir))
    if (await $.fs.exists(join(dir, 'project.godot'))) {
      for (const d of seen) projectOfDir.set(d, norm(dir))
      await rememberProject($, norm(dir))
      return norm(dir)
    }
    const up = dirname(dir)
    if (up === dir || up === '.') break
    dir = up
  }
  for (const d of seen) projectOfDir.set(d, null)
  return undefined
}

/** A file's project changes only when project.godot is created or removed. */
export function forgetProjects(): void {
  projectOfDir.clear()
}

/**
 * The project to run: the configured one, else the one holding the session's
 * folder, else the project of the last .gd script Claude edited (remembered).
 */
export async function resolveProject($: EngineInterface, cfg: KitConfig): Promise<string | undefined> {
  if (cfg.projectPath !== '') {
    return (await $.fs.exists(join(cfg.projectPath, 'project.godot'))) ? norm(cfg.projectPath) : undefined
  }
  const own = await findProject($, cfg, join(norm(await $.session.root()), '.godot-kit-probe'))
  return own ?? (await recalledProject($))
}

/**
 * The build to run a game with so its output reaches the pipe: on Windows the
 * GUI build writes nothing there, so its _console.exe sibling is preferred.
 */
export async function consoleBuild($: EngineInterface, godot: string): Promise<string> {
  if (/console/i.test(godot) || !/\.exe$/i.test(godot)) return godot
  const sibling = godot.replace(/\.exe$/i, '_console.exe')
  return (await $.fs.exists(sibling)) ? sibling : godot
}
