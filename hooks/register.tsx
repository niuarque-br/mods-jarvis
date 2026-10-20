import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import type { Mode, Phase, Said as SaidState } from '../types'
import { approvalQuestion } from './approval'
import { Conversation, shownMode } from './conversation'
import { BASE, isBusy, startHelper } from './helper'
import type { HelperEvent, HelperHandle } from './helper'
import { SentenceStream, toolAck } from './speakable'

const mode = atom({ plugin: 'modo-conversa', key: 'mode' } as const, 'off' as Mode)
const phase = atom({ plugin: 'modo-conversa', key: 'phase' } as const, 'listening' as Phase)

const PHASE_LABEL: Record<Phase, string> = {
  listening: 'ouvindo',
  thinking: 'pensando',
  speaking: 'falando',
  error: 'erro',
}

type Said = Exclude<SaidState, null>

const COMMANDS = ['conversa', 'jarvis'] as const
/** The Jarvis Viewer's scene tool: the reply text after it is the scene's summary. */
const SCENE_TOOL = 'mcp__jarvis-viewer__mostrar_cena'
const SUMMARY_MODEL = 'claude-haiku-5-5'
const ERROR_PHRASE = 'Tive um problema ao processar.'
const WAIT_PHRASE = 'Ainda estou nisso.'
const SCREEN_PHRASE = 'O detalhe está na tela.'
const VOICE_STYLE =
  'O usuário está conversando por voz. Comece com uma frase curta que responda ou diga o que vai fazer. ' +
  'Prefira frases curtas, sem tabelas, e deixe detalhes técnicos no texto depois de um resumo falado.'

let options: PluginOptions = {}
let handle: HelperHandle | null = null
let generation = 0
let live = false
let conversation = new Conversation()
let stream: SentenceStream | null = null
let ticker: Timer | null = null

// The Jarvis Viewer (plugin jarvis-viewer), when installed, asks for scene sentences through its
// own state keys `say` and `playing`. None of this runs without it.
/** The viewer's `playing`: a scene narrated by the Jarvis is on. */
let scenePlaying = false
/** Scene sentences sent to the page and not yet answered: still queued, or already flushed. */
const sceneSays = new Map<string, 'queued' | 'dropped'>()
/** A "pare" came while a scene played: its next sentence is answered stopped. */
let sceneStopped = false
/** The last `say` id seen: the same request written again is not said twice. */
let lastSayId: string | null = null

/** Writes `said`; always from a timer or a helper event, never inline in another plugin's state.set. */
async function writeSaid($: EngineInterface, said: Said) {
  await $.state.set({ plugin: 'modo-conversa', key: 'said' } as const, said).catch(() => undefined)
}

function answerLater($: EngineInterface, said: Said) {
  $.clock.after(0, () => {
    void writeSaid($, said)
  })
}

async function onSceneSay($: EngineInterface, value: unknown) {
  const say = value as { id?: unknown; text?: unknown } | null | undefined
  if (!say || typeof say !== 'object') return dropScene($)
  if (typeof say.id !== 'string' || typeof say.text !== 'string' || say.id === lastSayId) return
  const id = say.id
  lastSayId = id
  if (!live || !handle || sceneStopped) return answerLater($, { id, outcome: 'stopped' })
  sceneSays.set(id, 'queued')
  conversation.spoke(await $.clock.now())
  // Queued on the page after whatever it is saying; the page answers with `spoken`.
  await send($, { type: 'speak', turn: conversation.turnId ?? '', chunks: [say.text], ids: [id] })
}

/** The scene ended or was cut: a sentence still queued on the page is not said any more. */
async function dropScene($: EngineInterface) {
  const queued = [...sceneSays].filter(([, state]) => state === 'queued').map(([id]) => id)
  if (!queued.length) return
  for (const id of queued) sceneSays.set(id, 'dropped')
  // The page can only flush its whole queue; while a scene plays the reply is held, so little else is in it.
  await send($, { type: 'flush' })
}

async function onScenePlaying($: EngineInterface, value: unknown) {
  const was = scenePlaying
  scenePlaying = value === true
  if (scenePlaying || !was) return
  sceneStopped = false
  await dropScene($)
  const held = conversation.release()
  if (held.length) await speak($, held)
}

function onSpoken($: EngineInterface, id: string, outcome: 'done' | 'stopped') {
  if (!sceneSays.delete(id)) return
  void writeSaid($, { id, outcome })
}

/** Speaks the reply, or keeps it while the scene it summarizes is playing. */
async function speakReply($: EngineInterface, chunks: string[]) {
  if (!chunks.length || conversation.stopped) return
  if (conversation.hold(chunks, scenePlaying)) return
  await speak($, chunks)
}

