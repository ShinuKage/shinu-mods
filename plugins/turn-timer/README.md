# turn-timer

A Claude Code mod that puts a live timer for the running turn in the status line.

- While a turn runs: `⏱ 1m 24s · 7 tools`, updated every second. Tool calls made by subagents during the turn are counted too.
- When it ends: `last turn 3m 10s · 12 tools`, and from the second turn on the session's total and average turn time, e.g. `· session 18m 02s, avg 2m 15s (8 turns)`.
- A turn of 10 minutes or longer raises a toast when it ends.

Values live in the session's `$.state`, so a reload mid-turn keeps counting.
