# godot-kit

Godot helpers for Claude Code, built in stages. One module per feature, all sharing one config (where Godot is, which project).

## 1. Script check

After Claude edits or writes a `.gd` file inside a Godot project (any folder that holds `project.godot`), godot-kit loads the script with Godot headless and:

- shows the result in the status line: `✓ GDScript ok` or `✗ 2 script errors`
- adds the errors (`res://file.gd:line: message`, up to 8) to the tool result Claude reads right after its edit, so Claude fixes them in the same turn
- lists every error in a pane, opened with `/godot-errors` (with a Re-check button)

Shell commands (Bash, PowerShell) that change a `.gd` file they name are checked too.

Edits made together share one Godot run, and runs never overlap: a check waits ~150 ms for more edits, then one Godot process checks the whole batch. When a script declares a new `class_name` the project's class cache doesn't know yet, godot-kit runs `godot --headless --import` once first, so Godot doesn't report false "not declared" errors.

The edit itself is never blocked or broken: a missing Godot, a Godot that hangs (killed after the timeout) or any failure in the mod leaves the tool result untouched and shows `⚠` in the status line.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `godotPath` | auto-detect | Full path to Godot (on Windows the `_console.exe` build). Auto-detect looks in Program Files, Steam, scoop, Downloads, Desktop, `C:\Godot`, `D:\Games` and similar, then `godot` on PATH. |
| `projectPath` | any project | Only check scripts in this project folder. |
| `checkTimeoutSec` | 20 | How long one check may run. |

Tested with Godot 4.6.3. Godot 3's output format is parsed too, but not tested against a real Godot 3.

## 2. Run panel: `/play`

(Claude Code ships its own `/run`, so the command is `/play`.)

- `/play` runs the project's main scene in a normal game window; `/play res://scenes/level.tscn` runs one scene; add `--headless` for no window.
- A pane beside the chat streams the game's stdout/stderr live: errors in red, warnings in orange, backtrace lines dimmed. The header shows the state (running, exited with code N, crashed, stopped) with Stop and Restart buttons, plus error and warning counts.
- `/play` while the game runs restarts it.
- A crash opens the pane if it was closed.
- Claude can read the run without you pasting anything: the `godot_run_output` tool returns the state, every error and warning with its `res://file:line`, and the last lines. Claude can also start or stop a run itself with `godot_run` (for example to reproduce a crash after a fix).
- The last 2,000 lines are kept. The game is stopped when the session ends or the mod reloads; Stop ends the process stream and, if the game lingers, kills exactly that run's processes (each run carries a marker on its command line), so no Godot window is left behind.

The project is `projectPath` when set, else the project that holds the session's folder, else the project of the last script Claude edited.

## 3. Scene tree viewer: `/scene`

- `/scene` shows the scene Claude last edited (or the project's main scene); `/scene res://scenes/level.tscn` shows another.
- The pane draws the node tree with tree lines: name, type (dim), `◆ script.gd`, `⧉ sub.tscn` for instanced scenes (▸ expands one level at a time), `#groups`, and `%` for unique names.
- After Claude edits a `.tscn` (Edit, Write, or a shell command that names it), the pane opens and marks what changed versus before the edit: added nodes in orange, moved or reparented ones with "↪ from <old parent>", changed types or scripts with "~ changed", and removed ones listed struck through under the tree.
- Sanity checks under the tree: a parent path that doesn't exist, a duplicate sibling name, an ExtResource id that isn't declared, an ext_resource file that's missing. These are also added to the result Claude reads after its edit, so it fixes them in the same turn.
- Godot 4 text scenes (Godot 3's `ExtResource( 1 )` form is read too). A file it can't read shows a problem line instead of breaking anything.
