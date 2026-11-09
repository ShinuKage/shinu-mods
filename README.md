# shinu-mods

Mods for [Claude Code](https://claude.com/claude-code), with an orange accent throughout.

| Mod | What it does |
| --- | --- |
| [`usage-band`](plugins/usage-band) | A two-row band above the prompt. Row 1: 5h limit, weekly limit and context fill, each with a bar and reset countdown. Row 2: prompt-cache warm/cold countdown, a ↻ reheat button, optional auto-reheat, and the session's token totals. Toasts when a limit or the context passes 80% and 90%. |
| [`turn-timer`](plugins/turn-timer) | A status line timer: `⏱ 1m 24s · 7 tools` while a turn runs, then last-turn and session totals. Toast for turns of 10 minutes or more. |
| [`bookmarks`](plugins/bookmarks) | `/bookmark [note]` saves the current point in a session; `/bookmarks` opens a pane to search, jump to, copy and delete them. |

## Install

Requires a recent Claude Code: the mods were built and tested on 2.1.317 (older builds such as 2.1.205 reject the mod format). Update first with `claude update` if an install fails.

At the prompt of a Claude Code terminal session, one line per mod:

```
/plugin install usage-band --marketplace ShinuKage/shinu-mods
/plugin install turn-timer --marketplace ShinuKage/shinu-mods
/plugin install bookmarks --marketplace ShinuKage/shinu-mods
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
