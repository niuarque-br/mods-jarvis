import {
  normWords, isEcho, isStopCommand, isDuplicateStop, stopInPartial, isLateEcho,
  medianOf, isNearVoice, learnLevel, encodeWav, approvalDecision, Failures, LevelWindow,
} from "/static/voicecore.js";

const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.search).get("t") || "";
const stage = $("stage"), caption = $("caption"), questionBox = $("question");
const allowBtn = $("allow"), denyBtn = $("deny"), stopBtn = $("stop");

const voice = {
  active: false, state: "off", cfg: null, busy: false,
  ctx: null, stream: null, micAnalyser: null, ttsAnalyser: null, audio: null, buf: null, loopback: null,
  recognizer: null, spoken: "", playId: 0, endPlay: null, synthetic: false,
  approval: null, pumping: false, userPartial: false, warnedFallback: false,
  ownLevels: [], levels: null, levelTimer: 0, stopDetector: null, stopDetectorOff: false, lastStopAt: 0,
  echoText: "", echoUntil: 0, replyQueue: [], events: null,
};

function headers(json = true) {
  const h = { "X-Conversa-Token": token };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

function post(path, body) {
  return fetch(path, { method: "POST", headers: headers(), body: JSON.stringify(body) });
}

function sendEvent(body) {
  return post("/event", body).catch(() => {});
}

function micLevel(analyser, buf) {
  analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / buf.length);
}

async function toWav16k(blob) {
  const decoded = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(await blob.arrayBuffer());
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * 16000)), 16000);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return new Blob([encodeWav(rendered.getChannelData(0), 16000)], { type: "audio/wav" });
}

function tuneOpus(sdp) {
  const match = /a=rtpmap:(\d+) opus\/48000/i.exec(sdp);
  if (!match) return sdp;
  const fmtp = new RegExp(`(a=fmtp:${match[1]} )([^\\r\\n]*)`);
  return sdp.replace(fmtp, (all, head, params) =>
    /maxaveragebitrate/.test(params) ? all : `${head}${params};maxaveragebitrate=128000;stereo=0;sprop-stereo=0`);
}

async function createLoopback(stream, timeoutMs = 3000) {
  const sender = new RTCPeerConnection();
  const receiver = new RTCPeerConnection();
  const close = () => { sender.close(); receiver.close(); };
  try {
    sender.onicecandidate = (e) => { if (e.candidate) receiver.addIceCandidate(e.candidate).catch(() => {}); };
    receiver.onicecandidate = (e) => { if (e.candidate) sender.addIceCandidate(e.candidate).catch(() => {}); };
    const remote = new Promise((resolve) => {
      receiver.ontrack = (e) => resolve(e.streams[0] || new MediaStream([e.track]));
    });
    stream.getAudioTracks().forEach((track) => sender.addTrack(track, stream));
    const offer = await sender.createOffer();
    await sender.setLocalDescription(offer);
    await receiver.setRemoteDescription({ type: "offer", sdp: tuneOpus(offer.sdp) });
    const answer = await receiver.createAnswer();
    const tuned = { type: "answer", sdp: tuneOpus(answer.sdp) };
    await receiver.setLocalDescription(tuned);
    await sender.setRemoteDescription(tuned);
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("canal de chamada não conectou")), timeoutMs));
    const output = await Promise.race([remote, timeout]);
    const connected = new Promise((resolve, reject) => {
      const check = () => {
        if (receiver.connectionState === "connected") resolve();
        else if (["failed", "closed"].includes(receiver.connectionState)) reject(new Error("canal de chamada falhou"));
      };
      receiver.onconnectionstatechange = check;
      check();
    });
    await Promise.race([connected, timeout]);
    const player = new Audio();
    player.srcObject = output;
    await player.play();
    return { close() { player.pause(); player.srcObject = null; close(); } };
  } catch (err) {
    close();
    throw err;
  }
}

