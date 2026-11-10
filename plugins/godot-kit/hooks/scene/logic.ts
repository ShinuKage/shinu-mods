// The scene viewer's pure parts: reading a .tscn text scene into a node tree,
// what changed between two versions, and the cheap sanity checks. No `$`.
import type { SceneDiff, SceneMove, SceneNode } from '../../types'

export type ExtResource = { id: string; type: string; path: string }

export type ParsedScene = {
  nodes: SceneNode[]
  ext: ExtResource[]
  /** Problems found while reading (malformed headers, broken references). */
  issues: string[]
}

const SECTION = /^\[(gd_scene|gd_resource|ext_resource|sub_resource|node|connection|editable|resource)\b/
const HEADER = /^\[(\w+)\s*(.*?)\]\s*$/

/** Reads `key=value` pairs of a header: strings, ExtResource(...), arrays, bare words. */
export function headerFields(text: string): Record<string, string> {
  const fields: Record<string, string> = {}
  const pattern = /(\w+)\s*=\s*("(?:[^"\\]|\\.)*"|\w+\s*\([^)]*\)|\[[^\]]*\]|[^\s\]]+)/g
  for (const m of text.matchAll(pattern)) {
    const key = m[1] ?? ''
    const raw = m[2] ?? ''
    fields[key] = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\"/g, '"') : raw
  }
  return fields
}

/** `ExtResource("1_abc")`, `ExtResource( 1 )` -> the id; '' when it is not one. */
export function extRef(value: string | undefined): string {
  const m = /ExtResource\s*\(\s*"?([^")\s]+)"?\s*\)/.exec(value ?? '')
  return m?.[1] ?? ''
}

function groupsOf(value: string | undefined): string[] {
  if (value === undefined) return []
  return [...value.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1] ?? '').filter(Boolean)
}

function childPath(parent: string, name: string): string {
  return parent === '.' ? name : `${parent}/${name}`
}

/**
 * Parses a Godot 4 (or 3) text scene. Never throws: what it cannot read
 * becomes an issue, and a file with no readable node gives an empty tree.
 */
export function parseScene(text: string): ParsedScene {
  const nodes: SceneNode[] = []
  const ext: ExtResource[] = []
  const issues: string[] = []
  const byPath = new Map<string, SceneNode>()
  let current: SceneNode | undefined
  const lines = text.split(/\r?\n/)
  let sawHeader = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    // A section header; other lines that start with "[" belong to a multi-line value.
    if (SECTION.test(line)) {
      current = undefined
      const head = HEADER.exec(line)
      if (head === null) {
        issues.push(`line ${i + 1}: unreadable section header`)
        continue
      }
      sawHeader = true
      const kind = head[1] ?? ''
      const fields = headerFields(head[2] ?? '')
      if (kind === 'ext_resource') {
        ext.push({ id: fields.id ?? '', type: fields.type ?? '', path: fields.path ?? '' })
      } else if (kind === 'node') {
        const name = fields.name ?? ''
        if (name === '') {
          issues.push(`line ${i + 1}: a node without a name`)
          continue
        }
        const parent = fields.parent ?? null
        const path = parent === null ? '.' : childPath(parent, name)
        const instanceId = extRef(fields.instance)
        const node: SceneNode = {
          path,
          name,
          type: fields.type ?? '',
          parent,
          instance: instanceId === '' ? '' : `#${instanceId}`,
          script: '',
          groups: groupsOf(fields.groups),
          isUnique: false,
          line: i + 1,
        }
        if (byPath.has(path)) {
          issues.push(path === '.' ? `more than one root node (line ${i + 1})` : `duplicate node name "${name}" under ${parent === '.' ? 'the root' : parent} (line ${i + 1})`)
          continue
        }
        byPath.set(path, node)
        nodes.push(node)
        current = node
      }
      continue
    }
    if (current === undefined) continue
    const prop = /^(\w+)\s*=\s*(.*)$/.exec(line)
    if (prop === null) continue
    if (prop[1] === 'script') {
      const id = extRef(prop[2])
      if (id !== '') current.script = `#${id}`
    } else if (prop[1] === 'unique_name_in_owner' && /^true/.test(prop[2] ?? '')) {
      current.isUnique = true
    }
  }

  if (!sawHeader && text.trim() !== '') issues.push('not a Godot text scene (no [section] headers)')
  if (sawHeader && nodes.length > 0 && nodes[0]?.path !== '.') issues.push('the first node has a parent: the scene has no root')

  // Resolve ExtResource ids to res:// paths, flag the ones never declared.
  const extById = new Map(ext.map(r => [r.id, r]))
  const resolve = (ref: string, node: SceneNode, what: string) => {
    if (ref === '') return ''
    const found = extById.get(ref.slice(1))
    if (found === undefined) {
      issues.push(`${node.path === '.' ? node.name : node.path}: ${what} ExtResource("${ref.slice(1)}") is not declared`)
      return ''
    }
    return found.path
  }
  for (const node of nodes) {
    node.instance = resolve(node.instance, node, 'instance')
    node.script = resolve(node.script, node, 'script')
  }

  // A parent must exist, unless it lies inside an instanced scene (editable children).
  const instancePaths = nodes.filter(n => n.instance !== '').map(n => n.path)
  for (const node of nodes) {
    if (node.parent === null || node.parent === '.') continue
    if (byPath.has(node.parent)) continue
    const isInsideInstance = instancePaths.some(p => node.parent === p || node.parent!.startsWith(`${p}/`))
    if (!isInsideInstance) issues.push(`${node.path}: parent "${node.parent}" does not exist`)
  }
  return { nodes, ext, issues }
}

