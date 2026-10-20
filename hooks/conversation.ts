const ACK_SILENCE_MS = 4000
const ACK_GAP_MS = 15000
const WAIT_SILENCE_MS = 12000
const WAIT_GAP_MS = 30000

export type ShownMode = 'off' | 'starting' | 'on'

export function shownMode(stored: ShownMode, hasHelper: boolean): ShownMode {
  return hasHelper ? stored : 'off'
}

export class Conversation {
  turnId: string | null = null
  approvalPending = false
  stopped = false
  private queue: string[] = []
  private lastSpokeAt = Number.NEGATIVE_INFINITY
  private lastAckAt = Number.NEGATIVE_INFINITY
  private lastWaitAt = Number.NEGATIVE_INFINITY

  utterance(text: string): { submit?: string; caption?: string } {
    if (this.turnId === null) return { submit: text }
    this.queue.push(text)
    return { caption: `guardei: ${text}` }
  }

  turnStarted(turnId: string, now: number) {
    this.turnId = turnId
    this.stopped = false
    this.lastSpokeAt = now
    this.lastWaitAt = Number.NEGATIVE_INFINITY
  }

  turnEnded(): string | undefined {
    this.turnId = null
    if (!this.queue.length) return undefined
    const next = this.queue.join(' ')
    this.queue = []
    return next
  }

  stop(): { abort?: string } {
    this.queue = []
    if (this.turnId === null) return {}
    const abort = this.turnId
    this.stopped = true
    this.turnId = null
    return { abort }
  }

  spoke(now: number) {
    this.lastSpokeAt = now
  }

  shouldAck(now: number): boolean {
    if (now - this.lastSpokeAt < ACK_SILENCE_MS || now - this.lastAckAt < ACK_GAP_MS) return false
    this.lastAckAt = now
    return true
  }

  shouldWarn(now: number): boolean {
    if (this.turnId === null || this.approvalPending) return false
    if (now - this.lastSpokeAt < WAIT_SILENCE_MS || now - this.lastWaitAt < WAIT_GAP_MS) return false
    this.lastWaitAt = now
    return true
  }
}