function createOrb(canvas, fallback, levelFn) {
  const orb = { state: "off", level: 0, raf: 0, running: false, impl: null };
  canvas.hidden = true;
  fallback.hidden = false;

  function frame(now) {
    const target = Math.max(0, Math.min(1, levelFn(now) || 0));
    orb.level += (target - orb.level) * 0.18;
    fallback.dataset.state = orb.state;
    fallback.style.transform = `scale(${1 + orb.level * 0.35})`;
    orb.raf = requestAnimationFrame(frame);
  }

  import("/static/orb.js")
    .then((mod) => {
      orb.impl = mod.createParticleOrb(canvas, levelFn);
      orb.impl.setState(orb.state);
      canvas.hidden = false;
      fallback.hidden = true;
      if (orb.running) {
        cancelAnimationFrame(orb.raf);
        orb.raf = 0;
        orb.impl.start();
      }
    })
    .catch((err) => console.warn("orbe 3D indisponível:", err));

  return {
    start() {
      orb.running = true;
      if (orb.impl) orb.impl.start();
      else if (!orb.raf) orb.raf = requestAnimationFrame(frame);
    },
    stop() {
      orb.running = false;
      if (orb.impl) orb.impl.stop();
      cancelAnimationFrame(orb.raf);
      orb.raf = 0;
    },
    setState(name) {
      orb.state = name;
      if (orb.impl) orb.impl.setState(name);
    },
  };
}

function createBrowserRecognizer({ lang, silenceMs, onPartial, onFinal, onFatal }) {
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null, running = false, finals = "", interim = "", timer = 0, networkErrors = 0, lastError = "";

  function flush() {
    clearTimeout(timer);
    timer = 0;
    const text = `${finals} ${interim}`.replace(/\s+/g, " ").trim();
    finals = interim = "";
    if (rec) rec.abort();
    if (text) onFinal(text);
  }

  function spawn() {
    rec = new Rec();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (ev) => {
      networkErrors = 0;
      interim = "";
      let latest = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        latest += " " + res[0].transcript;
        if (res.isFinal) finals += " " + res[0].transcript;
        else interim += " " + res[0].transcript;
      }
      onPartial(`${finals} ${interim}`.replace(/\s+/g, " ").trim(), latest.replace(/\s+/g, " ").trim());
      clearTimeout(timer);
      timer = setTimeout(flush, silenceMs);
    };
    rec.onerror = (ev) => {
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed" || ev.error === "audio-capture") {
        running = false;
        onFatal(ev.error === "audio-capture" ? "microfone indisponível" : "reconhecimento de voz bloqueado pelo navegador");
      } else if (ev.error === "network") {
        networkErrors++;
        lastError = "network";
        if (networkErrors >= 5) {
          running = false;
          onFatal("reconhecimento de voz sem acesso à rede");
        }
      }
    };
    rec.onend = () => {
      if (!running) return;
      const wait = lastError === "network" ? 1000 : 150;
      lastError = "";
      setTimeout(() => { if (running) spawn(); }, wait);
    };
    try { rec.start(); } catch (_) {}
  }

  return {
    start() { running = true; networkErrors = 0; spawn(); },
    stop() { running = false; clearTimeout(timer); finals = interim = ""; if (rec) rec.abort(); },
    reset() { clearTimeout(timer); timer = 0; finals = interim = ""; if (rec) rec.abort(); },
  };
}

function pickRecorderMime() {
  const options = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm"];
  return options.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
}

