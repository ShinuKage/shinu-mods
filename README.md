# shinu-mods

Mods for [Claude Code](https://claude.com/claude-code), with an orange accent throughout.

| Mod | What it does |
| --- | --- |
| [`usage-band`](plugins/usage-band) | A two-row band above the prompt. Row 1: 5h limit, weekly limit and context fill, each with a bar and reset countdown. Row 2: prompt-cache warm/cold countdown, a ↻ reheat button, optional auto-reheat, and the session's token totals. Toasts when a limit or the context passes 80% and 90%. |
| [`turn-timer`](plugins/turn-timer) | A status line timer: `⏱ 1m 24s · 7 tools` while a turn runs, then last-turn and session totals. Toast for turns of 10 minutes or more. |
| [`bookmarks`](plugins/bookmarks) | `/bookmark [note]` saves the current point in a session; `/bookmarks` opens a pane to search, jump to, copy and delete them. |
| [`message-cost`](plugins/message-cost) | One dim footer at the end of each answer, summing every API call in it: `12.4k in · 820 out · 10.9k cached (88%) · 400 written`. Display only: the footer is never sent to the model. |
| [`godot-kit`](plugins/godot-kit) | Godot 4 helpers. After every `.gd` edit Godot checks the script headless: `✓ GDScript ok` / `✗ 2 script errors` in the status line, with the errors handed back to Claude to fix (`/godot-errors` lists them). `/play` runs the game in a panel that streams its output, and Claude can read it. `/scene` shows a scene's node tree and marks what Claude's last edit added, moved or removed. |
| [`notion-tasks`](plugins/notion-tasks) | `/board` lists your open Notion tasks; **▶ Start** hands one (with its page content) to Claude, and **✓ Done** marks it done. `/devlog` drafts a devlog entry for the session and appends it to a Notion page only when you press **Post**. Needs the claude.ai Notion connector. |

## Install

Requires a recent Claude Code: the mods were built and tested on 2.1.317 (older builds such as 2.1.205 reject the mod format). Update first with `claude update` if an install fails.

At the prompt of a Claude Code terminal session, one line per mod:

```
/plugin install usage-band --marketplace ShinuKage/shinu-mods
/plugin install turn-timer --marketplace ShinuKage/shinu-mods
/plugin install bookmarks --marketplace ShinuKage/shinu-mods
/plugin install message-cost --marketplace ShinuKage/shinu-mods
/plugin install godot-kit --marketplace ShinuKage/shinu-mods
/plugin install notion-tasks --marketplace ShinuKage/shinu-mods
```

Answer `y` to add the marketplace, then press Enter to install at the user scope (every session).

From a shell instead:

```bash
claude plugin install usage-band --marketplace ShinuKage/shinu-mods
```

In the Claude desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `ShinuKage/shinu-mods`, then **Add plugin**.

## Notes

- **Reheat** sends one tiny real request that re-reads the conversation from the prompt cache, so it uses a little of your limits each time. Auto-reheat is off by default and only fires while the session is idle.
- Bookmarks are stored on your machine in the mod's own store; nothing is sent anywhere.
- **godot-kit** finds Godot by itself in the usual Windows places (Program Files, Steam, scoop, Downloads); set its `godotPath` option if yours lives elsewhere. Tested with Godot 4.6.3.
- **notion-tasks** asks for two options at install: `dataSource` (your tasks database, with `Name`, `Status`, `Priority` and `Description` properties) and `devlogPage` (the page /devlog appends to). Both start empty. With `writeBack` on (the default), ▶ sets a task to *In progress* and ✓ sets it to *Done*; turn it off and the mod never writes to Notion except when you press Post on a devlog.
