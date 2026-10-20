export type Mode = 'off' | 'starting' | 'on'
export type Phase = 'listening' | 'thinking' | 'speaking' | 'error'
export type Said = { id: string; outcome: 'done' | 'stopped' } | null

declare module 'claude-code' {
  interface PluginState {
    'modo-conversa': { mode: Mode; phase: Phase; said: Said }
    // Owned by the Jarvis Viewer (plugin jarvis-viewer); declared here only so the Jarvis's hooks on it type-check.
    'jarvis-viewer': { say: { id: string; text: string } | null; playing: boolean }
  }
}
