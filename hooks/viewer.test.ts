import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, TurnStepChunk } from 'claude-code'

import { RUN, spoken, world } from './testkit'
import type { World } from './testkit'

const SCENE_TOOL = 'mcp__jarvis-viewer__mostrar_cena'

/**
 * The viewer (plugin `jarvis-viewer`) the way it reaches the Jarvis: it owns `say` and `playing`
 * and watches `said`. The kit loads it as its own module, so it closes over nothing: the test
 * drives it with the `viewer-sim` command and reads the `said` it saw from `fs.write`.
 */
const viewer: any = {
  name: 'jarvis-viewer',
  register(on: any) {
    on('command.run', { command: 'viewer-sim' }, async ($: any, e: any) => {
      const c = JSON.parse(e.args)
      if ('say' in c) await $.state.set({ plugin: 'jarvis-viewer', key: 'say' }, c.say)
      if ('playing' in c) await $.state.set({ plugin: 'jarvis-viewer', key: 'playing' }, c.playing)
      return { text: 'ok' }
    })
    on('state.set', { plugin: 'modo-conversa', key: 'said' }, async ($: any, e: any, next: any) => {
      const r = await next(e)
      await $.fs.write('viewer-sim.log', JSON.stringify(e.value))
      return r
    })
  },
}

type Said = { id: string; outcome: 'done' | 'stopped' }

/** Collects every `said` the simulated viewer saw. */
function saids(on: On): Said[] {
  const log: Said[] = []
  on('fs.write', async (_: any, e: any) => {
    if (String(e.path).endsWith('viewer-sim.log')) log.push(JSON.parse(e.text))
    return { value: undefined }
  })
  return log
}

async function viewerSets($: Engine, value: Record<string, unknown>) {
  await $.command.run({ command: 'viewer-sim', args: JSON.stringify(value), origin: { kind: 'user' } as never, presentation: 'inline' as never })
}

const text = (t: string, index = 0): TurnStepChunk => ({ kind: 'text', index, text: t })
const sceneCall = (index = 1): TurnStepChunk => ({ kind: 'tool', index, id: 'c1', name: SCENE_TOOL })

/** A model whose step `n` yields `steps[n]`. */
function stepsBottom(on: On, steps: TurnStepChunk[][]) {
  on('turn.start', async ($, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($, e) {
    for (const chunk of steps[e.index] ?? []) yield chunk
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as never, usage: null }
  })
  on('turn.complete', async ($, e) => ({ text: e.answer }))
  on('prompt.compose', async () => ({ sections: [] }))
}

async function step($: Engine, turnId: string, index: number) {
  for await (const _ of $.turn.step({ turnId, index, model: 'm', messageCount: 1 })) void _
}

async function startOn($: Engine, on: On) {
  const clock = mock.clock(on)
  const calls = world(on)
  const ran = $.command.run(RUN)
  await clock.settle()
  return { clock, calls, ran }
}

const speaks = (calls: World) => calls.cmds.filter(c => c.type === 'speak')

test('say do viewer vira speak com id e said done no spoken', { plugins: [viewer] }, async ($, on) => {
  stepsBottom(on, [])
  const said = saids(on)
  const { clock, calls, ran } = await startOn($, on)
  await viewerSets($, { playing: true, say: { id: 'a1', text: 'O site chama a API.' } })
  await clock.settle()
  expect(speaks(calls)).toEqual([{ type: 'speak', turn: '', chunks: ['O site chama a API.'], ids: ['a1'] }])
  expect(said).toEqual([])
  calls.emit({ type: 'spoken', id: 'a1', outcome: 'done' })
  await clock.settle()
  expect(said).toEqual([{ id: 'a1', outcome: 'done' }])
  // the same request seen again is not said twice
  await viewerSets($, { say: { id: 'a1', text: 'O site chama a API.' } })
  await clock.settle()
  expect(speaks(calls)).toHaveLength(1)
  // the loop ended normally: nothing is pending, so nothing is flushed
  await viewerSets($, { say: null, playing: false })
  await clock.settle()
  expect(calls.cmds.some(c => c.type === 'flush')).toBe(false)
  calls.release()
  await ran
})

test('say com Jarvis desligado responde stopped na hora', { plugins: [viewer] }, async ($, on) => {
  stepsBottom(on, [])
  const said = saids(on)
  const clock = mock.clock(on)
  const calls = world(on)
  await viewerSets($, { playing: true, say: { id: 'b1', text: 'Um.' } })
  await clock.settle()
  expect(said).toEqual([{ id: 'b1', outcome: 'stopped' }])
  expect(calls.cmds).toEqual([])
})

test('texto depois de mostrar_cena fica guardado até playing false', { plugins: [viewer] }, async ($, on) => {
  stepsBottom(on, [[text('Vou mostrar a arquitetura. '), sceneCall()], [text('O site chama a API. A API grava no banco.')]])
  const said = saids(on)
  const { clock, calls, ran } = await startOn($, on)
  await $.turn.start({ text: 'explica', turnId: 't1' })
  await step($, 't1', 0)
  // the opening is spoken at once
  expect(spoken(calls)).toEqual(['Vou mostrar a arquitetura.'])
  await viewerSets($, { playing: true, say: { id: 's1', text: 'Um.' } })
  await clock.settle()
  await step($, 't1', 1)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  // the summary waits for the scene; only the scene sentence went after the opening
  expect(spoken(calls)).toEqual(['Vou mostrar a arquitetura.', 'Um.'])
  calls.emit({ type: 'spoken', id: 's1', outcome: 'done' })
  await clock.settle()
  await viewerSets($, { say: { id: 's2', text: 'Dois.' } })
  await clock.settle()
  expect(spoken(calls)).toEqual(['Vou mostrar a arquitetura.', 'Um.', 'Dois.'])
  calls.emit({ type: 'spoken', id: 's2', outcome: 'done' })
  await clock.settle()
  expect(said).toEqual([
    { id: 's1', outcome: 'done' },
    { id: 's2', outcome: 'done' },
  ])
  await viewerSets($, { say: null, playing: false })
  await clock.settle()
  expect(spoken(calls)).toEqual(['Vou mostrar a arquitetura.', 'Um.', 'Dois.', 'O site chama a API.', 'A API grava no banco.'])
  expect(calls.cmds.some(c => c.type === 'flush')).toBe(false)
  calls.release()
  await ran
})

