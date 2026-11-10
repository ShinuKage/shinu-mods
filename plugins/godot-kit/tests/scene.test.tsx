import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { fileKey } from '../hooks/shared/paths'
import { diffScenes, parseScene, sceneContext, tscnPathsIn } from '../hooks/scene/logic'

const PROJECT = 'C:/game'
const LEVEL = `${PROJECT}/level.tscn`

const BEFORE = `[gd_scene load_steps=4 format=3 uid="uid://abc"]

[ext_resource type="Script" uid="uid://s1" path="res://level.gd" id="1_lvl"]
[ext_resource type="PackedScene" path="res://player.tscn" id="2_ply"]

[sub_resource type="RectangleShape2D" id="RectangleShape2D_1"]
size = Vector2(10, 10)

[node name="Level" type="Node2D"]
script = ExtResource("1_lvl")

[node name="Player" parent="." instance=ExtResource("2_ply")]
position = Vector2(4, 4)

[node name="Enemies" type="Node2D" parent="." groups=["spawners"]]

[node name="Goblin" type="CharacterBody2D" parent="Enemies"]
unique_name_in_owner = true

[node name="Shape" type="CollisionShape2D" parent="Enemies/Goblin"]
shape = SubResource("RectangleShape2D_1")

[node name="Old" type="Timer" parent="."]

[connection signal="timeout" from="Old" to="." method="_on_old"]
`

/** Claude's edit: Goblin moved under a new Spawn node, a Camera added, Old removed. */
const AFTER = `[gd_scene load_steps=4 format=3 uid="uid://abc"]

[ext_resource type="Script" uid="uid://s1" path="res://level.gd" id="1_lvl"]
[ext_resource type="PackedScene" path="res://player.tscn" id="2_ply"]

[node name="Level" type="Node2D"]
script = ExtResource("1_lvl")

[node name="Player" parent="." instance=ExtResource("2_ply")]

[node name="Camera" type="Camera2D" parent="Player"]

[node name="Enemies" type="Node2D" parent="." groups=["spawners"]]

[node name="Spawn" type="Marker2D" parent="Enemies"]

[node name="Goblin" type="CharacterBody2D" parent="Enemies/Spawn"]
unique_name_in_owner = true

[node name="Shape" type="CollisionShape2D" parent="Enemies/Spawn/Goblin"]
`

const PLAYER = `[gd_scene format=3]
[ext_resource type="Script" path="res://player.gd" id="1"]
[node name="Player" type="CharacterBody2D"]
script = ExtResource("1")
[node name="Sprite" type="Sprite2D" parent="."]
`

describe('parsing', () => {
  test('nodes, nested parents, instances, scripts, groups', async () => {
    const { nodes, issues } = parseScene(BEFORE)
    expect(issues).toEqual([])
    expect(nodes.map(n => n.path)).toEqual(['.', 'Player', 'Enemies', 'Enemies/Goblin', 'Enemies/Goblin/Shape', 'Old'])
    const [level, player, enemies, goblin] = nodes
    expect(level).toMatchObject({ name: 'Level', type: 'Node2D', parent: null, script: 'res://level.gd' })
    expect(player).toMatchObject({ type: '', parent: '.', instance: 'res://player.tscn' })
    expect(enemies?.groups).toEqual(['spawners'])
    expect(goblin).toMatchObject({ parent: 'Enemies', isUnique: true, line: 17 })
  })

  test('Godot 3 references', async () => {
    const text = '[gd_scene load_steps=2 format=2]\n[ext_resource path="res://a.gd" type="Script" id=1]\n[node name="A" type="Node"]\nscript = ExtResource( 1 )\n'
    expect(parseScene(text).nodes[0]?.script).toBe('res://a.gd')
  })

  test('sanity: missing parent, duplicate sibling, undeclared resource; editable children are fine', async () => {
    const text = `[gd_scene format=3]
[ext_resource type="PackedScene" path="res://player.tscn" id="p"]
[node name="Root" type="Node"]
[node name="Player" parent="." instance=ExtResource("p")]
[node name="Hat" type="Sprite2D" parent="Player/Sprite"]
[node name="A" type="Node" parent="."]
[node name="A" type="Node" parent="."]
[node name="B" type="Node" parent="Nope/Deeper"]
[node name="C" type="Node" parent="."]
script = ExtResource("9_missing")
`
    expect(parseScene(text).issues).toEqual([
      'duplicate node name "A" under the root (line 7)',
      'C: script ExtResource("9_missing") is not declared',
      'Nope/Deeper/B: parent "Nope/Deeper" does not exist',
    ])
  })

  test('malformed files fail softly', async () => {
    expect(parseScene('')).toEqual({ nodes: [], ext: [], issues: [] })
    expect(parseScene('hello world').issues).toEqual(['not a Godot text scene (no [section] headers)'])
    const broken = parseScene('[gd_scene format=3]\n[node name="A" type="Node"\n[node name="B" type="Node" parent="."]\n')
    expect(broken.issues).toContain('line 2: unreadable section header')
    expect(broken.nodes.map(n => n.name)).toEqual(['B'])
    expect(broken.issues).toContain('the first node has a parent: the scene has no root')
  })
})