/** The children of each node path, in file order. */
export function childrenOf(nodes: readonly SceneNode[]): Map<string, SceneNode[]> {
  const map = new Map<string, SceneNode[]>()
  for (const node of nodes) {
    if (node.parent === null) continue
    map.set(node.parent, [...(map.get(node.parent) ?? []), node])
  }
  return map
}

/** Node path -> how it reads in the pane ("Main" for the root). */
export function label(node: SceneNode): string {
  return `${node.isUnique ? '%' : ''}${node.name}`
}

const same = (a: SceneNode, b: SceneNode) => a.name === b.name && a.type === b.type && a.instance === b.instance

function depth(path: string): number {
  return path === '.' ? 0 : path.split('/').length
}

/**
 * What changed from `before` to `after`, by node path. A node that left one
 * parent and appeared under another with the same name and type is moved;
 * its children moved with it and are not listed again.
 */
export function diffScenes(before: readonly SceneNode[], after: readonly SceneNode[]): SceneDiff {
  const oldBy = new Map(before.map(n => [n.path, n]))
  const newBy = new Map(after.map(n => [n.path, n]))
  let removed = before.filter(n => !newBy.has(n.path))
  let added = after.filter(n => !oldBy.has(n.path))
  const moves: SceneMove[] = []

  // Shallowest first, so a moved parent is found before its children.
  for (const gone of [...removed].sort((a, b) => depth(a.path) - depth(b.path))) {
    if (!removed.includes(gone)) continue
    const target = added.find(n => same(n, gone) && n.parent !== gone.parent)
    if (target === undefined) continue
    moves.push({ path: target.path, from: gone.parent ?? '' })
    const prefix = `${gone.path}/`
    const carried = removed.filter(n => n.path.startsWith(prefix))
    const carriedNew = new Set(carried.map(n => `${target.path}/${n.path.slice(prefix.length)}`))
    removed = removed.filter(n => n !== gone && !carried.includes(n))
    added = added.filter(n => n !== target && !carriedNew.has(n.path))
  }

  const changed = after
    .filter(n => {
      const old = oldBy.get(n.path)
      return old !== undefined && (old.type !== n.type || old.instance !== n.instance || old.script !== n.script)
    })
    .map(n => n.path)

  return {
    added: added.map(n => n.path),
    removed: removed.map(n => ({ path: n.path, name: n.name, type: n.type, parent: n.parent ?? '' })),
    moved: moves,
    changed,
  }
}

export function diffIsEmpty(diff: SceneDiff): boolean {
  return diff.added.length + diff.removed.length + diff.moved.length + diff.changed.length === 0
}

/** "2 added · 1 moved · 1 removed" */
export function diffSummary(diff: SceneDiff): string {
  const parts: string[] = []
  if (diff.added.length > 0) parts.push(`${diff.added.length} added`)
  if (diff.moved.length > 0) parts.push(`${diff.moved.length} moved`)
  if (diff.removed.length > 0) parts.push(`${diff.removed.length} removed`)
  if (diff.changed.length > 0) parts.push(`${diff.changed.length} changed`)
  return parts.length === 0 ? 'no node changes' : parts.join(' · ')
}

/** What Claude reads after editing a scene with problems; undefined when it is clean. */
export function sceneContext(res: string, issues: readonly string[]): string | undefined {
  if (issues.length === 0) return undefined
  const shown = issues.slice(0, 8).map(i => `- ${i}`)
  if (issues.length > 8) shown.push(`(+${issues.length - 8} more)`)
  return [`godot-kit: the scene ${res} has ${issues.length} problem${issues.length === 1 ? '' : 's'}. Fix before moving on:`, ...shown].join('\n')
}

/** `.tscn` paths a shell command names (best effort, like gdPathsIn). */
export function tscnPathsIn(command: string): string[] {
  const found = new Set<string>()
  for (const m of command.matchAll(/(?:[A-Za-z]:)?[^\s"'`<>|;&(){}=,]*\.tscn(?![\w.])/g)) {
    if (m[0].startsWith('res://') || m[0].includes('*')) continue
    found.add(m[0])
    if (found.size >= 10) break
  }
  return [...found]
}
