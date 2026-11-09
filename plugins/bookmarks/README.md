# bookmarks

A Claude Code mod for saving points in a session and coming back to them.

- `/bookmark [note]` saves the current point: the time, your note (or an automatic label taken from the last prompt), a short excerpt of the last prompt and reply, and the session it came from. A small orange marker row is placed in the transcript.
- `/bookmarks` opens a pane listing bookmarks newest first, with search, a This session / All sessions toggle, and Jump, Copy and Delete (with confirm) on each one.

Bookmarks are kept across sessions in the mod's store. Jump scrolls to the marker row, which only exists in the live session that made it: after a restart, a resume, or from another session, there is nothing to jump to and the button is hidden.
