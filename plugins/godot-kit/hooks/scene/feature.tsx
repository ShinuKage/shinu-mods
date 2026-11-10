// Feature 3: the scene tree viewer. Reads .tscn text scenes into a node tree
// and draws it in a pane; after Claude edits a scene it marks what changed
// (added, moved, removed) and tells Claude about broken references.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderInput, ToolCallResult } from 'claude-code'

import type { SceneNode, SceneView } from '../../types'

import { findProject, resolveProject } from '../shared/config'
import type { KitConfig } from '../shared/config'
import { fileKey, fromRes, isAbsolute, join, norm, toRes } from '../shared/paths'
import { childrenOf, diffIsEmpty, diffScenes, diffSummary, label, parseScene, sceneContext, tscnPathsIn } from './logic'

export const EMPTY_SCENE: SceneView = {
  file: '',
  res: '',
  project: '',
  nodes: [],
  diff: null,
  issues: [],
  readAt: 0,
  error: '',
  expanded: [],
  sub: {},
}

// Change the tag when SceneView's fields change.
const scene = atom({ plugin: 'godot-kit', key: 'scene' } as const, EMPTY_SCENE, { shape: 'scene-1' })

export const SCENE_PANE = 'godot-scene'
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
/** How many instanced scenes deep the pane follows ▸. */
const MAX_INSTANCE_DEPTH = 6

const ORANGE = '#F97316'
const AMBER = '#FB923C'
const RED = '#EF4444'
const BLUE = '#60A5FA'

let config: KitConfig = { godotPath: '', projectPath: '', checkTimeoutMs: 20_000 }

function isScene(path: string): boolean {
  return /\.tscn$/i.test(path)
}

/** ext_resource files that are not on disk. */
async function missingFiles($: EngineInterface, project: string, ext: readonly { id: string; path: string }[]): Promise<string[]> {
  const issues: string[] = []
  for (const res of ext.slice(0, 60)) {
    if (!res.path.startsWith('res://')) continue
    if (!(await $.fs.exists(fromRes(res.path, project)))) issues.push(`missing file ${res.path} (ext_resource "${res.id}")`)
  }
  return issues
}

/**
 * Reads `file` into the pane's state. `before` is the scene's text before
 * Claude's edit (null: the file is new); undefined means a plain open, which
 * keeps the last edit's marks while the scene is unchanged.
 */
export async function showScene($: EngineInterface, file: string, project: string, before?: string | null): Promise<SceneView> {
  const now = await $.clock.now()
  const res = toRes(file, project)
  const previous = await read($, scene)
  const isSame = fileKey(previous.file) === fileKey(file)
  let text: string
  try {
    text = await $.fs.read(file)
  } catch {
    const failed: SceneView = { ...EMPTY_SCENE, file: norm(file), res, project, readAt: now, error: `cannot read ${res}` }
    await update($, scene, () => failed)
    return failed
  }
  const parsed = parseScene(text)
  const issues = [...parsed.issues, ...(await missingFiles($, project, parsed.ext))]
  let diff = null
  if (before !== undefined) {
    diff = diffScenes(before === null ? [] : parseScene(before).nodes, parsed.nodes)
  } else if (isSame && JSON.stringify(previous.nodes) === JSON.stringify(parsed.nodes)) {
    diff = previous.diff
  }
  const view: SceneView = {
    file: norm(file),
    res,
    project,
    nodes: parsed.nodes,
    diff,
    issues,
    readAt: now,
    error: '',
    expanded: isSame ? previous.expanded : [],
    sub: {},
  }
  await update($, scene, () => view)
  return view
}

async function readSnapshots($: EngineInterface, files: readonly string[]): Promise<Map<string, { text: string | null; mtime: number }>> {
  const out = new Map<string, { text: string | null; mtime: number }>()
  for (const file of files) {
    const stat = await $.fs.stat(file).catch(() => undefined)
    const text = stat === undefined ? null : await $.fs.read(file).catch(() => null)
    out.set(file, { text, mtime: stat?.mtimeMs ?? -1 })
  }
  return out
}

function withContext(ran: ToolCallResult, notes: readonly string[]): ToolCallResult {
  if (notes.length === 0) return ran
  const withNote = ran as ToolCallResult & { context?: readonly string[] }
  return { ...withNote, context: [...(withNote.context ?? []), ...notes] } as ToolCallResult
}

export type SceneToolInput = { tool: unknown; file_path?: unknown; command?: unknown }
export type SceneNext = (e: SceneToolInput) => Promise<ToolCallResult>

