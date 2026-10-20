import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, TurnStepChunk } from 'claude-code'

import { Conversation } from './conversation'
import { RUN, spoken, world } from './testkit'
import type { WorldOptions } from './testkit'

const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

function turnBottom(on: On, chunks: TurnStepChunk[]) {
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($, e) {
    for (const chunk of chunks) yield chunk
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as never, usage: null }
  })
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('prompt.compose', async () => ({ sections: [] }))
}

async function startOn($: Engine, on: On, opts: WorldOptions = {}) {
  const clock = mock.clock(on)
  const calls = world(on, opts)
  const ran = $.command.run(RUN)
  await clock.settle()
  return { clock, calls, ran }
}

const text = (t: string, index = 0): TurnStepChunk => ({ kind: 'text', index, text: t })

async function runTurn($: Engine, turnId: string, answer: string, reason: 'answer' | 'error' = 'answer') {
  await $.turn.start({ text: 'oi', turnId })
  for await (const _ of $.turn.step({ turnId, index: 0, model: 'm', messageCount: 1 })) void _
  await $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId, reason })
}

test('conversation queues while a turn runs', async () => {
  const c = new Conversation()
  expect(c.utterance('roda os testes')).toEqual({ submit: 'roda os testes' })
  c.turnStarted('t1', 0)
  expect(c.utterance('e o lint?')).toEqual({ caption: 'guardei: e o lint?' })
  expect(c.utterance('e o build?')).toEqual({ caption: 'guardei: e o build?' })
  expect(c.turnEnded()).toBe('e o lint? e o build?')
  expect(c.turnEnded()).toBeUndefined()
})

test('stop without turn does not abort', async () => {
  const c = new Conversation()
  expect(c.stop()).toEqual({})
  c.turnStarted('t9', 0)
  c.utterance('guardada')
  expect(c.stop()).toEqual({ abort: 't9' })
  expect(c.turnEnded()).toBeUndefined()
})

test('acks need 4 s of silence and 15 s between them', async () => {
  const c = new Conversation()
  c.turnStarted('t1', 0)
  c.spoke(1000)
  expect(c.shouldAck(3000)).toBe(false)
  expect(c.shouldAck(5000)).toBe(true)
  expect(c.shouldAck(12000)).toBe(false)
  expect(c.shouldAck(20001)).toBe(true)
})

test('long wait warns after 12 s and at most every 30 s', async () => {
  const c = new Conversation()
  c.turnStarted('t1', 0)
  expect(c.shouldWarn(11000)).toBe(false)
  expect(c.shouldWarn(12000)).toBe(true)
  expect(c.shouldWarn(30000)).toBe(false)
  expect(c.shouldWarn(42001)).toBe(true)
  c.approvalPending = true
  expect(c.shouldWarn(90000)).toBe(false)
  c.approvalPending = false
  c.turnEnded()
  expect(c.shouldWarn(200000)).toBe(false)
})

test('speaks the reply as it streams', async ($, on) => {
  turnBottom(on, [text('Oi. Tudo '), text('bem? Sim.')])
  const { calls, ran } = await startOn($, on)
  await runTurn($, 't1', 'Oi. Tudo bem? Sim.')
  expect(spoken(calls)).toEqual(['Oi.', 'Tudo bem? Sim.'])
  const states = calls.cmds.filter(c => c.type === 'state').map(c => c.state)
  expect(states[0]).toBe('thinking')
  expect(states.at(-1)).toBe('listening')
  calls.release()
  await ran
})

test('narration before a tool call is spoken', async ($, on) => {
  turnBottom(on, [text('Vou olhar o arquivo'), { kind: 'tool', index: 1, id: 'x', name: 'Read' }])
  const { calls, ran } = await startOn($, on)
  await runTurn($, 't1', '')
  expect(spoken(calls)).toEqual(['Vou olhar o arquivo.'])
  calls.release()
  await ran
})

