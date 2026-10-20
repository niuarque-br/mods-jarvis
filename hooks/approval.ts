const COMMAND_LIMIT = 60
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const SAYABLE = /^[\w .\/:=@+,-]+$/
const RISKY = /(^|\s)(rm|rmdir|del|rd|erase|format|shutdown|reboot|kill|taskkill|mkfs|dd|remove-item)(\s|$)|--force|--hard|(^|\s)-[a-z]*f[a-z]*(\s|$)/i

function field(input: unknown, name: string): string {
  if (!input || typeof input !== 'object') return ''
  const value = (input as Record<string, unknown>)[name]
  return typeof value === 'string' ? value : ''
}

function segments(path: string): string[] | null {
  const out: string[] = []
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!out.length) return null
      out.pop()
    } else {
      out.push(part)
    }
  }
  return out
}

function insideCwd(path: string, cwd: string): string | null {
  const file = segments(path)
  const root = segments(cwd)
  if (!file || !root || !root.length || file.length <= root.length) return null
  const same = root.every((part, i) => part.toLowerCase() === (file[i] ?? '').toLowerCase())
  return same ? file.slice(root.length).join('/') : null
}

export function approvalQuestion(toolName: string, toolInput: unknown, cwd: string): string | null {
  if (SHELL_TOOLS.has(toolName)) {
    const command = field(toolInput, 'command').trim()
    if (!command || command.length > COMMAND_LIMIT || !SAYABLE.test(command) || RISKY.test(command)) return null
    return `Posso rodar um comando: ${command}?`
  }
  if (EDIT_TOOLS.has(toolName)) {
    const relative = insideCwd(field(toolInput, 'file_path') || field(toolInput, 'notebook_path'), cwd)
    return relative ? `Posso editar ${relative}?` : null
  }
  return null
}
