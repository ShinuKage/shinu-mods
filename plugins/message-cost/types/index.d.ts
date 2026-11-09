/** Token counts summed over one or more API responses. */
export type Usage = {
  /** Uncached input tokens (processed fresh). */
  input: number
  output: number
  /** Input tokens served from the prompt cache. */
  cacheRead: number
  /** Input tokens written to the prompt cache. */
  cacheWrite: number
  /** How many API responses are summed. */
  responses: number
  /** Of those, how many reported no usage. */
  missing: number
}

/** One answer (turn) of the main loop, and the footer it carries. */
export type TurnRecord = {
  /** Every main-loop response of the turn so far, summed. */
  usage: Usage | null
  /** The turn's latest visible answer text, whitespace-normalized (fallback match). */
  text: string
  /** The newest bubble the turn drew (`msg_…-tN`): the one the footer sits on. */
  lastMessage?: string
}

declare module 'claude-code' {
  interface PluginState {
    'message-cost': {
      /** Footers, by turn id. */
      turns: Shaped<Record<string, TurnRecord>>
      /** Transcript message id -> turn id. */
      messages: Shaped<Record<string, string>>
    }
  }
}
