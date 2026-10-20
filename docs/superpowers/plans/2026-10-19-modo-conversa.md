# Modo conversa — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mod do Claude Code (Windows, desktop) que liga um modo conversa por voz com a orbe do Smith numa janelinha flutuante, ouvindo o dono e respondendo em áudio.

**Architecture:** O mod (`hooks/register.tsx`) controla o modo, transforma o texto da resposta em blocos falados e responde a permissões. Um auxiliar Python empacotado (`conversa-helper.exe`) serve a página local, faz STT/TTS e abre o Edge em modo app, sempre por cima. A página porta o `voice.js` e o `orb.js` do Smith. Mod → auxiliar por HTTP em 127.0.0.1:47811; auxiliar → mod por linhas JSON no stdout.

**Tech Stack:** API de mods do Claude Code 2.1.299 (TSX), Python 3.11+ (stdlib `http.server`, `httpx`, `edge-tts`), PyInstaller, Edge (Chromium) com Web Speech/WebRTC/WebGL, Three.js (cópia do vendor do Atlas), Node 24 para testes JS puros.

**Spec:** `docs/superpowers/specs/2026-10-19-modo-conversa-design.md`

## Global Constraints
- Nenhum vínculo com o Atlas: copiar e adaptar do projeto Atlas (HEAD 811f003), localizando por nome de função; nunca importar nem ler de lá em tempo de execução.
- Windows 10/11 apenas. Porta única `47811`, só em `127.0.0.1`. Token aleatório por ativação no header `X-Conversa-Token` (ou query `t` para a página e SSE).
- Identificadores em inglês, textos ao usuário em pt-BR, sem comentários no código.
- Dependências Python do auxiliar: só `httpx` e `edge-tts` (+ `pyinstaller` só no build).
- Chaves só por variável de ambiente para o auxiliar; nunca na página, nunca em log.
- CLI do Claude para validar/testar: `"$APPDATA/Claude/claude-code/2.1.299/f0584be0fbaf/claude.exe"` (abaixo `CLAUDE`).
- Tipos da API: `C:/Users/NIUARQ~1.BAT/AppData/Local/Temp/claude/bundled-skills/2.1.299/c8b2ffd859cbaf64daac5e475bb8e1e5/plugin-authoring/types/claude-code.d.ts` (consultar por grep: `'turn.step'`, `TurnStepTextChunk`, `TurnCompleteFields`, `PermissionRequestDecision`, `ProcessSpawnRequest`).
- Textos fixos: "O modo conversa já está ligado em outra sessão.", "Tive um problema ao processar.", "Ainda estou nisso.", "O detalhe está na tela.", "Negado por voz.", "parei", "guardei: …".

