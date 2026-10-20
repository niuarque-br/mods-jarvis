import type { EngineInterface, PluginOptions } from 'claude-code'

import { LineSplitter } from './lines'

export const PORT = 47811
export const BASE = `http://127.0.0.1:${PORT}`

export type HelperEvent =
  | { type: 'ready'; port: number }
  | { type: 'utterance'; text: string }
  | { type: 'stop' }
  | { type: 'spoken'; id: string; outcome: 'done' | 'stopped' }
  | { type: 'closed' }
  | { type: 'error'; message: string }
  | { type: 'exit' }

export type HelperHandle = {
  port: number
  token: string
  send(cmd: Record<string, unknown>): Promise<void>
  stop(): Promise<void>
}

export async function helperCommand($: EngineInterface): Promise<{ argv: string[]; cwd: string }> {
  const root = $.plugin.root
  const exe = `${root}/bin/conversa-helper.exe`
  if (await $.fs.exists(exe)) return { argv: [exe, '--port', String(PORT)], cwd: root }
  return { argv: ['python', '-m', 'conversa', '--port', String(PORT)], cwd: `${root}/helper` }
}

export async function isBusy($: EngineInterface): Promise<boolean> {
  try {
    const r = await $.http.fetch(`${BASE}/ping`)
    return r.ok && JSON.parse(r.text).app === 'modo-conversa'
  } catch {
    return false
  }
}

export function helperEnv(options: PluginOptions, token: string): Record<string, string> {
  const config = {
    stt: String(options.sttProvider ?? 'browser'),
    tts: String(options.ttsProvider ?? 'edge'),
    voice: String(options.ttsVoice ?? ''),
    rate: String(options.ttsRate ?? '+0%'),
    silence_ms: Math.min(5000, Math.max(300, Number(options.silenceMs ?? 1200))),
    proximity: Math.min(90, Math.max(0, Number(options.proximity ?? 45))),
    stt_prompt: String(options.sttPrompt ?? '').slice(0, 1000),
  }
  const env: Record<string, string> = { CONVERSA_TOKEN: token, CONVERSA_CONFIG: JSON.stringify(config) }
  if (options.openaiApiKey) env.OPENAI_API_KEY = String(options.openaiApiKey)
  if (options.elevenlabsApiKey) env.ELEVENLABS_API_KEY = String(options.elevenlabsApiKey)
  return env
}

export async function startHelper(
  $: EngineInterface,
  options: PluginOptions,
  onEvent: (event: HelperEvent) => void,
): Promise<HelperHandle> {
  const token = crypto.randomUUID()
  const { argv, cwd } = await helperCommand($)
  const stream = $.process.spawn({ argv, cwd, env: helperEnv(options, token) })
  const lines = new LineSplitter()
  let stopped = false
  let ended = () => {}
  const finished = new Promise<void>(resolve => {
    ended = resolve
  })

  void (async () => {
    try {
      for await (const chunk of stream) {
        if (chunk.stream !== 'stdout' || stopped) continue
        for (const event of lines.push(chunk.text)) onEvent(event as HelperEvent)
      }
    } catch (err) {
      ended()
      if (!stopped) onEvent({ type: 'error', message: `O auxiliar do Modo Jarvis não iniciou: ${String((err as Error)?.message ?? err)}` })
      return
    }
    ended()
    if (!stopped) onEvent({ type: 'exit' })
  })()

  const send = async (cmd: Record<string, unknown>) => {
    try {
      await $.http.fetch(`${BASE}/cmd`, {
        method: 'POST',
        headers: { 'X-Conversa-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify(cmd),
      })
    } catch {
      return
    }
  }

  return {
    port: PORT,
    token,
    send,
    async stop() {
      if (stopped) return
      stopped = true
      await send({ type: 'quit' })
      await new Promise<void>(resolve => {
        const timer = $.clock.after(5000, () => resolve())
        void finished.then(() => {
          timer.cancel()
          resolve()
        })
      })
      void stream.return?.(undefined as never)
    },
  }
}