describe('diff', () => {
  test('added, moved (children carried), removed', async () => {
    const diff = diffScenes(parseScene(BEFORE).nodes, parseScene(AFTER).nodes)
    expect(diff.added).toEqual(['Player/Camera', 'Enemies/Spawn'])
    expect(diff.moved).toEqual([{ path: 'Enemies/Spawn/Goblin', from: 'Enemies' }])
    expect(diff.removed).toEqual([{ path: 'Old', name: 'Old', type: 'Timer', parent: '.' }])
    expect(diff.changed).toEqual([])
  })

  test('a changed type is changed, not added', async () => {
    const a = parseScene('[node name="R" type="Node"]\n[node name="X" type="Node2D" parent="."]\n').nodes
    const b = parseScene('[node name="R" type="Node"]\n[node name="X" type="Node3D" parent="."]\n').nodes
    expect(diffScenes(a, b)).toEqual({ added: [], removed: [], moved: [], changed: ['X'] })
  })

  test('what Claude reads, and paths in shell commands', async () => {
    expect(sceneContext('res://a.tscn', [])).toBe(undefined)
    expect(sceneContext('res://a.tscn', ['x: parent "y" does not exist'])).toBe(
      'godot-kit: the scene res://a.tscn has 1 problem. Fix before moving on:\n- x: parent "y" does not exist',
    )
    expect(tscnPathsIn('cp scenes/a.tscn "C:\\g\\b.tscn"; ls res://c.tscn')).toEqual(['scenes/a.tscn', 'C:\\g\\b.tscn'])
  })
})

// ---- The mod in the engine -------------------------------------------------

/** A tiny file system; the stand-in tool writes `next` content when called. */
function engine(on: On, files: Map<string, string>) {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const opened: string[] = []
  let pendingWrite: [string, string] | undefined
  let mtime = 1
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__godot-kit__${e.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: PROJECT }))
  on('fs.exists', (_, e) => ({ value: files.has(fileKey(e.path)) }))
  on('fs.read', (_, e) => {
    const text = files.get(fileKey(e.path))
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.stat', (_, e) => {
    if (!files.has(fileKey(e.path))) throw new Error('ENOENT')
    return { value: { kind: 'file', size: 1, mtimeMs: mtime, isLink: false } }
  })
  on('tool.call', (() => {
    if (pendingWrite !== undefined) {
      files.set(fileKey(pendingWrite[0]), pendingWrite[1])
      mtime++
    }
    return { result: {} }
  }) as never)
  return {
    clock,
    opened,
    willWrite: (file: string, text: string) => (pendingWrite = [file, text]),
  }
}

type Loose = { tool: { call: (input: unknown) => Promise<{ context?: readonly string[] }> } }
const edit = ($: Engine, file_path: string) =>
  ($ as unknown as Loose).tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' })

const world = () =>
  new Map(
    [
      [`${PROJECT}/project.godot`, 'config_version=5\n[application]\nrun/main_scene="res://level.tscn"\n'],
      [LEVEL, BEFORE],
      [`${PROJECT}/level.gd`, 'extends Node2D\n'],
      [`${PROJECT}/player.tscn`, PLAYER],
      [`${PROJECT}/player.gd`, 'extends CharacterBody2D\n'],
    ].map(([k, v]) => [fileKey(k as string), v as string]),
  )

const PANE = {
  plugin: 'godot-kit',
  component: 'Pane',
  requestId: 'godot-scene',
  props: {
    title: 'Scene',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('a .tscn edit refreshes the pane with what changed, on every surface', async ($, on) => {
  const eng = engine(on, world())
  eng.willWrite(LEVEL, AFTER)
  const ran = await edit($, 'C:\\game\\level.tscn')
  expect(ran.context ?? []).toEqual([])
  expect(eng.opened).toContain('godot-scene')

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /2 added · 1 moved · 1 removed/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Camera$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /↪ from Enemies/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Old$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /◆ level\.gd/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /⧉ player\.tscn/ })).toBeDefined()
    await ui.unmount()
  }
})

test('problems in an edited scene go back to Claude', async ($, on) => {
  const files = world()
  files.delete(fileKey(`${PROJECT}/level.gd`))
  const eng = engine(on, files)
  eng.willWrite(LEVEL, AFTER.replace('parent="Enemies/Spawn/Goblin"', 'parent="Enemies/Goblin"'))
  const ran = await edit($, `${PROJECT}/level.tscn`)
  const note = ran.context?.join('\n') ?? ''
  expect(note).toContain('godot-kit: the scene res://level.tscn has 2 problems')
  expect(note).toContain('Enemies/Goblin/Shape: parent "Enemies/Goblin" does not exist')
  expect(note).toContain('missing file res://level.gd')
})

test('other edits are ignored, and a malformed scene fails softly', async ($, on) => {
  const eng = engine(on, world())
  await edit($, `${PROJECT}/notes.md`)
  expect(eng.opened).toEqual([])
  eng.willWrite(LEVEL, '\u0000\u0001 not a scene')
  const ran = await edit($, LEVEL)
  expect(ran.context?.join('\n')).toContain('not a Godot text scene')
})

test('/scene shows the main scene; ▸ expands an instance', async ($, on) => {
  const eng = engine(on, world())
  await $.session.start({ cwd: PROJECT, surface: 'desktop', isInteractive: true })
  await ($ as unknown as { command: { run: (x: unknown) => Promise<unknown> } }).command.run({ command: 'scene', args: '' })
  expect(eng.opened).toContain('godot-scene')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /2 added/ })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /^%Goblin$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Sprite$/ })).toBe(undefined)
  await ui.press({ key: 'exp:Player' })
  await eng.clock.settle()
  expect(await ui.find({ type: 'Text', text: /^Sprite$/ })).toBeDefined()
  await ui.unmount()
})