test('a long reply ends with a spoken summary', async ($, on) => {
  const long = 'Primeira frase com bastante conteúdo para ocupar espaço. '.repeat(10)
  turnBottom(on, [text(long)])
  let asked = ''
  on('model.complete', async ($, e) => {
    asked = String(e.prompt)
    return { value: { isAnswered: true as const, text: 'Fiz três mudanças.', usage: USAGE } }
  })
  const { clock, calls, ran } = await startOn($, on)
  await runTurn($, 't1', long)
  await clock.settle()
  expect(asked).toContain('Primeira frase')
  expect(spoken(calls).at(-1)).toBe('Resumindo: Fiz três mudanças. O detalhe está na tela.')
  calls.release()
  await ran
})

test('a failed summary still points to the screen', async ($, on) => {
  turnBottom(on, [text('Frase longa o bastante para passar do limite falado. '.repeat(10))])
  on('model.complete', async () => ({ value: { isAnswered: false as const, reason: 'empty-reply' as const, usage: USAGE } }))
  const { clock, calls, ran } = await startOn($, on)
  await runTurn($, 't1', 'x')
  await clock.settle()
  expect(spoken(calls).at(-1)).toBe('O detalhe está na tela.')
  calls.release()
  await ran
})

test('an utterance while idle becomes a prompt', async ($, on) => {
  turnBottom(on, [])
  const { clock, calls, ran } = await startOn($, on)
  calls.emit({ type: 'utterance', text: 'roda os testes' })
  await clock.settle()
  expect(calls.submitted).toEqual(['roda os testes'])
  calls.release()
  await ran
})

