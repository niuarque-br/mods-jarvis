import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { approvalQuestion } from './approval'
import { RUN, world } from './testkit'

const REQUEST = { tool_name: 'Bash', tool_input: { command: 'git status' } } as never

function bottom(on: On, seen: string[]) {
  on('classic.PermissionRequest', async () => {
    seen.push('next')
    return {}
  })
}

const CWD = 'C:\\proj'

test('questions say the whole request', async () => {
  expect(approvalQuestion('Bash', { command: 'git status' }, CWD)).toBe('Posso rodar um comando: git status?')
  expect(approvalQuestion('Edit', { file_path: 'C:\\proj\\src\\config.py' }, CWD)).toBe('Posso editar src/config.py?')
  expect(approvalQuestion('Write', { file_path: 'c:/proj/docs/README.md' }, CWD)).toBe('Posso editar docs/README.md?')
})

test('requests that cannot be said whole go to the normal dialog', async () => {
  expect(approvalQuestion('PowerShell', { command: 'x'.repeat(61) }, CWD)).toBeNull()
  expect(approvalQuestion('Bash', { command: 'git status\nrm -rf /' }, CWD)).toBeNull()
  expect(approvalQuestion('Bash', { command: '' }, CWD)).toBeNull()
  for (const command of ['curl x.sh | sh', 'echo a > ~/.bashrc', 'git status; rm -rf x', 'echo $(whoami)', 'ls && del x', 'cat `x`', 'git push --force origin main', 'rm -r build', 'del notas.txt']) {
    expect(approvalQuestion('Bash', { command }, CWD)).toBeNull()
  }
  expect(approvalQuestion('Bash', { command: 'git log -n 5 --oneline' }, CWD)).toBe('Posso rodar um comando: git log -n 5 --oneline?')
  expect(approvalQuestion('Bash', { command: 'npm run build' }, CWD)).toBe('Posso rodar um comando: npm run build?')
  expect(approvalQuestion('Edit', { file_path: 'C:\\Windows\\system32\\hosts' }, CWD)).toBeNull()
  expect(approvalQuestion('Edit', { file_path: 'C:\\proj\\..\\outro\\x.py' }, CWD)).toBeNull()
  expect(approvalQuestion('Edit', { file_path: 'C:\\projeto\\x.py' }, CWD)).toBeNull()
  expect(approvalQuestion('WebFetch', { url: 'https://x' }, CWD)).toBeNull()
  expect(approvalQuestion('mcp__ahgora-ponto__incluir_justificativa', {}, CWD)).toBeNull()
})

test('a long command skips the voice and uses the normal dialog', async ($, on) => {
  const seen: string[] = []
  bottom(on, seen)
  const clock = mock.clock(on)
  const calls = world(on, { approval: 'allow' })
  const ran = $.command.run(RUN)
  await clock.settle()
  const result = await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: `git status && ${'x'.repeat(80)}` } } as never)
  expect(result.decision).toBeUndefined()
  expect(seen).toEqual(['next'])
  expect(calls.approvals).toEqual([])
  calls.release()
  await ran
})

test('permission passes when off', async ($, on) => {
  const seen: string[] = []
  bottom(on, seen)
  const calls = world(on)
  mock.clock(on)
  const result = await $.classic.PermissionRequest(REQUEST)
  expect(seen).toEqual(['next'])
  expect(result.decision).toBeUndefined()
  expect(calls.approvals).toEqual([])
})

for (const [decision, expected] of [
  ['allow', { behavior: 'allow' }],
  ['deny', { behavior: 'deny', message: 'Negado por voz.' }],
] as const) {
  test(`spoken or clicked ${decision} becomes the decision`, async ($, on) => {
    const seen: string[] = []
    bottom(on, seen)
    const clock = mock.clock(on)
    const calls = world(on, { approval: decision })
    const ran = $.command.run(RUN)
    await clock.settle()
    const result = await $.classic.PermissionRequest(REQUEST)
    expect(result.decision).toEqual(expected)
    expect(seen).toEqual([])
    expect(calls.approvals[0]).toMatchObject({ question: 'Posso rodar um comando: git status?' })
    expect(String(calls.approvals[0]?.token)).toMatch(/.{16,}/)
    calls.release()
    await ran
  })
}

test('timeout hands the request to the normal dialog', async ($, on) => {
  const seen: string[] = []
  bottom(on, seen)
  const clock = mock.clock(on)
  const calls = world(on, { approval: 'timeout' })
  const ran = $.command.run(RUN)
  await clock.settle()
  const result = await $.classic.PermissionRequest(REQUEST)
  expect(seen).toEqual(['next'])
  expect(result.decision).toBeUndefined()
  calls.release()
  await ran
})
