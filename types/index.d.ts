export type Mode = 'off' | 'starting' | 'on'
export type Phase = 'listening' | 'thinking' | 'speaking' | 'error'

declare module 'claude-code' {
  interface PluginState {
    'modo-conversa': { mode: Mode; phase: Phase }
  }
}
