import { expect, mock, test } from 'claude-code/testing'
import { shownMode } from './conversation'
import { LineSplitter } from './lines'
import { BAND, READY, RUN, world } from './testkit'

const SURFACES = ['terminal', 'desktop'] as const

test('line splitter', async () => {
  const lines = new LineSplitter()
  expect(lines.push('{"a":1}\n{"b"')).toEqual([{ a: 1 }])
  expect(lines.push(':2}\n')).toEqual([{ b: 2 }])
  expect(lines.push('lixo\n\n{"c":3}\n')).toEqual([{ c: 3 }])
})

for (const surface of SURFACES) {
  test(`band shows the toggle when off (${surface})`, async ($, on) => {
    mock.clock(on)
    world(on)
    const ui = await $.ui.mount({ plugin: 'modo-conversa', surface, component: 'AbovePrompt', props: BAND })
    expect((await ui.find({ key: 'toggle' }))?.text).toContain('Modo Jarvis')
  })

  test(`a faixa mantém o que os outros mods desenham (${surface})`, async ($, on) => {
    mock.clock(on)
    world(on)
    const ui = await $.ui.mount({ plugin: 'modo-conversa', surface, component: 'AbovePrompt', props: BAND })
    expect(await ui.find({ key: 'toggle' })).toBeDefined()
    expect(await ui.find({ text: '⚙ Config Mods' })).toBeDefined()
  })

  test(`pressing the toggle starts the helper and turns on (${surface})`, async ($, on) => {
    const clock = mock.clock(on)
    const calls = world(on)
    const ui = await $.ui.mount({ plugin: 'modo-conversa', surface, component: 'AbovePrompt', props: BAND })
    const pressed = ui.press({ key: 'toggle' })
    await clock.settle()
    expect(calls.spawned).toHaveLength(1)
    expect(calls.spawned[0]!.argv.slice(0, 3)).toEqual(['python', '-m', 'conversa'])
    expect(calls.spawned[0]!.env?.CONVERSA_TOKEN).toMatch(/.{16,}/)
    expect(JSON.parse(calls.spawned[0]!.env?.CONVERSA_CONFIG ?? '{}')).toMatchObject({ stt: 'browser', tts: 'edge', silence_ms: 1200, proximity: 45 })
    expect(calls.spawned[0]!.env?.OPENAI_API_KEY).toBeUndefined()
    expect((await ui.find({ key: 'toggle' }))?.text).toContain('Desligar')
    expect(calls.status.at(-1)).toBe('🎙 ouvindo')
    calls.release()
    await pressed
  })
}

test('the packaged helper is preferred', async ($, on) => {
  const clock = mock.clock(on)
  const calls = world(on, { exe: true, ends: true })
  await $.command.run(RUN)
  await clock.settle()
  expect(calls.spawned[0]!.argv[0]).toMatch(/bin[\\/]conversa-helper\.exe$/)
})

test('/jarvis liga e desliga como /conversa', async ($, on) => {
  const clock = mock.clock(on)
  const calls = world(on)
  const ran = $.command.run({ ...RUN, command: 'jarvis' })
  await clock.settle()
  expect(calls.spawned).toHaveLength(1)
  calls.release()
  expect(await ran).toMatchObject({ text: 'Abrindo o Modo Jarvis…' })
})

test('keys reach the helper only by environment', { options: { sttProvider: 'openai', openaiApiKey: 'sk-teste' } }, async ($, on) => {
  const clock = mock.clock(on)
  const calls = world(on, { ends: true })
  await $.command.run(RUN)
  await clock.settle()
  expect(calls.spawned[0]!.env?.OPENAI_API_KEY).toBe('sk-teste')
  expect(calls.spawned[0]!.env?.CONVERSA_CONFIG).not.toContain('sk-teste')
})

test('ping busy → toast', async ($, on) => {
  const clock = mock.clock(on)
  const calls = world(on, { busy: true })
  await $.command.run(RUN)
  await clock.settle()
  expect(calls.spawned).toHaveLength(0)
  expect(calls.toasts).toContain('O Modo Jarvis já está ligado em outra sessão.')
})

test('helper exit turns mode off', async ($, on) => {
  const clock = mock.clock(on)
  const calls = world(on, { chunks: [READY, '{"type":"closed"}\n'], ends: true })
  const ui = await $.ui.mount({ plugin: 'modo-conversa', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  await ui.press({ key: 'toggle' })
  await clock.settle()
  expect(calls.toasts).toContain('A janela do Modo Jarvis foi fechada.')
  expect((await ui.find({ key: 'toggle' }))?.text).toContain('Modo Jarvis')
  expect(calls.status.at(-1)).toBeUndefined()
})

test('process that dies without a word turns mode off', async ($, on) => {
  const clock = mock.clock(on)
  const calls = world(on, { chunks: [READY], ends: true })
  await $.command.run(RUN)
  await clock.settle()
  expect(calls.toasts).toContain('O Modo Jarvis foi encerrado.')
})

test('helper that never says ready is stopped after 30 s', async ($, on) => {
  const clock = mock.clock(on)
  const calls = world(on, { chunks: [] })
  const ran = $.command.run(RUN)
  await clock.settle()
  await clock.advance(30001)
  expect(calls.toasts).toContain('O Modo Jarvis não abriu a tempo.')
  expect(calls.cmds).toContainEqual({ type: 'quit' })
  calls.release()
  await ran
})

test('second toggle turns off and asks the helper to quit', async ($, on) => {
  const clock = mock.clock(on)
  const calls = world(on)
  const first = $.command.run(RUN)
  await clock.settle()
  await $.command.run(RUN)
  await clock.settle()
  expect(calls.cmds).toContainEqual({ type: 'quit' })
  expect(calls.status.at(-1)).toBeUndefined()
  calls.release()
  await first
})

test('turning off waits for the helper to exit', async ($, on) => {
  const clock = mock.clock(on)
  const calls = world(on)
  const first = $.command.run(RUN)
  await clock.settle()
  await $.command.run(RUN)
  calls.order.push('off-done')
  expect(calls.order).toEqual(['exited', 'off-done'])
  await first
})

test('after a module reload the band shows off', async () => {
  expect(shownMode('on', false)).toBe('off')
  expect(shownMode('starting', false)).toBe('off')
  expect(shownMode('on', true)).toBe('on')
  expect(shownMode('starting', true)).toBe('starting')
  expect(shownMode('off', true)).toBe('off')
})

test('the helper gets 30 s to say ready', async ($, on) => {
  const clock = mock.clock(on)
  const calls = world(on, { chunks: [] })
  const ran = $.command.run(RUN)
  await clock.settle()
  await clock.advance(20000)
  expect(calls.toasts).toEqual([])
  await clock.advance(10001)
  expect(calls.toasts).toContain('O Modo Jarvis não abriu a tempo.')
  await ran
})