function createServerRecognizer({ stream, analyser, buf, silenceMs, isSpeaking, speakingBoost = 2, gate, onFinal, onError }) {
  let running = false, recorder = null, chunks = [], heard = false, voiceSince = 0, lastVoice = 0;
  let startedAt = 0, floor = 0.01, floorSamples = 0, ticker = 0, voiced = [];

  function begin() {
    chunks = [];
    voiced = [];
    heard = false;
    voiceSince = 0;
    startedAt = performance.now();
    const mime = pickRecorderMime();
    recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = finish;
    recorder.start(250);
  }

  async function finish() {
    const send = heard;
    const level = medianOf(voiced);
    const type = (recorder.mimeType || "audio/webm").split(";")[0];
    const blob = new Blob(chunks, { type });
    if (running) begin();
    if (!send || !blob.size) return;
    if (gate && !gate(level)) return;
    let audio = blob;
    try { audio = await toWav16k(blob); } catch (_) {}
    try {
      const r = await fetch("/stt", { method: "POST", headers: { ...headers(false), "Content-Type": audio.type }, body: audio });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || r.statusText);
      const text = String(data.text || "").trim();
      if (text) onFinal(text);
    } catch (err) {
      onError("não entendi: " + String(err.message || err));
    }
  }

  function tick() {
    if (!running) return;
    const now = performance.now();
    const lvl = micLevel(analyser, buf);
    if (floorSamples < 30) {
      floor = (floor * floorSamples + lvl) / (floorSamples + 1);
      floorSamples++;
    }
    const speaking = isSpeaking();
    const threshold = (floor * 3 + 0.02) * (speaking ? speakingBoost : 1);
    if (lvl > threshold) {
      voiceSince = voiceSince || now;
      lastVoice = now;
      if (recorder && recorder.state === "recording") voiced.push(lvl);
      if (!heard && now - voiceSince > (speaking ? 200 : 300)) heard = true;
    } else if (now - lastVoice > 200) {
      voiceSince = 0;
    }
    if (recorder && recorder.state === "recording") {
      if (heard && now - lastVoice > silenceMs) recorder.stop();
      else if (!heard && now - startedAt > 15000) recorder.stop();
    }
  }

  return {
    start() { running = true; begin(); ticker = setInterval(tick, 20); },
    reset() {},
    stop() {
      running = false;
      clearInterval(ticker);
      if (recorder && recorder.state === "recording") { heard = false; recorder.stop(); }
    },
  };
}

const orb = createOrb($("orb"), $("orbFallback"), (now) => {
  if (voice.state === "listening" && voice.micAnalyser) return micLevel(voice.micAnalyser, voice.buf) * 6;
  if (voice.state === "speaking") {
    if (voice.synthetic) return 0.3 + 0.25 * Math.abs(Math.sin(now / 90));
    if (voice.ttsAnalyser) return micLevel(voice.ttsAnalyser, voice.buf) * 5;
  }
  if (voice.state === "thinking") return 0.2 + 0.1 * Math.sin(now / 300);
  return 0;
});

function setState(name) {
  voice.state = name;
  stage.dataset.state = name;
  orb.setState(name);
}

function setCaption(text, warn) {
  caption.textContent = text || "";
  caption.classList.toggle("warn", !!warn);
}

function useBrowserStt() {
  return voice.cfg.stt === "browser";
}

function useBrowserTts() {
  return !!voice.cfg && voice.cfg.tts === "browser";
}

function idleState() {
  return voice.busy ? "thinking" : "listening";
}

async function activate() {
  orb.start();
  setState("off");
  try {
    const r = await fetch("/config", { headers: headers(false) });
    if (!r.ok) throw new Error(r.statusText);
    voice.cfg = await r.json();
  } catch (err) {
    setCaption("configuração indisponível: " + String(err.message || err), true);
    setState("error");
    return;
  }
  if (useBrowserStt() && !(window.SpeechRecognition || window.webkitSpeechRecognition)) {
    setCaption("Configure uma chave de STT nas opções do mod.", true);
    setState("error");
    return;
  }
  try {
    voice.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
  } catch (_) {
    setCaption("permissão de microfone negada", true);
    setState("error");
    return;
  }
  voice.ctx = new AudioContext();
  await voice.ctx.resume().catch(() => {});
  voice.micAnalyser = voice.ctx.createAnalyser();
  voice.micAnalyser.fftSize = 1024;
  voice.ctx.createMediaStreamSource(voice.stream).connect(voice.micAnalyser);
  voice.audio = new Audio();
  voice.ttsAnalyser = voice.ctx.createAnalyser();
  voice.ttsAnalyser.fftSize = 1024;
  voice.ctx.createMediaElementSource(voice.audio).connect(voice.ttsAnalyser);
  if (window.RTCPeerConnection && voice.ctx.createMediaStreamDestination) {
    const out = voice.ctx.createMediaStreamDestination();
    voice.ttsAnalyser.connect(out);
    try {
      voice.loopback = await createLoopback(out.stream);
    } catch (err) {
      voice.ttsAnalyser.disconnect(out);
      console.warn("sem canal de chamada; usando saída direta:", err);
    }
  }
  if (!voice.loopback) voice.ttsAnalyser.connect(voice.ctx.destination);
  stage.dataset.echo = voice.loopback ? "chamada" : "direto";
  voice.buf = new Uint8Array(1024);
  voice.ownLevels = loadOwnLevels();
  voice.levels = new LevelWindow(8000);
  clearInterval(voice.levelTimer);
  voice.levelTimer = setInterval(() => {
    if (voice.micAnalyser) voice.levels.add(performance.now(), micLevel(voice.micAnalyser, voice.buf));
  }, 50);
  voice.active = true;
  try {
    voice.recognizer = useBrowserStt()
      ? createBrowserRecognizer({
          lang: voice.cfg.lang,
          silenceMs: voice.cfg.silenceMs,
          onPartial,
          onFinal: onUtterance,
          onFatal: (text) => { setCaption(text, true); setState("error"); },
        })
      : createServerRecognizer({
          stream: voice.stream,
          analyser: voice.micAnalyser,
          buf: new Uint8Array(1024),
          silenceMs: voice.cfg.silenceMs,
          isSpeaking: () => voice.state === "speaking",
          speakingBoost: voice.loopback ? 1.5 : 2,
          gate: nearEnough,
          onFinal: onUtterance,
          onError: (text) => setCaption(text, true),
        });
    voice.recognizer.start();
  } catch (err) {
    setCaption("não foi possível iniciar a escuta: " + String(err.message || err), true);
    setState("error");
    return;
  }
  setCaption("");
  setState(idleState());
}