async function setPhase($: EngineInterface, next: Phase) {
  await update($, phase, () => next)
  if ((await read($, mode)) === 'on') $.ui.status(`🎙 ${PHASE_LABEL[next]}`)
}

async function send($: EngineInterface, cmd: Record<string, unknown>) {
  if (handle) await handle.send(cmd)
}

async function currentMode($: EngineInterface) {
  return shownMode(await read($, mode), handle !== null)
}

async function speak($: EngineInterface, chunks: string[]) {
  if (!live || !chunks.length || conversation.stopped) return
  conversation.spoke(await $.clock.now())
  await send($, { type: 'speak', turn: conversation.turnId ?? '', chunks })
}

async function setState($: EngineInterface, state: Phase) {
  await send($, { type: 'state', state })
  await setPhase($, state)
}

async function turnOff($: EngineInterface, reason?: string) {
  generation += 1
  live = false
  const current = handle
  handle = null
  ticker?.cancel()
  ticker = null
  stream = null
  conversation = new Conversation()
  sceneSays.clear()
  sceneStopped = false
  await update($, mode, () => 'off')
  $.ui.status(undefined)
  if (reason) $.ui.toast(reason)
  if (current) await current.stop()
}

async function submit($: EngineInterface, text: string) {
  await setState($, 'thinking')
  void $.prompt.submit({ text, asUser: true })
}

async function onUtterance($: EngineInterface, text: string) {
  const result = conversation.utterance(text)
  if (result.caption) await send($, { type: 'caption', text: result.caption })
  if (result.submit) await submit($, result.submit)
}

async function onStop($: EngineInterface) {
  await send($, { type: 'flush' })
  // The page answers the scene sentences it dropped; one asked for after this stop is not said.
  sceneStopped = scenePlaying
  const { abort } = conversation.stop()
  if (!abort) return
  stream = null
  await $.turn.abort({ turnId: abort }).catch(() => undefined)
  await setState($, 'listening')
}

async function onTick($: EngineInterface) {
  if (live && conversation.shouldWarn(await $.clock.now())) await speak($, [WAIT_PHRASE])
}

async function onHelperEvent($: EngineInterface, mine: number, event: HelperEvent) {
  if (mine !== generation) return
  switch (event.type) {
    case 'ready':
      live = true
      await update($, mode, () => 'on')
      await setPhase($, 'listening')
      ticker = $.clock.every(1000, () => {
        onTick($).catch(() => undefined)
      })
      return
    case 'utterance':
      return onUtterance($, event.text)
    case 'stop':
      return onStop($)
    case 'spoken':
      return onSpoken($, event.id, event.outcome)
    case 'closed':
      return turnOff($, 'A janela do Modo Jarvis foi fechada.')
    case 'error':
      return turnOff($, event.message)
    case 'exit':
      return turnOff($, 'O Modo Jarvis foi encerrado.')
  }
}

async function turnOn($: EngineInterface) {
  if (handle) return
  if (await isBusy($)) {
    $.ui.toast('O Modo Jarvis já está ligado em outra sessão.')
    return
  }
  generation += 1
  const mine = generation
  await update($, mode, () => 'starting')
  handle = await startHelper($, options, event => {
    onHelperEvent($, mine, event).catch(() => undefined)
  })
  $.clock.after(30000, () => {
    void (async () => {
      if (mine === generation && (await read($, mode)) === 'starting') await turnOff($, 'O Modo Jarvis não abriu a tempo.')
    })()
  })
}

async function toggle($: EngineInterface) {
  if ((await currentMode($)) === 'off') await turnOn($)
  else await turnOff($)
}

async function runToggle($: EngineInterface) {
  const was = await currentMode($)
  await toggle($)
  return { text: was === 'off' ? 'Abrindo o Modo Jarvis…' : 'Modo Jarvis desligado.' }
}

async function summarize($: EngineInterface, rest: string) {
  const prompt =
    'Resuma em português do Brasil, em no máximo 2 frases e 40 palavras, para ser falado em voz alta, ' +
    'sem markdown, o trecho final desta resposta de um assistente de programação:\n\n' +
    rest.slice(0, 6000)
  const mine = generation
  const ended = conversation.turnId
  let text = ''
  try {
    const result = await $.model.complete({ model: SUMMARY_MODEL, prompt, maxTokens: 200, timeoutMs: 15000 })
    text = result.isAnswered ? result.text.replace(/\s+/g, ' ').trim() : ''
  } catch {
    text = ''
  }
  if (mine !== generation || (conversation.turnId !== null && conversation.turnId !== ended)) return
  await speakReply($, [text ? `Resumindo: ${text} ${SCREEN_PHRASE}` : SCREEN_PHRASE])
}

async function onTurnStart($: EngineInterface, turnId: string) {
  conversation.turnStarted(turnId, await $.clock.now())
  stream = new SentenceStream()
  await setState($, 'thinking')
}

