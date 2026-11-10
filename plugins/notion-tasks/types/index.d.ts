export type Task = {
  /** Dashed Notion page id. */
  id: string
  url: string
  title: string
  status: string
  priority: string
  description: string
}

export type Board = {
  tasks: Task[]
  /** True while a load from Notion runs. */
  isLoading: boolean
  /** Why the last load failed; '' when it worked. */
  error: string
  /** When the list was last loaded (ms), 0 never. */
  loadedAt: number
}

export type DraftStatus = 'idle' | 'drafting' | 'ready' | 'editing' | 'posting' | 'posted' | 'error'

/** The /devlog draft: nothing reaches Notion until Post. */
export type Draft = {
  status: DraftStatus
  /** Tiny title for the heading `DD/MM/YY || title`. */
  title: string
  /** The entry text without its date heading. */
  body: string
  /** Why drafting or posting failed; '' when nothing failed. */
  error: string
  project: string
  sessionId: string
  /** Messages read when the draft was made: the next "since last" point. */
  messageCount: number
  /** Notion page the entry went to, once posted. */
  postedUrl: string
}

declare module 'claude-code' {
  interface PluginState {
    'notion-tasks': {
      board: Shaped<Board>
      /** True while a main-loop turn runs: ▶ then queues behind it. */
      isBusy: boolean
      /** task id -> what the pane is doing with it ('starting', 'finishing'). */
      working: Record<string, string>
      draft: Shaped<Draft>
    }
  }
}
