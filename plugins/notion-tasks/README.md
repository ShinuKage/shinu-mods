# notion-tasks

A Claude Code mod: a **/board** pane that lists your open Notion tasks. Press **▶ Start** on a task and the mod fetches the task's full Notion page at that moment and hands it to Claude in the session the pane is open in. While Claude is busy the button reads **▶ Queue**: the task waits and runs after the current turn.

With write-back on (the default), starting a task sets its Status to *In progress* and each row gets a **✓ Done** button that sets it to *Done*. Turn the `writeBack` option off and the pane never writes to Notion.

## Setup

- The claude.ai Notion connector must be connected to the session.
- When you install the mod, set its two Notion options. Both start empty, so nothing points at anyone else's workspace.
- Option `dataSource`: the `collection://…` URL of your tasks database. It expects the properties `Name` (title), `Status` (status: To do / In progress / Done), `Priority` (select: High / Medium / Low) and `Description` (text).

Tasks listed: Status is not Done; In progress first, then High → Low priority. The list loads when /board opens, after each write, and on ↻. If Notion can't be reached, the pane shows the error and a Retry button.

## /devlog [note]

Drafts a devlog entry for the work in this session since the last /devlog for this project folder: a one-line summary, **Done** and **Open problems** (written by Claude Haiku from a compact digest of the transcript), plus **Files** touched, **Tasks** started or completed from /board (linked to their Notion pages) and your optional note. The draft opens in a pane with **Post**, **Edit** and **Cancel**: nothing reaches Notion until you press Post. Post appends the entry under a `## date time` heading to the page set in the `devlogPage` option (Post says so if it is empty).