async function onTurnEnd($: EngineInterface, failed: boolean, aborted: boolean) {
  const finished = stream?.finish() ?? { chunks: [], rest: '' }
  stream = null
  const quiet = aborted || conversation.stopped
  if (!quiet) await speakReply($, finished.chunks)
  if (finished.rest && !failed && !quiet) void summarize($, finished.rest)
  if (failed) {
    await send($, { type: 'state', state: 'error' })
    await setPhase($, 'error')
    $.clock.after(2000, () => {
      speak($, [ERROR_PHRASE]).catch(() => undefined)
    })
  } else {
    await setState($, 'listening')
  }
  const next = conversation.turnEnded()
  if (next) await submit($, next)
}

async function askApproval($: EngineInterface, question: string): Promise<string> {
  const current = handle
  if (!live || !current) return 'timeout'
  conversation.approvalPending = true
  try {
    const response = await $.http.fetch(`${BASE}/approval/wait`, {
      method: 'POST',
      headers: { 'X-Conversa-Token': current.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: crypto.randomUUID(), question }),
    })
    return String(JSON.parse(response.text).decision ?? 'timeout')
  } catch {
    return 'timeout'
  } finally {
    conversation.approvalPending = false
  }
}

export const register: Register = (on, loaded: PluginOptions) => {
  options = loaded

  on('session.start', async ($, e, next) => {
    for (const name of COMMANDS) await $.command.register({ name, description: 'Liga ou desliga o Modo Jarvis por voz' })
    return next(e)
  })

  on('command.run', { command: 'conversa' }, async $ => runToggle($))
  on('command.run', { command: 'jarvis' }, async $ => runToggle($))

  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    if (live && e.agentId === undefined) await onTurnStart($, e.turnId)
    return started
  })

  on('turn.step', async function* ($, e, next) {
    const steps = next(e)
    let item = await steps.next()
    while (!item.done) {
      const chunk = item.value
      if (live && e.agentId === undefined && stream) {
        if (chunk.kind === 'text') await speakReply($, stream.push(chunk.text))
        else if (chunk.kind === 'tool') await speakReply($, stream.flushBlock())
      }
      if (e.agentId === undefined && chunk.kind === 'tool' && chunk.name === SCENE_TOOL) conversation.afterScene = true
      yield chunk
      item = await steps.next()
    }
    if (live && e.agentId === undefined && stream) await speakReply($, stream.flushBlock())
    return item.value
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined && e.tool === SCENE_TOOL) conversation.afterScene = true
    if (live && e.agentId === undefined && conversation.shouldAck(await $.clock.now())) await speak($, [toolAck(e.tool)])
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (live && e.agentId === undefined && e.turnId === conversation.turnId) {
      await onTurnEnd($, e.reason === 'error' || e.reason === 'refusal', e.reason === 'aborted')
    }
    return result
  })

  // The Jarvis Viewer asks for each scene sentence; observed only, the write goes on unchanged.
  on('state.set', { plugin: 'jarvis-viewer', key: 'say' }, async ($, e, next) => {
    const result = await next(e)
    await onSceneSay($, e.value).catch(() => undefined)
    return result
  }).catch(($, e, next) => next(e))

  on('state.set', { plugin: 'jarvis-viewer', key: 'playing' }, async ($, e, next) => {
    const result = await next(e)
    await onScenePlaying($, e.value).catch(() => undefined)
    return result
  }).catch(($, e, next) => next(e))

  on('classic.PermissionRequest', async ($, e, next) => {
    const question = live ? approvalQuestion(e.tool_name, e.tool_input, e.cwd) : null
    if (!question) return next(e)
    const decision = await askApproval($, question)
    if (decision === 'allow') return { decision: { behavior: 'allow' as const } }
    if (decision === 'deny') return { decision: { behavior: 'deny' as const, message: 'Negado por voz.' } }
    return next(e)
  }).catch(($, e, next) => next(e))


  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!live) return composed
    return { ...composed, sections: [...composed.sections, { id: 'modo-conversa', text: VOICE_STYLE, scope: 'session' as const }] }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const below = await next(e)
    const current = await currentMode($)
    if (current === 'off') {
      return (
        <Box gap={1}>
          <Button key="toggle" label="🎙 Modo Jarvis" onPress={() => toggle($)} />
          {below}
        </Box>
      )
    }
    if (current === 'starting') {
      return (
        <Box gap={1}>
          <Text dimColor>Abrindo o Modo Jarvis…</Text>
          {below}
        </Box>
      )
    }
    const label = PHASE_LABEL[await read($, phase)]
    return (
      <Box gap={1}>
        <Text>● Jarvis ligado — {label}</Text>
        <Button key="toggle" label="Desligar" onPress={() => toggle($)} />
        {below}
      </Box>
    )
  })
}
