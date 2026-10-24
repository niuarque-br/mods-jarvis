export const CODE_NOTE = 'Deixei um trecho de código na tela.'
export const TABLE_NOTE = 'Mostrei uma tabela na tela.'
export const DATA_NOTE = 'Mostrei os dados na tela.'

const END = '.!?…:;,'
const SENTENCE = /(?<=[.!?…])\s+/
const LINK = /\[([^\]]+)\]\([^)]*\)/g
const URL_RE = /https?:\/\/\S+/g
const PATH = /(?:[A-Za-z]:[\\/])?(?:[\w.-]+[\\/])+([\w-]+(?:\.[\w-]+)+)/g
const MARKS = /(\*\*|\*|`|~~)/g
const UNDERSCORE = /(?<!\w)_{1,2}([^_\n]+?)_{1,2}(?!\w)/g
const BULLET = /^(?:[-*+]|\d+[.)])\s+/
const HEADING = /^#{1,6}\s*/
const QUOTE = /^>\s?/
const MAX_CHARS = 300

function isJson(text: string): boolean {
  const stripped = text.trim()
  if (!stripped || !'{['.includes(stripped[0] ?? '')) return false
  try {
    JSON.parse(stripped)
    return true
  } catch {
    return false
  }
}

function cleanInline(text: string, atLineStart: boolean): string {
  let line = text.trim()
  if (atLineStart) line = line.replace(HEADING, '').replace(QUOTE, '').replace(BULLET, '')
  return line
    .replace(LINK, '$1')
    .replace(URL_RE, 'o link na tela')
    .replace(PATH, '$1')
    .replace(MARKS, '')
    .replace(UNDERSCORE, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function finishLine(text: string): string {
  if (!text) return ''
  return END.includes(text[text.length - 1] ?? '') ? text : `${text}.`
}

function splitSentences(text: string): string[] {
  const out: string[] = []
  for (const piece of text.split(SENTENCE)) {
    let sentence = piece.trim()
    while (sentence.length > MAX_CHARS) {
      let cut = sentence.lastIndexOf(' ', MAX_CHARS)
      if (cut <= 0) cut = MAX_CHARS
      out.push(sentence.slice(0, cut).trim())
      sentence = sentence.slice(cut).trim()
    }
    if (sentence) out.push(sentence)
  }
  return out
}

class LineReader {
  fence = false
  table = false

  line(raw: string, atLineStart = true): string[] {
    const line = raw.trim()
    if (atLineStart && line.startsWith('```')) {
      this.fence = !this.fence
      this.table = false
      return this.fence ? [CODE_NOTE] : []
    }
    if (this.fence) return []
    if (atLineStart && line.startsWith('|')) {
      if (this.table) return []
      this.table = true
      return [TABLE_NOTE]
    }
    this.table = false
    return splitSentences(finishLine(cleanInline(line, atLineStart)))
  }

  prefix(raw: string, atLineStart: boolean): string[] {
    if (this.fence) return []
    this.table = false
    return splitSentences(cleanInline(raw, atLineStart))
  }
}

