export type Bookmark = {
  id: string
  createdAt: number
  /** What the person typed after /bookmark; '' when none. */
  note: string
  /** The note, or a label made from the last prompt when there was none. */
  label: string
  user: string
  assistant: string
  sessionId: string
  /** First prompt of the session, short: the API exposes no session title. */
  sessionLabel: string
}

export type BookmarkView = {
  query: string
  showAll: boolean
  /** Id of the bookmark whose Delete was pressed once and awaits a confirm. */
  confirmDelete: string
}

declare module 'claude-code' {
  interface PluginState {
    bookmarks: {
      list: Shaped<Bookmark[]>
      view: BookmarkView
      /** bookmark id -> requestId of its marker row, live in this process only */
      markers: Record<string, string>
      sessionId: string
    }
  }
}
