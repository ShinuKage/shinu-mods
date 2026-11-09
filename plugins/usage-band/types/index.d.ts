export type UsageBandTtl = '5m' | '1h'

export type UsageBandLimit = {
  kind: string
  percentUsed: number
  resetsAt?: string
}

export type UsageBandSnapshot = {
  rateLimits: UsageBandLimit[]
  context: { tokens?: number; window: number; percent?: number }
  costUsd?: number
}

export type UsageBandReheat = {
  phase: 'idle' | 'running' | 'done' | 'failed'
  at: number
  note: string
}

export type UsageBandAlertMark = { window: string; level: number }

export type UsageBandTokens = { input: number; output: number }

declare module 'claude-code' {
  interface PluginState {
    'usage-band': {
      snapshot: UsageBandSnapshot | null
      lastWarmAt: number | null
      isBusy: boolean
      autoReheat: boolean
      ttl: UsageBandTtl
      reheat: UsageBandReheat
      contextAlert: UsageBandAlertMark | null
      tokens: UsageBandTokens
      now: number
      autoFiredFor: number | null
    }
  }
}