export function speakable(markdown: string): string {
  const source = markdown || ''
  if (isJson(source)) return DATA_NOTE
  const reader = new LineReader()
  const parts = source.split(/\r?\n/).flatMap(line => reader.line(line))
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

export function chunkSentences(text: string, perChunk = 2, firstPerChunk = 1): string[] {
  const chunks: string[] = []
  let current = ''
  let count = 0
  for (const sentence of splitSentences(text)) {
    const joined = `${current} ${sentence}`.trim()
    const limit = chunks.length ? perChunk : firstPerChunk
    if (current && (count >= limit || joined.length > MAX_CHARS)) {
      chunks.push(current)
      current = sentence
      count = 1
    } else {
      current = joined
      count += 1
    }
  }
  if (current) chunks.push(current)
  return chunks
}

export class SentenceStream {
  private reader = new LineReader()
  private buffer = ''
  private linePartial = false
  private pending: string[] = []
  private emitted = 0
  private spoken = 0
  private rest: string[] = []
  private blockDone = false

  constructor(private readonly limit = 350) {}

  push(text: string): string[] {
    if (this.blockDone) this.startBlock()
    this.buffer += text
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      this.pending.push(...this.reader.line(line, !this.linePartial))
      this.linePartial = false
      newline = this.buffer.indexOf('\n')
    }
    this.takePrefix()
    return this.drain(false)
  }

  flushBlock(): string[] {
    if (this.buffer.trim() && !this.reader.fence) this.pending.push(...this.reader.line(this.buffer, !this.linePartial))
    this.buffer = ''
    this.linePartial = false
    this.reader.fence = false
    this.reader.table = false
    const chunks = this.drain(true)
    this.blockDone = true
    return chunks
  }

  finish(): { chunks: string[]; rest: string } {
    const chunks = this.flushBlock()
    return { chunks, rest: this.rest.join(' ').trim() }
  }

  private startBlock() {
    this.blockDone = false
    this.emitted = 0
    this.spoken = 0
    this.rest = []
  }

  private takePrefix() {
    if (this.reader.fence || !this.buffer) return
    const head = this.buffer.trimStart()
    if (!this.linePartial && /^[|`{[#]/.test(head)) return
    let end = -1
    for (const match of this.buffer.matchAll(/[.!?…]\s+/g)) end = (match.index ?? 0) + match[0].length
    if (end <= 0) return
    const prefix = this.buffer.slice(0, end)
    this.buffer = this.buffer.slice(end)
    this.pending.push(...this.reader.prefix(prefix, !this.linePartial))
    this.linePartial = true
  }

  private drain(all: boolean): string[] {
    const chunks: string[] = []
    while (this.pending.length) {
      if (this.spoken >= this.limit) {
        this.rest.push(...this.pending.splice(0))
        break
      }
      const first = this.pending[0] ?? ''
      if (this.emitted === 0) {
        this.emit(chunks, this.pending.splice(0, 1))
        continue
      }
      const second = this.pending[1]
      if (second === undefined) {
        if (all) this.emit(chunks, this.pending.splice(0, 1))
        break
      }
      const pair = `${first} ${second}`
      this.emit(chunks, this.pending.splice(0, pair.length > MAX_CHARS ? 1 : 2))
    }
    return chunks
  }

  private emit(chunks: string[], sentences: string[]) {
    const chunk = sentences.join(' ').trim()
    if (!chunk) return
    chunks.push(chunk)
    this.emitted += 1
    this.spoken += chunk.length
  }
}

/**
 * The collections each spoken notice draws from, the first phrase of each the plain one.
 * `{x}` is filled in: a command's description, an MCP server's name.
 */
export const PHRASES = {
  command: ['Vou rodar um comando.', 'Rodando um comando.', 'Deixa eu rodar um comando.', 'Vou executar uma coisa aqui.'],
  describedCommand: ['Vou rodar um comando: {x}.', 'Rodando um comando: {x}.', 'Agora um comando: {x}.', 'Próximo comando: {x}.'],
  files: ['Vou olhar os arquivos.', 'Deixa eu dar uma olhada no código.', 'Vou ler uns arquivos.', 'Vou procurar no projeto.'],
  edit: ['Vou editar o arquivo.', 'Vou fazer a alteração.', 'Mexendo no arquivo.', 'Vou ajustar o código.'],
  search: ['Vou pesquisar.', 'Vou procurar na web.', 'Deixa eu pesquisar isso.'],
  agent: ['Vou delegar uma parte.', 'Vou passar uma parte para um ajudante.', 'Vou dividir o trabalho.'],
  scene: ['Vou desenhar.', 'Vou montar a cena.', 'Deixa eu desenhar isso.'],
  mcp: ['Vou consultar {x}.', 'Consultando {x}.', 'Vou buscar em {x}.'],
  other: ['Um momento.', 'Só um instante.', 'Um segundo.', 'Já volto.'],
  wait: ['Ainda estou nisso.', 'Continuo trabalhando.', 'Sigo nisso, mais um pouco.', 'Ainda trabalhando aqui.'],
  error: ['Tive um problema ao processar.', 'Algo deu errado aqui.', 'Não consegui terminar, tive um problema.'],
  screen: ['O detalhe está na tela.', 'Deixei os detalhes na tela.', 'O resto está na tela.'],
  summary: ['Resumindo: {x}', 'Em resumo: {x}', 'Em poucas palavras: {x}'],
} as const

export type PhraseKind = keyof typeof PHRASES
export type Pick = (kind: PhraseKind, fill?: string) => string

/** The plain phrase of each kind, what a caller without a `Variety` says. */
export const plain: Pick = (kind, fill = '') => PHRASES[kind][0].replace('{x}', fill)

/** Draws each notice at random from its collection, never repeating the last one said for that kind. */
export class Variety {
  private last = new Map<PhraseKind, number>()

  constructor(private random: () => number = Math.random) {}

  pick: Pick = (kind, fill = '') => {
    const phrases = PHRASES[kind]
    const previous = this.last.get(kind)
    const choices = previous === undefined ? phrases.length : phrases.length - 1
    let index = Math.min(choices - 1, Math.floor(this.random() * choices))
    if (previous !== undefined && index >= previous) index += 1
    this.last.set(kind, index)
    return phrases[index]!.replace('{x}', fill)
  }
}

const TOOL_KINDS: Record<string, PhraseKind> = {
  Bash: 'command',
  PowerShell: 'command',
  Read: 'files',
  Grep: 'files',
  Glob: 'files',
  Edit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  WebSearch: 'search',
  WebFetch: 'search',
  Agent: 'agent',
  Task: 'agent',
  'mcp__jarvis-viewer__mostrar_cena': 'scene',
}

const DESCRIPTION_LIMIT = 80

function sayableDescription(description: unknown): string | null {
  if (typeof description !== 'string') return null
  const text = description.replace(/\s+/g, ' ').trim().replace(/[.!?;:,]+$/, '')
  if (!text || text.length > DESCRIPTION_LIMIT) return null
  return `${text.charAt(0).toLowerCase()}${text.slice(1)}`
}

export function toolAck(tool: string, description?: unknown, pick: Pick = plain): string {
  const kind = TOOL_KINDS[tool]
  if (kind === 'command') {
    const described = sayableDescription(description)
    return described ? pick('describedCommand', described) : pick('command')
  }
  if (kind) return pick(kind)
  const mcp = /^mcp__(.+?)__/.exec(tool)
  if (mcp) return pick('mcp', mcp[1])
  return pick('other')
}
