import type { On, RenderElement } from 'claude-code'

export const READY = '{"type":"ready","port":47811}\n'
export const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 9 },
  view: {},
}
export const RUN = { command: 'conversa', args: '', origin: { kind: 'user' } as never, presentation: 'inline' as never }

export type World = {
  spawned: { argv: readonly string[]; cwd?: string; env?: Record<string, string> }[]
  toasts: string[]
  status: (string | undefined)[]
  cmds: Record<string, unknown>[]
  approvals: Record<string, unknown>[]
  submitted: string[]
  origins: unknown[]
  aborted: string[]
  order: string[]
  release: () => void
  emit: (line: Record<string, unknown>) => void
}

export type WorldOptions = { busy?: boolean; exe?: boolean; chunks?: string[]; ends?: boolean; approval?: string }

export function world(on: On, opts: WorldOptions = {}): World {
  let open = () => {}
  const gate = new Promise<void>(resolve => {
    open = resolve
  })
  const lines: string[] = []
  let wake = () => {}
  const calls: World = {
    spawned: [],
    toasts: [],
    status: [],
    cmds: [],
    approvals: [],
    submitted: [],
    origins: [],
    aborted: [],
    order: [],
    release: () => {
      open()
      wake()
    },
    emit: line => {
      lines.push(`${JSON.stringify(line)}\n`)
      wake()
    },
  }
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, null, '⚙ Config Mods') as RenderElement
  })
  on('fs.exists', async () => ({ value: !!opts.exe }))
  on('http.fetch', async ($, e) => {
    if (e.url.endsWith('/ping')) {
      if (opts.busy) return { value: { status: 200, ok: true, headers: {}, text: '{"app":"modo-conversa","busy":true}' } }
      return { deny: 'connection refused' }
    }
    if (e.url.endsWith('/approval/wait')) {
      calls.approvals.push({ ...JSON.parse(String(e.init?.body ?? '{}')), token: e.init?.headers?.['X-Conversa-Token'] })
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ decision: opts.approval ?? 'timeout' }) } }
    }
    const cmd = JSON.parse(String(e.init?.body ?? '{}'))
    calls.cmds.push(cmd)
    if (cmd.type === 'quit') calls.release()
    return { value: { status: 204, ok: true, headers: {}, text: '' } }
  })
  on('process.spawn', async function* ($, e) {
    calls.spawned.push({ argv: e.argv, cwd: e.cwd, env: e.env })
    for (const text of opts.chunks ?? [READY]) yield { stream: 'stdout' as const, text }
    if (opts.ends) return { value: { code: 0, signal: null } }
    let done = false
    void gate.then(() => {
      done = true
    })
    while (!done) {
      while (lines.length) yield { stream: 'stdout' as const, text: lines.shift() ?? '' }
      if (done) break
      await new Promise<void>(resolve => {
        wake = resolve
      })
    }
    calls.order.push('exited')
    return { value: { code: 0, signal: null } }
  })
  on('ui.toast', async ($, e) => {
    calls.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', async ($, e) => {
    calls.status.push(e.text)
    return { value: undefined }
  })
  on('command.register', async ($, e) => ({ value: { command: e.name } }))
  on('prompt.submit', async ($, e) => {
    calls.submitted.push(e.text)
    calls.origins.push(e.origin)
    return { text: e.text }
  })
  on('turn.abort', async ($, e) => {
    calls.aborted.push(e.turnId)
    return { value: undefined }
  })
  return calls
}

export function spoken(calls: World): string[] {
  return calls.cmds.filter(c => c.type === 'speak').flatMap(c => c.chunks as string[])
}