function deactivate() {
  voice.active = false;
  voice.approval = null;
  if (voice.recognizer) voice.recognizer.stop();
  voice.recognizer = null;
  stopPlayback();
  stopStopDetector();
  clearInterval(voice.levelTimer);
  voice.levelTimer = 0;
  if (voice.loopback) voice.loopback.close();
  voice.loopback = null;
  if (voice.stream) voice.stream.getTracks().forEach(t => t.stop());
  if (voice.ctx) voice.ctx.close().catch(() => {});
  voice.stream = voice.ctx = voice.micAnalyser = voice.ttsAnalyser = voice.audio = null;
  setState("off");
  orb.stop();
}

function echoPool() {
  return voice.spoken + " " + voice.echoText;
}

function levelKey() {
  return "conversa_voice_levels_" + (useBrowserStt() ? "browser_peak" : "server");
}

function loadOwnLevels() {
  try {
    const saved = JSON.parse(localStorage.getItem(levelKey()) || "[]");
    return Array.isArray(saved) ? saved.filter(n => typeof n === "number" && n > 0) : [];
  } catch (_) {
    return [];
  }
}

function proximity() {
  return voice.cfg ? (voice.cfg.proximity ?? 45) : 0;
}

function nearEnough(level) {
  if (!level) return true;
  if (!isNearVoice(level, voice.ownLevels, proximity())) {
    setCaption("ignorei fala distante", true);
    return false;
  }
  if (voice.state !== "speaking") {
    voice.ownLevels = learnLevel(voice.ownLevels, level);
    try { localStorage.setItem(levelKey(), JSON.stringify(voice.ownLevels)); } catch (_) {}
  }
  return true;
}

function partialLevel() {
  return voice.levels ? voice.levels.peak(performance.now()) : 0;
}

function resetListening() {
  if (voice.levels) voice.levels.reset(performance.now());
  if (voice.recognizer) voice.recognizer.reset();
}

function stopAll() {
  voice.lastStopAt = performance.now();
  stopPlayback();
  setCaption("parei");
  sendEvent({ type: "stop" });
}

function onPartial(text, latest) {
  if (!voice.active) return;
  if (voice.pumping) {
    if (isStopCommand(latest || text, echoPool()) || isStopCommand(text, echoPool())) {
      if (!isNearVoice(partialLevel(), voice.ownLevels, proximity())) return;
      resetListening();
      voice.userPartial = false;
      stopAll();
      return;
    }
    if (isEcho(text, echoPool())) return;
  }
  voice.userPartial = true;
  setCaption(text);
}

