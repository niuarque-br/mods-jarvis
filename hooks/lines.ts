export class LineSplitter {
  private rest = ''

  push(text: string): unknown[] {
    const parts = (this.rest + text).split('\n')
    this.rest = parts.pop() ?? ''
    const out: unknown[] = []
    for (const part of parts) {
      const line = part.trim()
      if (!line) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        continue
      }
    }
    return out
  }
}
