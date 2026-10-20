export function normWords(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function isEcho(partial, spoken) {
  const words = normWords(partial);
  if (!words.length) return true;
  const pool = new Set(normWords(spoken));
  if (!pool.size) return false;
  const hits = words.filter(w => pool.has(w)).length;
  return hits / words.length >= 0.6;
}

const STOPS = new Set(["pare", "chega"]);
const STOP_FILLER = new Set(["claude", "por", "favor", "ok", "ei", "e", "agora", "de", "falar", "a", "boca"]);

export function isStopCommand(text, spoken) {
  const words = normWords(text);
  if (!words.length || words.length > 4) return false;
  if (words.some(w => !STOPS.has(w) && !STOP_FILLER.has(w))) return false;
  const pool = new Set(normWords(spoken));
  return words.some(w => STOPS.has(w) && !pool.has(w));
}

export function isDuplicateStop(now, lastStopAt) {
  return lastStopAt > 0 && now - lastStopAt < 4000;
}

export function stopInPartial(text, latest, spoken) {
  const words = normWords(text);
  const tails = [words.slice(-1).join(" "), words.slice(-2).join(" ")];
  return [latest, text, ...tails].some(candidate => candidate && isStopCommand(candidate, spoken));
}

export function isLateEcho(message, echoText, now, echoUntil) {
  return now < echoUntil && isEcho(message, echoText);
}

export function medianOf(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function isNearVoice(level, own, proximity) {
  if (!proximity || own.length < 3) return true;
  return level >= medianOf(own) * proximity / 100;
}

export function learnLevel(own, level) {
  return own.concat([level]).slice(-12);
}

export class LevelWindow {
  constructor(spanMs) {
    this.spanMs = spanMs;
    this.samples = [];
    this.since = Number.NEGATIVE_INFINITY;
  }

  add(now, level) {
    this.samples.push([now, level]);
    while (this.samples.length && this.samples[0][0] < now - this.spanMs) this.samples.shift();
  }

  reset(now) {
    this.since = now;
    this.samples = [];
  }

  peak(now) {
    const from = Math.max(this.since, now - this.spanMs);
    return this.samples.reduce((top, [t, level]) => (t >= from && level > top ? level : top), 0);
  }
}

export function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const tag = (offset, text) => { for (let i = 0; i < 4; i++) v.setUint8(offset + i, text.charCodeAt(i)); };
  tag(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, Math.round(s < 0 ? s * 32768 : s * 32767), true);
  }
  return buf;
}

const DENIES = new Set(["pare", "chega", "cancela", "cancelar"]);
const CONSENT = new Set(["sim", "nao", "pode", "autorizo", "confirmo", "manda", "ver", "cancela", "cancelar"]);

export function approvalDecision(message, question, pumping) {
  const words = normWords(message);
  if (!words.length) return "other";
  if (isStopCommand(message, "") || (words.length <= 3 && words.every(w => DENIES.has(w) || w === "claude" || w === "por" || w === "favor"))) return "deny";
  if (!words.some(w => CONSENT.has(w))) return "other";
  const pool = normWords(question).filter(w => !CONSENT.has(w)).join(" ");
  if (isEcho(message, pool)) return "other";
  return pumping ? "ignore" : "answer";
}

export class Failures {
  constructor(limit) {
    this.limit = limit;
    this.count = 0;
  }

  fail() {
    this.count += 1;
    return this.count >= this.limit;
  }

  ok() {
    this.count = 0;
  }
}

// Decide quais ids de blocos falados se resolvem e como.
// pending: ids (string|null) ainda não resolvidos. event: {type:'done', id} ou {type:'stop'}.
export function settle(pending, event) {
  if (event.type === "done") {
    const at = event.id ? pending.indexOf(event.id) : -1;
    if (at < 0) return { spoken: [], pending: pending.slice() };
    return {
      spoken: [{ type: "spoken", id: event.id, outcome: "done" }],
      pending: pending.filter((_, i) => i !== at),
    };
  }
  return {
    spoken: pending.filter(Boolean).map((id) => ({ type: "spoken", id, outcome: "stopped" })),
    pending: [],
  };
}

// Separa blocos em branco dos falaveis, sem perder a ordem dos ids.
// lead[i]: ids de blocos em branco logo antes do bloco falavel i; tail: ids em branco depois do ultimo.
export function planChunks(chunks, ids) {
  const plan = { chunks: [], ids: [], lead: [], tail: [] };
  let blanks = [];
  chunks.forEach((c, i) => {
    const id = (ids && ids[i]) || null;
    if (String(c || "").trim()) {
      plan.chunks.push(c);
      plan.ids.push(id);
      plan.lead.push(blanks);
      blanks = [];
    } else if (id) blanks.push(id);
  });
  plan.tail = blanks;
  return plan;
}