test('an utterance during a turn waits for its end', async ($, on) => {
  turnBottom(on, [])
  const { clock, calls, ran } = await startOn($, on)
  await $.turn.start({ text: 'oi', turnId: 't1' })
  calls.emit({ type: 'utterance', text: 'e o lint?' })
  await clock.settle()
  expect(calls.submitted).toEqual([])
  expect(calls.cmds).toContainEqual({ type: 'caption', text: 'guardei: e o lint?' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect(calls.submitted).toEqual(['e o lint?'])
  calls.release()
  await ran
})

test('stop during a turn flushes and aborts it', async ($, on) => {
  turnBottom(on, [])
  const { clock, calls, ran } = await startOn($, on)
  await $.turn.start({ text: 'oi', turnId: 't7' })
  calls.emit({ type: 'stop' })
  await clock.settle()
  expect(calls.cmds).toContainEqual({ type: 'flush' })
  expect(calls.aborted).toEqual(['t7'])
  calls.release()
  await ran
})

test('stop while idle only flushes', async ($, on) => {
  turnBottom(on, [])
  const { clock, calls, ran } = await startOn($, on)
  calls.emit({ type: 'stop' })
  await clock.settle()
  expect(calls.cmds).toContainEqual({ type: 'flush' })
  expect(calls.aborted).toEqual([])
  calls.release()
  await ran
})

test('a failed turn says so after 2 s', async ($, on) => {
  turnBottom(on, [])
  const { clock, calls, ran } = await startOn($, on)
  await runTurn($, 't1', '', 'error')
  expect(calls.cmds).toContainEqual({ type: 'state', state: 'error' })
  expect(spoken(calls)).toEqual([])
  await clock.advance(2000)
  expect(spoken(calls)).toEqual(['Tive um problema ao processar.'])
  calls.release()
  await ran
})

test('long wait is spoken after 12 s of silence', async ($, on) => {
  turnBottom(on, [])
  const { clock, calls, ran } = await startOn($, on)
  await $.turn.start({ text: 'oi', turnId: 't1' })
  await clock.advance(13000)
  expect(spoken(calls)).toEqual(['Ainda estou nisso.'])
  calls.release()
  await ran
})

test('the voice style section is added only while on', async ($, on) => {
  turnBottom(on, [])
  const compose = { model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: { name: 'default', isKeepingCodingInstructions: true }, traits: [] } as never
  const clock = mock.clock(on)
  const calls = world(on)
  const before = await $.prompt.compose(compose)
  expect(before.sections).toHaveLength(0)
  const ran = $.command.run(RUN)
  await clock.settle()
  const during = await $.prompt.compose(compose)
  expect(during.sections).toHaveLength(1)
  expect(during.sections[0]).toMatchObject({ id: 'modo-conversa', scope: 'session' })
  expect(during.sections[0]?.text).toContain('conversando por voz')
  calls.release()
  await ran
})

test('nothing is spoken while off', async ($, on) => {
  turnBottom(on, [text('Oi. Tudo bem? ')])
  const calls = world(on)
  mock.clock(on)
  await runTurn($, 't1', 'Oi.')
  expect(calls.cmds).toEqual([])
})

test('nothing more is spoken after a stop', async ($, on) => {
  const long = 'Frase comprida o bastante para passar do limite falado. '.repeat(10)
  let asked = 0
  on('model.complete', async () => {
    asked += 1
    return { value: { isAnswered: true as const, text: 'Resumo.', usage: USAGE } }
  })
  turnBottom(on, [text('Primeira. Segunda. Terceira. '), text(long)])
  const { clock, calls, ran } = await startOn($, on)
  await $.turn.start({ text: 'oi', turnId: 't1' })
  calls.emit({ type: 'stop' })
  await clock.settle()
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 })) void _
  await $.turn.complete({ answer: long, durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' })
  await clock.settle()
  expect(spoken(calls)).toEqual([])
  expect(asked).toBe(0)
  calls.release()
  await ran
})

test('a late summary is dropped once the next turn starts', async ($, on) => {
  const long = 'Frase comprida o bastante para passar do limite falado. '.repeat(10)
  let answer = () => {}
  on('model.complete', async () => {
    await new Promise<void>(resolve => {
      answer = resolve
    })
    return { value: { isAnswered: true as const, text: 'Resumo atrasado.', usage: USAGE } }
  })
  turnBottom(on, [text(long)])
  const { clock, calls, ran } = await startOn($, on)
  await runTurn($, 't1', long)
  await $.turn.start({ text: 'outra', turnId: 't2' })
  answer()
  await clock.settle()
  expect(spoken(calls).some(c => c.includes('Resumo atrasado'))).toBe(false)
  calls.release()
  await ran
})

test('after a stop the next utterance is sent at once', async ($, on) => {
  turnBottom(on, [])
  const { clock, calls, ran } = await startOn($, on)
  await $.turn.start({ text: 'oi', turnId: 't1' })
  calls.emit({ type: 'stop' })
  await clock.settle()
  calls.emit({ type: 'utterance', text: 'que ponto paramos?' })
  await clock.settle()
  expect(calls.submitted).toEqual(['que ponto paramos?'])
  expect(calls.cmds.filter(c => c.type === 'state').map(c => c.state)).toContain('listening')
  calls.release()
  await ran
})

test('a late complete of the stopped turn changes nothing', async ($, on) => {
  turnBottom(on, [])
  const { clock, calls, ran } = await startOn($, on)
  await $.turn.start({ text: 'oi', turnId: 't1' })
  calls.emit({ type: 'stop' })
  await clock.settle()
  await $.turn.start({ text: 'nova', turnId: 't2' })
  calls.emit({ type: 'utterance', text: 'e depois?' })
  await clock.settle()
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't1', reason: 'aborted' })
  await clock.settle()
  expect(calls.submitted).toEqual([])
  expect(calls.cmds).toContainEqual({ type: 'caption', text: 'guardei: e depois?' })
  calls.release()
  await ran
})

test('a spoken prompt is submitted as the user own words', async ($, on) => {
  turnBottom(on, [])
  const { clock, calls, ran } = await startOn($, on)
  calls.emit({ type: 'utterance', text: 'oi' })
  await clock.settle()
  expect(calls.submitted).toEqual(['oi'])
  expect(calls.origins).toEqual([{ kind: 'plugin', name: 'modo-conversa', asUser: true }])
  calls.release()
  await ran
})