function onUtterance(text) {
  if (!voice.active) return;
  const message = String(text || "").trim();
  voice.userPartial = false;
  if (useBrowserStt()) {
    const level = partialLevel();
    if (voice.levels) voice.levels.reset(performance.now());
    if (message && !nearEnough(level)) return;
  }
  if (!message) return;
  if (voice.approval) {
    const decision = approvalDecision(message, voice.approval.question, voice.pumping);
    if (decision === "deny") {
      if (voice.pumping) skipCurrent();
      setCaption("");
      answerApproval({ click: "deny" });
      return;
    }
    if (decision === "answer") {
      setCaption("");
      answerApproval({ utterance: message });
      return;
    }
    if (decision === "ignore") return;
  }
  if (isDuplicateStop(performance.now(), voice.lastStopAt) && normWords(message).length <= 2) {
    setCaption("");
    return;
  }
  if (isStopCommand(message, "")) {
    stopAll();
    return;
  }
  if (voice.pumping ? isEcho(message, echoPool()) : isLateEcho(message, voice.echoText, performance.now(), voice.echoUntil)) return;
  if (voice.approval) {
    setCaption("");
    answerApproval({ utterance: message });
    return;
  }
  setCaption(voice.pumping || voice.busy ? "guardei: " + message : message);
  if (!voice.pumping) setState("thinking");
  sendEvent({ type: "utterance", text: message });
}

function rememberEcho() {
  if (!voice.spoken) return;
  voice.echoText = voice.spoken;
  voice.echoUntil = performance.now() + (voice.cfg ? voice.cfg.silenceMs + 1500 : 2700);
}

function startStopDetector() {
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (voice.stopDetector || voice.stopDetectorOff || !Rec || !voice.active || !voice.cfg || useBrowserStt()) return;
  const check = (text, latest) => {
    if (!voice.active || !voice.pumping || isDuplicateStop(performance.now(), voice.lastStopAt)) return;
    if (!stopInPartial(text, latest, echoPool())) return;
    const level = partialLevel();
    if (level && !isNearVoice(level, voice.ownLevels, proximity())) return;
    stopAll();
    if (voice.stopDetector) voice.stopDetector.reset();
  };
  try {
    voice.stopDetector = createBrowserRecognizer({
      lang: voice.cfg.lang,
      silenceMs: 800,
      onPartial: check,
      onFinal: (text) => check(text, text),
      onFatal: (reason) => {
        voice.stopDetectorOff = true;
        voice.stopDetector = null;
        console.warn("detector rápido de 'para' desligado:", reason);
      },
    });
    voice.stopDetector.start();
  } catch (err) {
    voice.stopDetectorOff = true;
    voice.stopDetector = null;
  }
}

function stopStopDetector() {
  if (voice.stopDetector) voice.stopDetector.stop();
  voice.stopDetector = null;
}

function skipCurrent() {
  voice.playId++;
  if (voice.audio) voice.audio.pause();
  if (window.speechSynthesis) speechSynthesis.cancel();
  if (voice.endPlay) voice.endPlay();
  rememberEcho();
  voice.spoken = "";
  voice.synthetic = false;
}

function stopPlayback() {
  voice.replyQueue.length = 0;
  skipCurrent();
}

async function fetchSpeech(text) {
  try {
    const r = await post("/tts", { text });
    if (r.status === 204) return { skip: true };
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      return { error: data.error || r.statusText };
    }
    if (r.headers.get("X-Voice-Fallback") && !voice.warnedFallback) {
      voice.warnedFallback = true;
      setCaption("provedor de voz falhou; usando a voz gratuita", true);
    }
    return { blob: await r.blob() };
  } catch (err) {
    return { error: String(err.message || err) };
  }
}

function playBlob(blob) {
  const audio = voice.audio;
  return new Promise((resolve) => {
    if (!audio) { resolve(); return; }
    const url = URL.createObjectURL(blob);
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      audio.onended = audio.onerror = null;
      URL.revokeObjectURL(url);
      if (voice.endPlay === done) voice.endPlay = null;
      resolve();
    };
    voice.endPlay = done;
    audio.onended = done;
    audio.onerror = done;
    audio.src = url;
    audio.play().catch(done);
  });
}

async function speakBrowser(chunks, id) {
  if (!window.speechSynthesis) return;
  voice.synthetic = true;
  for (const chunk of chunks) {
    if (id !== voice.playId) return;
    setState("speaking");
    await new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(chunk);
      u.lang = (voice.cfg && voice.cfg.lang) || "pt-BR";
      u.onend = u.onerror = resolve;
      voice.endPlay = resolve;
      speechSynthesis.speak(u);
    });
  }
  voice.synthetic = false;
}

