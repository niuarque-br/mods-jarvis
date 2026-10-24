import { expect, test } from 'claude-code/testing'

import { PHRASES, SentenceStream, Variety, chunkSentences, speakable, toolAck } from './speakable'

test('code block becomes a note', async () => {
  expect(speakable('```py\nx=1\n```')).toBe('Deixei um trecho de código na tela.')
})

test('long paths keep only the file name', async () => {
  expect(speakable('Veja `src/a/b/config.py`.')).toBe('Veja config.py.')
  expect(speakable('Abra C:\\proj\\hooks\\register.tsx agora')).toBe('Abra register.tsx agora.')
})

test('table becomes one note', async () => {
  expect(speakable('| a | b |\n|---|---|\n| 1 | 2 |')).toBe('Mostrei uma tabela na tela.')
})

test('json reply becomes a note', async () => {
  expect(speakable('{"a": 1}')).toBe('Mostrei os dados na tela.')
})

test('markdown marks, links and urls', async () => {
  expect(speakable('## Pronto\n- **feito** em [docs](http://x.y)\n- veja https://a.b/c')).toBe('Pronto. feito em docs. veja o link na tela.')
})

test('chunks: first has one sentence, then two up to 300 chars', async () => {
  expect(chunkSentences('Um. Dois. Três. Quatro.')).toEqual(['Um.', 'Dois. Três.', 'Quatro.'])
})

test('stream emits the first sentence at once and pairs after', async () => {
  const s = new SentenceStream()
  expect(s.push('Oi. Tudo bem? Sim.')).toEqual(['Oi.'])
  expect(s.finish()).toEqual({ chunks: ['Tudo bem? Sim.'], rest: '' })
})

test('stream pairs later sentences', async () => {
  const s = new SentenceStream()
  expect(s.push('Um. Dois. Três. Quatro. ')).toEqual(['Um.', 'Dois. Três.'])
  expect(s.finish().chunks).toEqual(['Quatro.'])
})

test('open code fence is held', async () => {
  const s = new SentenceStream()
  expect(s.push('Veja:\n```\nrm -rf')).toEqual(['Veja:'])
  expect(s.push(' /tmp\n')).toEqual([])
  expect(s.push('```\nPronto. ')).toEqual(['Deixei um trecho de código na tela. Pronto.'])
})

test('table rows are held until the line ends', async () => {
  const s = new SentenceStream()
  expect(s.push('Resultado:\n| a. b | c')).toEqual(['Resultado:'])
  expect(s.push(' |\n|---|\nFim. ')).toEqual(['Mostrei uma tabela na tela. Fim.'])
})

test('flushBlock speaks a narration without final punctuation', async () => {
  const s = new SentenceStream()
  expect(s.push('Vou olhar o arquivo')).toEqual([])
  expect(s.flushBlock()).toEqual(['Vou olhar o arquivo.'])
})

test('text past the limit goes to rest', async () => {
  const s = new SentenceStream(40)
  const spoken = s.push('Primeira frase curta. Segunda frase também curta. Terceira frase que sobra. Quarta. ')
  expect(spoken).toEqual(['Primeira frase curta.', 'Segunda frase também curta. Terceira frase que sobra.'])
  const done = s.finish()
  expect(done.chunks).toEqual([])
  expect(done.rest).toBe('Quarta.')
})

test('rest only keeps the last block', async () => {
  const s = new SentenceStream(10)
  s.push('Bloco um que é longo. Sobra um. ')
  s.flushBlock()
  s.push('Bloco dois longo também. Sobra dois. ')
  expect(s.finish().rest).toBe('Sobra dois.')
})

test('tool acknowledgements', async () => {
  expect(toolAck('Bash')).toBe('Vou rodar um comando.')
  expect(toolAck('PowerShell')).toBe('Vou rodar um comando.')
  expect(toolAck('Read')).toBe('Vou olhar os arquivos.')
  expect(toolAck('Grep')).toBe('Vou olhar os arquivos.')
  expect(toolAck('Edit')).toBe('Vou editar o arquivo.')
  expect(toolAck('WebSearch')).toBe('Vou pesquisar.')
  expect(toolAck('Agent')).toBe('Vou delegar uma parte.')
  expect(toolAck('mcp__ahgora-ponto__carregar_batidas')).toBe('Vou consultar ahgora-ponto.')
  expect(toolAck('TodoWrite')).toBe('Um momento.')
})

test('toolAck de comando inclui a descrição', () => {
  expect(toolAck('Bash', 'Show working tree status')).toBe('Vou rodar um comando: show working tree status.')
  expect(toolAck('PowerShell', 'Lista os arquivos.')).toBe('Vou rodar um comando: lista os arquivos.')
  expect(toolAck('Bash', '   ')).toBe('Vou rodar um comando.')
  expect(toolAck('Bash', 'x'.repeat(81))).toBe('Vou rodar um comando.')
  expect(toolAck('Read', 'Lê o arquivo')).toBe('Vou olhar os arquivos.')
})

test('toolAck do viewer: Vou desenhar.', () => {
  expect(toolAck('mcp__jarvis-viewer__mostrar_cena')).toBe('Vou desenhar.')
  expect(toolAck('mcp__jarvis-viewer__outra')).toBe('Vou consultar jarvis-viewer.')
})

test('Variety nunca repete a última frase do mesmo tipo', () => {
  const variety = new Variety()
  let last = ''
  for (let i = 0; i < 50; i++) {
    const said = variety.pick('command')
    expect(PHRASES.command as readonly string[]).toContain(said)
    expect(said).not.toBe(last)
    last = said
  }
})

test('Variety sorteia com a fonte dada e preenche {x}', () => {
  const variety = new Variety(() => 0.99)
  expect(variety.pick('mcp', 'ahgora-ponto')).toBe('Vou buscar em ahgora-ponto.')
  expect(variety.pick('mcp', 'ahgora-ponto')).toBe('Consultando ahgora-ponto.')
  expect(toolAck('Bash', 'Lista os arquivos', variety.pick)).toBe('Próximo comando: lista os arquivos.')
})

test('toda frase de aviso termina em pontuação', () => {
  for (const phrases of Object.values(PHRASES)) for (const phrase of phrases) {
    if (phrase.endsWith('{x}')) continue
    expect(/[.!?]$/.test(phrase)).toBe(true)
  }
})
