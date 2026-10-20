export type Mode = 'off' | 'starting' | 'on'
export type Phase = 'listening' | 'thinking' | 'speaking' | 'error'
// failed (R23): on, but could not speak (still opening, or its voice page inactive); the viewer falls back.
export type Said = { id: string; outcome: 'done' | 'stopped' | 'failed' } | null

declare module 'claude-code' {
  interface PluginState {
    'modo-conversa': { mode: Mode; phase: Phase; said: Said }
    // Owned by the Jarvis Viewer (plugin jarvis-viewer); declared here only so the Jarvis's hooks on it type-check.
    'jarvis-viewer': { say: { id: string; text: string } | null; playing: boolean }
  }
}