/** After Claude writes a .tscn: refresh the pane with what changed, and pass on problems. */
export async function onSceneToolCall($: EngineInterface, e: SceneToolInput, next: SceneNext): Promise<ToolCallResult> {
  const tool = String(e.tool)
  let files: string[] = []
  if (EDIT_TOOLS.has(tool) && typeof e.file_path === 'string' && isScene(e.file_path)) files = [norm(e.file_path)]
  if (SHELL_TOOLS.has(tool) && typeof e.command === 'string') {
    const named = tscnPathsIn(e.command)
    if (named.length > 0) {
      const root = norm(await $.session.root())
      files = named.map(p => (isAbsolute(p) ? norm(p) : join(root, p)))
    }
  }
  if (files.length === 0) return next(e)

  const before = await readSnapshots($, files)
  const ran = await next(e)
  if (ran.deny !== undefined || (EDIT_TOOLS.has(tool) && ran.isError === true)) return ran

  const notes: string[] = []
  let shown = false
  for (const file of files) {
    const old = before.get(file)
    if (SHELL_TOOLS.has(tool)) {
      const stat = await $.fs.stat(file).catch(() => undefined)
      if ((stat?.mtimeMs ?? -1) === old?.mtime) continue
      if (stat === undefined) continue
    }
    const project = await findProject($, config, file)
    if (project === undefined) continue
    const view = await showScene($, file, project, old?.text ?? null)
    shown = true
    const note = sceneContext(view.res, view.issues)
    if (note !== undefined) notes.push(note)
  }
  if (shown) void $.ui.open({ id: SCENE_PANE, title: 'Scene' })
  return withContext(ran, notes)
}

/** The project's main scene, from project.godot's run/main_scene (a res:// path). */
async function mainScene($: EngineInterface, project: string): Promise<string | undefined> {
  const text = await $.fs.read(join(project, 'project.godot')).catch(() => '')
  const m = /^run\/main_scene\s*=\s*"(res:\/\/[^"]+)"/m.exec(text)
  return m?.[1]
}

export async function onSceneCommand($: EngineInterface, args: string): Promise<{ text: string }> {
  const asked = args.trim().replace(/\\/g, '/')
  const state = await read($, scene)
  const project = (await resolveProject($, config)) ?? (state.project === '' ? undefined : state.project)
  let file = ''
  if (asked !== '') {
    if (isAbsolute(asked)) file = norm(asked)
    else if (project !== undefined) file = fromRes(asked.startsWith('res://') ? asked : `res://${asked.replace(/^\.?\//, '')}`, project)
  } else if (state.file !== '') {
    file = state.file
  } else if (project !== undefined) {
    const main = await mainScene($, project)
    if (main !== undefined) file = fromRes(main, project)
  }
  if (file === '') return { text: 'godot-kit: no scene to show. Give one: /scene res://scenes/level.tscn' }
  const owner = (await findProject($, config, file)) ?? project
  if (owner === undefined) return { text: `godot-kit: ${file} is not inside a Godot project.` }
  const view = await showScene($, file, owner)
  await $.ui.open({ id: SCENE_PANE, title: 'Scene' })
  if (view.error !== '') return { text: `godot-kit: ${view.error}.` }
  return { text: `godot-kit: showing ${view.res} (${view.nodes.length} node${view.nodes.length === 1 ? '' : 's'}).` }
}

/** ▸ / ▾ on an instanced scene: read it the first time, then toggle. */
export async function toggleInstance($: EngineInterface, key: string, res: string): Promise<void> {
  const state = await read($, scene)
  let sub = state.sub
  if (!state.expanded.includes(key) && sub[res] === undefined && state.project !== '') {
    const text = await $.fs.read(fromRes(res, state.project)).catch(() => '')
    sub = { ...sub, [res]: parseScene(text).nodes }
  }
  await update($, scene, s => ({
    ...s,
    sub: { ...s.sub, ...sub },
    expanded: s.expanded.includes(key) ? s.expanded.filter(k => k !== key) : [...s.expanded, key],
  }))
}

export async function refreshScene($: EngineInterface): Promise<void> {
  const state = await read($, scene)
  if (state.file !== '' && state.project !== '') await showScene($, state.file, state.project)
}

// ---- Drawing ------------------------------------------------------------------

type Row = {
  key: string
  prefix: string
  node: SceneNode
  /** Drawn from an instanced scene's own file (dimmed). */
  isForeign: boolean
  /** The ▸ key when the node instances a scene. */
  expandKey: string
}

function basename(res: string): string {
  return res.slice(res.lastIndexOf('/') + 1)
}

/** Flattens the tree into rows with tree lines, following expanded instances. */
export function treeRows(view: SceneView): Row[] {
  const rows: Row[] = []
  type Child = { node: SceneNode; kids: Map<string, SceneNode[]>; scope: string; isForeign: boolean; depth: number }
  const add = (c: Child, prefix: string, childPrefix: string) => {
    const key = c.scope === '' ? c.node.path : `${c.scope}>${c.node.path}`
    const expandKey = c.node.instance !== '' ? key : ''
    rows.push({ key, prefix, node: c.node, isForeign: c.isForeign, expandKey })
    const children: Child[] = []
    if (expandKey !== '' && view.expanded.includes(key) && c.depth < MAX_INSTANCE_DEPTH) {
      const inner = view.sub[c.node.instance] ?? []
      const innerKids = childrenOf(inner)
      for (const node of innerKids.get('.') ?? []) children.push({ node, kids: innerKids, scope: key, isForeign: true, depth: c.depth + 1 })
    }
    for (const node of c.kids.get(c.node.path) ?? []) children.push({ ...c, node })
    children.forEach((child, i) => {
      const isLast = i === children.length - 1
      add(child, childPrefix + (isLast ? '└─ ' : '├─ '), childPrefix + (isLast ? '   ' : '│  '))
    })
  }
  const kids = childrenOf(view.nodes)
  for (const node of view.nodes.filter(n => n.parent === null)) add({ node, kids, scope: '', isForeign: false, depth: 0 }, '', '')
  return rows
}