function prepareChunks(chunks) {
  const list = chunks.filter(c => String(c || "").trim());
  const first = list.length && !useBrowserTts() ? fetchSpeech(list[0]) : Promise.resolve(null);
  return { chunks: list, first };
}

async function playItem(item, id) {
  const chunks = item.chunks;
  if (id !== voice.playId || !chunks.length) return;
  voice.spoken = chunks.join(" ");
  if (!voice.userPartial) resetListening();
  if (useBrowserTts()) return speakBrowser(chunks, id);
  let next = item.first.then(got => got || fetchSpeech(chunks[0]));
  for (let i = 0; i < chunks.length; i++) {
    const got = await next;
    if (id !== voice.playId) return;
    next = i + 1 < chunks.length ? fetchSpeech(chunks[i + 1]) : null;
    if (got.skip) continue;
    if (got.error) {
      setCaption("voz indisponível; usando a do navegador", true);
      return speakBrowser(chunks.slice(i), id);
    }
    setState("speaking");
    await playBlob(got.blob);
    if (id !== voice.playId) return;
  }
}

function speak(chunks) {
  if (!voice.active) return;
  voice.replyQueue.push(prepareChunks(chunks));
  pump();
}

async function pump() {
  if (voice.pumping) return;
  voice.pumping = true;
  startStopDetector();
  try {
    while (voice.active && voice.replyQueue.length) {
      const item = voice.replyQueue.shift();
      await playItem(item, ++voice.playId);
      rememberEcho();
      voice.spoken = "";
      voice.synthetic = false;
    }
  } finally {
    voice.pumping = false;
    stopStopDetector();
    if (voice.active) {
      if (!voice.userPartial) resetListening();
      setState(idleState());
    }
  }
}

function showApproval(question) {
  questionBox.textContent = question;
  questionBox.hidden = !question;
  allowBtn.hidden = denyBtn.hidden = false;
}

function hideApproval() {
  questionBox.hidden = true;
  allowBtn.hidden = denyBtn.hidden = true;
}

async function answerApproval(answer) {
  const pending = voice.approval;
  if (!pending || pending.busy) return;
  pending.busy = true;
  try {
    const r = await post("/approval/answer", { id: pending.id, ...answer });
    const data = await r.json().catch(() => ({}));
    if (voice.approval !== pending) return;
    if (data.result === "retry") {
      pending.busy = false;
      speak([pending.question]);
      return;
    }
  } catch (_) {
    pending.busy = false;
    return;
  }
  voice.approval = null;
  hideApproval();
}

const handlers = {
  state(msg) {
    voice.busy = msg.state === "thinking";
    if (msg.state === "error") setState("error");
    else if (!voice.pumping && voice.active) setState(msg.state === "speaking" ? idleState() : msg.state);
  },
  speak(msg) { speak(msg.chunks || []); },
  flush() { stopPlayback(); },
  caption(msg) { setCaption(msg.text || ""); },
  approval(msg) {
    voice.approval = { id: msg.id, question: msg.question || "", busy: false };
    showApproval(voice.approval.question);
    if (voice.approval.question) speak([voice.approval.question]);
  },
  "approval-done"(msg) {
    if (voice.approval && voice.approval.id === msg.id) voice.approval = null;
    hideApproval();
  },
  quit() {
    deactivate();
    window.close();
  },
};

const sseFailures = new Failures(5);

function listen() {
  voice.events = new EventSource(`/events?t=${encodeURIComponent(token)}`);
  voice.events.onopen = () => sseFailures.ok();
  voice.events.onerror = () => {
    if (!sseFailures.fail()) return;
    voice.events.close();
    deactivate();
    window.close();
  };
  voice.events.onmessage = (ev) => {
    sseFailures.ok();
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    const handler = handlers[msg.type];
    if (handler) handler(msg);
  };
}

allowBtn.addEventListener("click", () => answerApproval({ click: "allow" }));
denyBtn.addEventListener("click", () => answerApproval({ click: "deny" }));
stopBtn.addEventListener("click", stopAll);
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") stopAll(); });

listen();
activate();