test('sem página aberta (playing nunca true) o resumo não é guardado', { plugins: [viewer] }, async ($, on) => {
  stepsBottom(on, [[text('Vou mostrar. '), sceneCall()], [text('Abra o navegador. Depois veja.')]])
  const { clock, calls, ran } = await startOn($, on)
  await $.turn.start({ text: 'explica', turnId: 't1' })
  await step($, 't1', 0)
  await step($, 't1', 1)
  await clock.settle()
  expect(spoken(calls)).toEqual(['Vou mostrar.', 'Abra o navegador.', 'Depois veja.'])
  calls.release()
  await ran
})

test('cena interrompida (say null) descarta a frase na fila e libera o resumo', { plugins: [viewer] }, async ($, on) => {
  stepsBottom(on, [[sceneCall(0)], [text('Resumo curto.')]])
  const said = saids(on)
  const { clock, calls, ran } = await startOn($, on)
  await $.turn.start({ text: 'explica', turnId: 't1' })
  await step($, 't1', 0)
  await viewerSets($, { playing: true, say: { id: 'c1', text: 'Um.' } })
  await clock.settle()
  await step($, 't1', 1)
  await clock.settle()
  expect(spoken(calls)).toEqual(['Um.'])
  // ⏸ on the page: the viewer clears say, then playing
  await viewerSets($, { say: null })
  await clock.settle()
  expect(calls.cmds.filter(c => c.type === 'flush')).toHaveLength(1)
  await viewerSets($, { playing: false })
  await clock.settle()
  // one flush only, and the held summary goes after it
  const flushAt = calls.cmds.findIndex(c => c.type === 'flush')
  expect(calls.cmds.filter(c => c.type === 'flush')).toHaveLength(1)
  expect(calls.cmds.slice(flushAt + 1).filter(c => c.type === 'speak').flatMap(c => c.chunks as string[])).toEqual(['Resumo curto.'])
  // the page reports the dropped sentence: it becomes said stopped
  calls.emit({ type: 'spoken', id: 'c1', outcome: 'stopped' })
  await clock.settle()
  expect(said).toEqual([{ id: 'c1', outcome: 'stopped' }])
  calls.release()
  await ran
})

test('pare descarta o guardado e responde stopped', { plugins: [viewer] }, async ($, on) => {
  stepsBottom(on, [[sceneCall(0)], [text('Resumo que não deve sair.')]])
  const said = saids(on)
  const { clock, calls, ran } = await startOn($, on)
  await $.turn.start({ text: 'explica', turnId: 't1' })
  await step($, 't1', 0)
  await viewerSets($, { playing: true, say: { id: 'p1', text: 'Um.' } })
  await clock.settle()
  await step($, 't1', 1)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  calls.emit({ type: 'stop' })
  await clock.settle()
  expect(calls.cmds).toContainEqual({ type: 'flush' })
  calls.emit({ type: 'spoken', id: 'p1', outcome: 'stopped' })
  await clock.settle()
  expect(said).toEqual([{ id: 'p1', outcome: 'stopped' }])
  await viewerSets($, { say: null, playing: false })
  await clock.settle()
  expect(spoken(calls)).toEqual(['Um.'])
  calls.release()
  await ran
})

test('pare entre duas frases: a próxima frase da cena volta stopped', { plugins: [viewer] }, async ($, on) => {
  stepsBottom(on, [])
  const said = saids(on)
  const { clock, calls, ran } = await startOn($, on)
  await viewerSets($, { playing: true, say: { id: 'q1', text: 'Um.' } })
  calls.emit({ type: 'spoken', id: 'q1', outcome: 'done' })
  await clock.settle()
  calls.emit({ type: 'stop' })
  await clock.settle()
  await viewerSets($, { say: { id: 'q2', text: 'Dois.' } })
  await clock.settle()
  expect(spoken(calls)).toEqual(['Um.'])
  expect(said).toEqual([
    { id: 'q1', outcome: 'done' },
    { id: 'q2', outcome: 'stopped' },
  ])
  // a new scene after the loop ended is narrated again
  await viewerSets($, { say: null, playing: false })
  await viewerSets($, { playing: true, say: { id: 'q3', text: 'Outra.' } })
  await clock.settle()
  expect(spoken(calls)).toEqual(['Um.', 'Outra.'])
  calls.release()
  await ran
})

test('sem viewer instalado nada muda', async ($, on) => {
  stepsBottom(on, [[text('Vou mostrar. '), sceneCall()], [text('Depois do resto.')]])
  const { clock, calls, ran } = await startOn($, on)
  await $.turn.start({ text: 'explica', turnId: 't1' })
  await step($, 't1', 0)
  await step($, 't1', 1)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect(spoken(calls)).toEqual(['Vou mostrar.', 'Depois do resto.'])
  expect(speaks(calls).every(c => !('ids' in c))).toBe(true)
  calls.release()
  await ran
})