export async function renderScenePane($: EngineInterface, e: RenderInput) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const view = await read($, scene)
  const diff = view.diff
  const added = new Set(diff?.added ?? [])
  const moved = new Map((diff?.moved ?? []).map(m => [m.path, m.from]))
  const changed = new Set(diff?.changed ?? [])
  const rows = treeRows(view)

  if (view.file === '') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color={ORANGE} weight="bold">Scene</Text>
        <Text dimColor>No scene yet. It opens when Claude edits a .tscn, or type /scene res://path.tscn.</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text>
          <Text color={ORANGE} weight="bold">Scene</Text>
          <Text dimColor>{`  ${view.res}`}</Text>
        </Text>
        <Button key="refresh" label="Refresh" onPress={() => void refreshScene($)} />
      </Box>
      {view.error !== '' && <Text color={RED}>{view.error}</Text>}
      {diff !== null && (
        <Text>
          <Text dimColor>Claude's last edit: </Text>
          <Text weight="semibold">{diffIsEmpty(diff) ? 'no node changes' : diffSummary(diff)}</Text>
        </Text>
      )}
      {diff !== null && !diffIsEmpty(diff) && (
        <Text dimColor>
          <Text color={ORANGE}>● added</Text>
          {'  '}
          <Text color={BLUE}>↪ moved</Text>
          {'  '}
          <Text color={RED}>✕ removed</Text>
        </Text>
      )}
      <Box flexDirection="column">
        {rows.map(row => {
          const node = row.node
          const isAdded = !row.isForeign && added.has(node.path)
          const from = row.isForeign ? undefined : moved.get(node.path)
          const isChanged = !row.isForeign && changed.has(node.path)
          const isOpen = row.expandKey !== '' && view.expanded.includes(row.expandKey)
          return (
            <Box key={`row:${row.key}`} flexDirection="row">
              <Text dimColor mono>{row.prefix}</Text>
              {row.expandKey !== '' && (
                <Button key={`exp:${row.key}`} plain label={isOpen ? '▾' : '▸'} onPress={() => void toggleInstance($, row.expandKey, node.instance)} />
              )}
              <Text>
                <Text color={isAdded ? ORANGE : from !== undefined ? BLUE : undefined} weight={isAdded || row.node.parent === null ? 'semibold' : undefined} dimColor={row.isForeign}>
                  {`${row.expandKey !== '' ? ' ' : ''}${label(node)}`}
                </Text>
                {node.type !== '' && <Text dimColor>{`  ${node.type}`}</Text>}
                {node.instance !== '' && <Text color={AMBER}>{`  ⧉ ${basename(node.instance)}`}</Text>}
                {node.script !== '' && <Text color={BLUE}>{`  ◆ ${basename(node.script)}`}</Text>}
                {node.groups.length > 0 && <Text dimColor>{`  ${node.groups.map(g => `#${g}`).join(' ')}`}</Text>}
                {isAdded && <Text color={ORANGE}>{'  ● new'}</Text>}
                {from !== undefined && <Text color={BLUE}>{`  ↪ from ${from === '.' ? 'root' : from}`}</Text>}
                {isChanged && <Text color={AMBER}>{'  ~ changed'}</Text>}
              </Text>
            </Box>
          )
        })}
      </Box>
      {diff !== null && diff.removed.length > 0 && (
        <Box flexDirection="column">
          <Text color={RED} weight="semibold">Removed</Text>
          {diff.removed.map(r => (
            <Text>
              <Text color={RED}>{'✕ '}</Text>
              <Text strikethrough>{r.name}</Text>
              <Text dimColor>{`  ${r.type === '' ? 'instance' : r.type} · was under ${r.parent === '.' ? 'root' : r.parent || 'nothing'}`}</Text>
            </Text>
          ))}
        </Box>
      )}
      {view.issues.length > 0 && (
        <Box flexDirection="column">
          <Text color={AMBER} weight="semibold">{`⚠ ${view.issues.length} problem${view.issues.length === 1 ? '' : 's'}`}</Text>
          {view.issues.map(issue => (
            <Text color={AMBER}>{`  ${issue}`}</Text>
          ))}
        </Box>
      )}
    </Box>
  )
}

// ---- Wiring ---------------------------------------------------------------------

export async function onSceneSessionStart($: EngineInterface): Promise<void> {
  await $.command.register({ name: 'scene', description: 'Show a Godot scene tree (default: the scene Claude last edited)', argumentHint: '[res://path.tscn]' })
}

export function registerScene(on: On, cfg: KitConfig): void {
  config = cfg
  on('command.run', { command: 'scene' }, async ($, e) => onSceneCommand($, e.args))
  on('ui.render', { component: 'Pane', requestId: SCENE_PANE }, async ($, e) => renderScenePane($, e))
}
