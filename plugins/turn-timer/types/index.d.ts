/** The main-loop turn running now. */
export type ActiveTurn = { turnId: string; startedAt: number; tools: number }

/** What this session's finished main-loop turns add up to. */
export type SessionTotals = {
  turns: number
  totalMs: number
  tools: number
  lastMs: number
  lastTools: number
}

declare module 'claude-code' {
  interface PluginState {
    'turn-timer': {
      active: Shaped<ActiveTurn | null>
      totals: Shaped<SessionTotals>
    }
  }
}