## Review Focus
1. Auxiliar morre ou não sobe (exe bloqueado, porta ocupada por outro programa) → o modo desliga com toast claro, nunca fica "ligado" sem janela. Teste em Task 7 (`helper exit turns mode off`).
2. Linhas JSON do stdout chegam partidas ou várias num pedaço → o mod remonta sem perder nem duplicar evento. Teste em Task 7 (`line splitter`).
3. Resposta com bloco de código aberto no meio do fluxo (``` sem fechar ainda) → nada do código é falado antes de fechar. Teste em Task 8 (`open code fence is held`).
4. "Para" chega quando não há turno ativo nem fala → não chama `$.turn.abort`, só limpa a fila. Teste em Task 8 (`stop without turn does not abort`).
5. Pedido de permissão com o modo desligado ou o auxiliar fora → o hook passa direto (`next(e)`) sem espera. Teste em Task 9 (`permission passes when off`).

---

### Task 1: Spike de plataforma (Edge app, Web Speech, topmost, exe)

**Files:**
- Create: `spike/server.py`, `spike/page.html`, `spike/README.md`

**Interfaces:** nenhuma; o spike é descartável e só registra resultados em `spike/README.md`.

- [ ] **Step 1:** `spike/server.py` (stdlib) serve `page.html` em 127.0.0.1:47811 e aceita `POST /report` gravando o JSON recebido em stdout.
- [ ] **Step 2:** `page.html` reporta: `'webkitSpeechRecognition' in window`, `'SpeechRecognition' in window`, suporte a WebGL2, `RTCPeerConnection`, `speechSynthesis.getVoices()` filtrado por `pt-BR` (nomes), e `document.visibilityState` a cada 5 s com um contador de `setInterval(…,20)` vs `requestAnimationFrame`.
- [ ] **Step 3:** abrir com `msedge.exe --app=http://127.0.0.1:47811/ --user-data-dir=%LOCALAPPDATA%\claude-modo-conversa\edge --window-size=340,420 --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --no-first-run --no-default-browser-check`; localizar a janela pelo título com `ctypes` (`EnumWindows`/`GetWindowTextW`) e aplicar `SetWindowPos(HWND_TOPMOST)`.
- [ ] **Step 4:** empacotar `spike/server.py` com PyInstaller `--onefile` num venv de build e rodar o exe nesta máquina (Windows 10 Enterprise) para ver se AppLocker/SmartScreen bloqueiam.
- [ ] **Step 5:** registrar em `spike/README.md` cada resultado (sim/não + evidência). Decisões: se Web Speech ausente → padrão `sttProvider=openai`; se exe bloqueado → parar e reportar ao dono; se `setInterval` cai com a janela atrás → VAD em `AudioWorklet`.
- [ ] **Step 6:** commit `Spike: Edge em modo app, Web Speech, topmost e exe`.

### Task 2: Texto falado e consentimento (Python do auxiliar)

**Files:**
- Create: `helper/conversa/__init__.py`, `helper/conversa/transcript.py`, `helper/conversa/consent.py`, `helper/tests/test_transcript.py`, `helper/tests/test_consent.py`, `helper/pyproject.toml`

**Interfaces:**
- Produces: `clean_transcript(text: str, prompt: str = "") -> str`; `classify_consent(text: str) -> bool | None` (True sim, False não, None não entendi).

- [ ] **Step 1:** testes copiando os casos do Atlas (`voice/text.py::clean_transcript`, `orchestrator/consent.py::classify_consent`, e seus testes em `tests/`), adaptando: `clean_transcript("[música] obrigado por assistir") == ""`, `clean_transcript("hm") == ""`, `classify_consent("pode rodar") is True`, `classify_consent("não pode") is False`, `classify_consent("o que é isso?") is None`, `classify_consent("sim, pode seguir") is True`.
- [ ] **Step 2:** `cd helper && python -m pytest -q` → FAIL (módulo ausente).
- [ ] **Step 3:** portar as duas funções; acrescentar "pode rodar" e "pode editar" às frases de sim.
- [ ] **Step 4:** pytest → PASS.
- [ ] **Step 5:** commit.

### Task 3: Provedores de STT/TTS

**Files:**
- Create: `helper/conversa/providers.py`, `helper/tests/test_providers.py`

**Interfaces:**
- Consumes: `clean_transcript` (Task 2).
- Produces: `class Voice: def __init__(self, cfg: VoiceConfig, transport: httpx.AsyncBaseTransport | None = None)`; `async def speak(self, text: str) -> tuple[bytes, bool]` (mp3, `fell_back`); `async def transcribe(self, audio: bytes, mime: str) -> str`; `@dataclass VoiceConfig(stt: str = "browser", tts: str = "edge", voice: str = "pt-BR-AntonioNeural", rate: str = "+0%", lang: str = "pt-BR", stt_prompt: str = "", openai_key: str = "", elevenlabs_key: str = "")`; `VoiceConfig.from_env(environ) -> VoiceConfig` lendo `CONVERSA_CONFIG` (JSON) e `OPENAI_API_KEY`/`ELEVENLABS_API_KEY`.
- Valores do Atlas: OpenAI TTS `POST https://api.openai.com/v1/audio/speech` `{model:"gpt-4o-mini-tts", input, voice, response_format:"mp3", speed}`; OpenAI STT `POST /v1/audio/transcriptions` `model=whisper-1`, `language="pt"`, `prompt`, `response_format=verbose_json` + `is_noise_segment`; ElevenLabs TTS `POST https://api.elevenlabs.io/v1/text-to-speech/{voice}?output_format=mp3_44100_128` `{text, model_id:"eleven_multilingual_v2", voice_settings:{speed∈[0.7,1.2]}}` header `xi-api-key`; ElevenLabs STT `POST /v1/speech-to-text` `model_id=scribe_v1`, `language_code`; Edge `edge_tts.Communicate(text, voice, rate=rate).stream()`; `rate_factor("+10%") == 1.1` limitado a [0.25, 4]. Voz padrão por provedor: openai `onyx`, elevenlabs `pNInz6obpgDQGcFmaJgB`, edge `pt-BR-AntonioNeural` (usar o padrão do provedor quando `voice` for de outro provedor).

- [ ] **Step 1:** testes com `httpx.MockTransport`: corpo/headers exatos de OpenAI e ElevenLabs; `speak` com provedor pago falhando (500) chama Edge (monkeypatch de `edge_tts.Communicate`) e devolve `fell_back=True`; `transcribe` aplica `clean_transcript`; segmento ruidoso descartado; `stt="browser"` em `transcribe` levanta `ValueError`; chave ausente para provedor pago levanta `ValueError("chave da OpenAI ausente")`.
- [ ] **Step 2:** pytest → FAIL.
- [ ] **Step 3:** implementar portando `voice/base.py`, `stt_*`, `tts_*`, e o fallback de `registry.VoiceService.speak`.
- [ ] **Step 4:** pytest → PASS. **Step 5:** commit.

### Task 4: Servidor do auxiliar e protocolo

**Files:**
- Create: `helper/conversa/server.py`, `helper/conversa/bus.py`, `helper/conversa/__main__.py`, `helper/tests/test_server.py`

**Interfaces:**
- Consumes: `Voice`, `VoiceConfig`, `classify_consent`.
- Produces (HTTP, todas exigem token salvo `/ping`):
  - `GET /ping` → `{"app":"modo-conversa","busy":true}`
  - `GET /` → `web/index.html` (com `t` validado); `GET /static/<arquivo>` → `helper/web/`
  - `GET /events?t=` → SSE; cada comando de `/cmd` vira `data: <json>\n\n`
  - `POST /cmd` (do mod) → 204; tipos `state|speak|flush|approval|approval-done|caption|quit` (spec §4.2)
  - `POST /event` (da página) `{type:"utterance"|"stop"|"closed", text?}` → 204 e a linha JSON no stdout
  - `POST /approval/wait` (do mod) `{id, question}` → publica `approval` no SSE e **segura a resposta** até decisão ou 20 s: `{"decision":"allow"|"deny"|"timeout"}`
  - `POST /approval/answer` (da página) `{id, utterance?, click?: "allow"|"deny"}` → `{"result":"done"|"retry"}`: clique decide direto; fala passa por `classify_consent` (None na 1ª vez → `retry`; None na 2ª → `timeout`)
  - `POST /stt` multipart `audio` → `{text}`; `POST /tts` `{text}` → `audio/mpeg` (204 se vazio; header `X-Voice-Fallback: 1` se caiu para Edge)
  - stdout: `{"type":"ready","port":47811}` ao subir; eventos da página; `{"type":"error","message":…}`
- `python -m conversa --port 47811 [--no-window]` (lê `CONVERSA_TOKEN`).

- [ ] **Step 1:** testes com servidor em thread numa porta livre (`--port 0` permitido nos testes): `/ping` sem token ok; `/cmd` sem token → 401; `/cmd` speak aparece no SSE; `/event` utterance escreve linha no stdout capturado; `/approval/wait` + `/approval/answer` clique allow → `allow`; fala "não" → `deny`; fala "hã?" duas vezes → `timeout`; sem resposta em 0,2 s (timeout configurável no teste) → `timeout`; `/tts` com `Voice` falso devolve bytes e header.
- [ ] **Step 2:** pytest → FAIL. **Step 3:** implementar com `ThreadingHTTPServer`; `bus.py` guarda assinantes SSE e esperas de aprovação (`threading.Event` por id); provedores async rodados num loop asyncio dedicado em thread. **Step 4:** pytest → PASS. **Step 5:** commit.

### Task 5: Janela flutuante (Edge em modo app)

**Files:**
- Create: `helper/conversa/window.py`, `helper/tests/test_window.py`
- Modify: `helper/conversa/__main__.py` (abre a janela salvo `--no-window`; encerra o processo quando o Edge fecha → emite `closed`)

**Interfaces:**
- Produces: `edge_path() -> str | None` (Program Files x86/64, `LOCALAPPDATA`); `edge_args(url: str, profile: str, x: int, y: int) -> list[str]` (flags da Task 1 + `--window-size=340,420 --window-position=x,y`); `class EdgeWindow: start(url) / stop() / wait_closed()`; `make_topmost(title: str = "Modo conversa", timeout: float = 10) -> bool`.

- [ ] **Step 1:** testes de `edge_args` (contém `--app=<url>` e o perfil em `%LOCALAPPDATA%\claude-modo-conversa\edge`) e de posição no canto inferior direito da área de trabalho (`SystemParametersInfoW(SPI_GETWORKAREA)` mockado).
- [ ] **Step 2:** FAIL → **Step 3:** implementar (subprocess Popen; `stop()` encerra a árvore do processo com `taskkill /T /F /PID`) → **Step 4:** PASS.
- [ ] **Step 5:** verificação manual: `python -m conversa` abre a janela por cima, fechar a janela termina o processo com `{"type":"closed"}` no stdout. **Step 6:** commit.

### Task 6: Página da janelinha (orbe + voz portada)

**Files:**
- Create: `helper/web/index.html`, `helper/web/style.css`, `helper/web/orb.js` (cópia de `static/orb.js`), `helper/web/vendor/three.module.min.js` (cópia), `helper/web/voicecore.js` (funções puras), `helper/web/conversa.js` (ciclo de vida), `helper/web/tests/voicecore.test.mjs`

**Interfaces:**
- Consumes: rotas da Task 4.
- Produces: `voicecore.js` (ES module, puro, testável em Node): `normWords`, `isEcho`, `isStopCommand`, `stopInPartial`, `isDuplicateStop`, `isLateEcho`, `medianOf`, `isNearVoice`, `learnLevel`, `encodeWav`, `approvalDecision` — portadas do `voice.js` por nome, com o filler `smith` trocado por `claude`.
- Título do documento: "Modo conversa". Layout: palco do Smith (canvas da orbe 300×170, fallback `.orb-fallback`, legenda `#caption` aria-live), botões **Parar** e, só durante aprovação, **Permitir**/**Negar**.

- [ ] **Step 1:** testes `node --test helper/web/tests`: `isStopCommand("para claude", "")` true; `isStopCommand("para de falar", "")` true; `isStopCommand("vou parar o servidor agora", "")` false; `isEcho("vou olhar os arquivos", "Vou olhar os arquivos.")` true; `approvalDecision("sim pode", q, false)` → `"answer"`; `approvalDecision("cancela", q, false)` → `"deny"`; `isNearVoice(0.01, [0.1,0.1,0.1], 45)` false.
- [ ] **Step 2:** FAIL → **Step 3:** portar `voicecore.js`; `conversa.js` porta de `voice.js` o restante: `createOrb`, `createBrowserRecognizer`, `createServerRecognizer` (laço com `setInterval(…, 20)` ou `AudioWorklet` conforme Task 1), `toWav16k`, `createLoopback`/`tuneOpus`, fila `prepareReply/playItem/pump/skipCurrent/stopPlayback`, detector rápido de "para", gate de proximidade (`localStorage` `conversa_voice_levels_*`), eco. Trocas: `window.atlas.send` → `POST /event utterance`; eventos `atlas:*` → mensagens SSE (`state`, `speak`, `flush`, `approval`, `approval-done`, `caption`, `quit`); `/v1/voice/transcribe` → `/stt`; `/v1/voice/speak` → `/tts`; aprovação → `/approval/answer` (`retry` repete a pergunta). Se `cfg.stt === "browser"` e não houver Web Speech → legenda "Configure uma chave de STT nas opções do mod." e estado `error`. **Step 4:** PASS.
- [ ] **Step 5:** verificação no Edge: `python -m conversa` com mod ausente; enviar à mão `POST /cmd speak` e `state` com o token e conferir orbe mudando e fala; `read_console_messages` sem erros. **Step 6:** commit.

### Task 7: Esqueleto do mod e gestão do auxiliar

**Files:**
- Create: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.tsx`, `hooks/helper.ts`, `hooks/lines.ts`, `types/index.d.ts`, `hooks/helper.test.ts`, `tsconfig.json`

**Interfaces:**
- Produces:
  - `plugin.json`: `name: "modo-conversa"`, `version: "0.1.0"`, `types`, e `userConfig` com os campos do spec §6 (`sttProvider` options `browser|openai|elevenlabs`; `ttsProvider` options `edge|openai|elevenlabs|browser`; `ttsVoice`, `ttsRate`, `silenceMs` number, `proximity` number, `sttPrompt`, `openaiApiKey` e `elevenlabsApiKey` sensíveis). Confirmar a forma do manifesto com `CLAUDE plugin validate .`.
  - `lines.ts`: `class LineSplitter { push(text: string): unknown[] }` (JSON por linha; linha inválida ignorada).
  - `helper.ts`: `helperCommand(pluginRoot: string): string[]` (`bin/conversa-helper.exe` se existir, senão `["python","-m","conversa"]` com `cwd` `helper/`); `startHelper($, options): Promise<HelperHandle>`; `HelperHandle = { port: number, token: string, send(cmd: object): Promise<void>, events: AsyncIterable<HelperEvent>, stop(): Promise<void> }`; `HelperEvent = {type:"utterance",text} | {type:"stop"} | {type:"closed"} | {type:"error",message}`.
  - Estado em `$.state` (contrato em `types/index.d.ts`): `modo-conversa.mode: "off" | "starting" | "on"`, `modo-conversa.phase: "listening" | "thinking" | "speaking" | "error"`.
  - Faixa `AbovePrompt`: botão `🎙 Modo conversa` (off) / texto `● Conversa ligada — {fase}` + botão `Desligar` (on). `/conversa` alterna. `$.ui.status("🎙 " + fase)` quando ligado.
- Ligar: `GET /ping` (se responde → toast "O modo conversa já está ligado em outra sessão." e fica off); token via `crypto.randomUUID()`; `spawn` com `env` (`CONVERSA_TOKEN`, `CONVERSA_CONFIG`, chaves); espera `ready` 10 s; evento `closed` ou fim do processo → off + toast "A janela do modo conversa foi fechada." (ou a mensagem de erro).

- [ ] **Step 1:** testes (`claude-code/testing`, superfícies `desktop` e `terminal`): `line splitter` (`'{"a":1}\n{"b"'` + `':2}\n'` → dois objetos); faixa mostra o botão quando off e `Desligar` quando on; pressionar o botão chama `startHelper` (mock de `$.process.spawn` que emite `ready`); `ping busy → toast`; `helper exit turns mode off`.
- [ ] **Step 2:** `CLAUDE plugin test .` → FAIL. **Step 3:** implementar. **Step 4:** `CLAUDE plugin validate .`, `npx tsc -p .` (tsconfig estendendo `.claude-plugin/types/tsconfig.json` quando existir; senão o do cabeçalho do arquivo de tipos) e `CLAUDE plugin test .` → PASS. **Step 5:** commit.

### Task 8: Fala da resposta, confirmações e controle do turno

**Files:**
- Create: `hooks/speakable.ts`, `hooks/speech.ts`, `hooks/speakable.test.ts`, `hooks/speech.test.ts`
- Modify: `hooks/register.tsx`

**Interfaces:**
- Consumes: `HelperHandle` (Task 7).
- Produces:
  - `speakable(text: string): string` (spec §5.5, porta de `text.py::speakable` + caminhos longos → nome do arquivo, inline code sem crases, "na tela" no lugar de "no canvas/chat").
  - `class SentenceStream { constructor(limit = 350); push(text: string): string[]; finish(): { chunks: string[], rest: string } }` — devolve blocos prontos (primeiro bloco 1 frase, depois até 2 frases/300 caracteres), segura texto dentro de cerca de código aberta, para de emitir após `limit` caracteres falados e acumula o restante em `rest`.
  - `toolAck(tool: string, mcpServer?: string): string` (frases do spec §5.6).
  - `class Conversation` com a fila de prompts e as regras: `onUtterance(text)` (sem turno → `$.prompt.submit`; com turno → guarda e manda `caption "guardei: …"`); `onTurnComplete()` (envia o próximo guardado); `onStop()` (`flush`; `$.turn.abort` só se houver turno ativo; `caption "parei"`).
- Hooks: `turn.step` (só `agentId === undefined`): repassa os chunks sem alterar, alimenta `SentenceStream` com chunks `text` e envia `speak`; ao primeiro step → `state thinking`. `turn.complete`: `finish()`; se `rest` não vazio → `$.model.complete({ model: "claude-haiku-5-5", prompt, timeoutMs: 15000 })` pedindo resumo em até 2 frases/40 palavras em pt-BR e fala `"Resumindo: " + resumo + " O detalhe está na tela."` (falha → só "O detalhe está na tela."); `reason === "error"` → `state error` e fala "Tive um problema ao processar." depois de 2 s; depois `state listening`. `tool.call`: `toolAck` respeitando 4 s sem fala e no máximo 1 a cada 15 s. Espera longa: `$.clock.every(1000)` fala "Ainda estou nisso." após 12 s sem fala com turno ativo e sem aprovação, no máximo a cada 30 s. `prompt.compose` com modo ligado: seção `scope: 'session'` com o texto do spec §5.5.

- [ ] **Step 1:** testes: `speakable("```py\nx=1\n```")` → "Deixei um trecho de código na tela."; `speakable("Veja `src/a/b/config.py`.")` → "Veja config.py."; `speakable("| a | b |\n|---|---|")` → "Mostrei uma tabela na tela."; `SentenceStream`: `push("Oi. Tudo bem? Sim.")` → `["Oi."]`, depois `finish()` → `["Tudo bem? Sim."]`; `open code fence is held` (`push("Veja:\n```\nrm -rf")` → `[]`); texto acima de 350 caracteres vai para `rest`; `Conversation`: `stop without turn does not abort`; utterance durante turno é guardada e enviada no `turn.complete`; `toolAck("Bash")` = "Vou rodar um comando."; com modo off nenhum hook envia nada.
- [ ] **Step 2:** FAIL → **Step 3:** implementar → **Step 4:** validate/tsc/test PASS → **Step 5:** commit.

### Task 9: Aprovação por voz e clique

**Files:**
- Create: `hooks/approval.ts`, `hooks/approval.test.ts`
- Modify: `hooks/register.tsx`

**Interfaces:**
- Consumes: `HelperHandle`, rota `POST /approval/wait` (Task 4).
- Produces: `approvalQuestion(toolName: string, toolInput: unknown, mcpServer?: string): string` — Bash/PowerShell `"Posso rodar um comando: {command cortado em 60}?"`; Edit/Write `"Posso editar {nome do arquivo}?"`; outros `"Posso usar {ferramenta}?"`.
- Hook `classic.PermissionRequest`: modo off ou sem auxiliar → `next(e)`; senão `await $.http.fetch("http://127.0.0.1:47811/approval/wait", { method: "POST", headers: { "X-Conversa-Token": token }, body })` (espera dentro do `$`, sem consumir o orçamento do hook); `allow` → `{ decision: { behavior: "allow" } }`; `deny` → `{ decision: { behavior: "deny", message: "Negado por voz." } }`; `timeout`/erro → `next(e)`. Registrar com `.catch(($, e, next) => next(e))`.

- [ ] **Step 1:** testes: `permission passes when off`; resposta `allow` vira decisão allow; `deny` com mensagem; `timeout` passa adiante; `approvalQuestion("Bash", {command: "git status"})` = "Posso rodar um comando: git status?".
- [ ] **Step 2:** FAIL → **Step 3:** implementar → **Step 4:** PASS → **Step 5:** commit.

### Task 10: Empacotamento, instalação e verificação ponta a ponta

**Files:**
- Create: `scripts/build-helper.ps1`, `helper/conversa.spec` (PyInstaller), `.claude-plugin/marketplace.json`, `README.md`, `.gitignore`
- Create (gerado): `bin/conversa-helper.exe`

**Interfaces:**
- Consumes: tudo acima. `helperCommand` passa a achar `bin/conversa-helper.exe`.

- [ ] **Step 1:** `build-helper.ps1`: cria `.venv-build` (uv ou `python -m venv`), instala `httpx edge-tts pyinstaller`, gera `--onefile --noconsole` com `helper/web` embutido (`--add-data`), copia para `bin/`. Rodar e confirmar `bin/conversa-helper.exe --port 47811 --no-window` responde `/ping`.
- [ ] **Step 2:** `marketplace.json` local (`source: "./"`) e README em pt-BR: instalar com `claude plugin marketplace add <pasta>` + `/plugin install modo-conversa@<marketplace>`, ou `CLAUDE_CODE_PLUGIN_DIRS`; configurar opções; primeira vez permitir o microfone na janelinha.
- [ ] **Step 3:** suíte completa: `cd helper && python -m pytest -q`, `node --test helper/web/tests`, `CLAUDE plugin validate .`, `CLAUDE plugin test .`.
- [ ] **Step 4:** ponta a ponta sem microfone: sessão `claude -p` com `--plugin-dir .` não serve (sem interação); em vez disso, script `scripts/smoke.ps1` sobe o exe, abre a janela, envia `state`/`speak`/`approval` e confere áudio e estados pelo SSE e pelo console da página. Registrar o que só o dono pode testar (falar, interromper, aprovar falando).
- [ ] **Step 5:** commit `Empacotamento do auxiliar e instruções de instalação`.
