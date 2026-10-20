# Modo conversa para o Claude Code — design

Data: 2026-10-19 · Dono: Niuarque Batista · Status: aprovado em conversa (escopo); decisões marcadas *(minha escolha)* foram tomadas pelo Claude e podem ser revistas.

## 1. Intenção

Um mod do Claude Code (app desktop, Windows) que liga um **modo conversa por voz**: o dono aperta um botão, fala, o Claude recebe o que foi dito como prompt e responde **em áudio**, na mesma dinâmica do modo Conversação do Smith (projeto Atlas): orbe animada, fala em frases assim que a resposta chega, interrupção por "para", eco filtrado, aprovação por voz.

Por quê: o dono já usa e gosta do modo Conversação do Smith e quer a mesma experiência ao trabalhar com o Claude Code.

## 2. Objetivos, não-objetivos, anti-objetivos

**Objetivos (v1)**
- Botão no Claude Code (faixa acima do prompt) e comando `/conversa` para ligar/desligar.
- Ao ligar, abre uma **janelinha flutuante** (sempre por cima, pequena, arrastável) com a **orbe real do Smith** (`orb.js`, Three.js), legenda e botão de parar.
- Ouvir: fim de fala por silêncio; transcrição pelo reconhecimento do próprio Edge (sem chave) ou por OpenAI/ElevenLabs (com chave).
- Falar: resposta dividida em frases; o **primeiro bloco tem uma frase** e é falado assim que chega; código/markdown limpos antes da fala. TTS Edge (sem chave), OpenAI ou ElevenLabs.
- Confirmações faladas curtas quando o Claude aciona ferramenta; aviso "Ainda estou nisso." em espera longa.
- Interromper: "para"/"pare" corta a fala e, se o Claude estiver trabalhando, aborta o turno; barge-in (falar por cima) com filtro de eco.
- Aprovação de permissão **falando ou clicando** (botões na janelinha; a caixa normal do Claude como reserva).
- Funciona numa máquina Windows que **nunca teve o Atlas**: nada além do Claude Code desktop e do Edge (que vem no Windows).

**Não-objetivos (v1)**
- Reconhecimento da voz cadastrada do dono (speaker, sherpa-onnx).
- macOS e Linux.
- Uso no Claude Code de terminal puro (a faixa pode até aparecer lá, mas não é testada).
- Configurar o mod por tela própria: usa as opções de mod do Claude Code.

**Anti-objetivos (seria fracasso mesmo funcionando)**
- A orbe engasgar, ou a primeira frase demorar visivelmente mais que no Smith.
- O Claude ouvir a própria voz e responder a si mesmo.
- Qualquer ligação com o Atlas: nenhum import, rota, arquivo de config ou processo do Atlas. Código é **copiado e adaptado**, nunca referenciado.

## 3. Restrições conhecidas

- O módulo de hooks do mod roda isolado: **sem DOM, sem Node, sem microfone, sem WebGL**. Tem `$.process.spawn` (inicia processo e lê stdout em fluxo; stdin só uma vez, fechado depois), `$.http.fetch` (inclusive para `http://127.0.0.1`), `$.prompt.submit`, `$.turn.abort`, eventos `turn.step` (resposta em fluxo), `turn.complete`, `tool.call`, `classic.PermissionRequest`, `prompt.compose`, `ui.render` (`AbovePrompt`), `$.command.register`, `$.model.complete`, `$.ui.status/toast`, opções `userConfig` (com campos sensíveis).
- O mod **não serve HTTP** nem abre janela → precisa de um **processo auxiliar**.
- A máquina-alvo pode **não ter Python** → o auxiliar vai empacotado como `.exe` autocontido.
- Windows 10/11 traz o Edge (Chromium) e o WebView2.

## 4. Arquitetura

```
┌──────────── Claude Code (desktop) ────────────┐
│ mod "modo-conversa" (hooks/register.tsx)       │
│  - faixa/botão, /conversa, status              │
│  - turn.step → frases → helper /cmd speak      │
│  - tool.call → confirmação falada              │
│  - PermissionRequest → pergunta falada         │
│  - stdout do helper → prompt.submit / abort    │
└───────▲───────────────────────────┬────────────┘
  stdout (linhas JSON)        HTTP POST 127.0.0.1:PORT/cmd (token)
┌───────┴───────────────────────────▼────────────┐
│ conversa-helper.exe (Python empacotado)        │
│  - servidor HTTP local (stdlib)                │
│  - /tts e /stt: provedores (edge-tts, OpenAI,  │
│    ElevenLabs) com chaves vindas do mod (env)  │
│  - SSE /events → página                        │
│  - abre o Edge em modo app e deixa topmost     │
└───────▲───────────────────────────┬────────────┘
   HTTP (fetch/POST)             SSE
┌───────┴───────────────────────────▼────────────┐
│ janelinha: Edge --app=http://127.0.0.1:PORT/   │
│  - orb.js + three.module.min.js (cópias)       │
│  - voice.js portado: mic, VAD, eco, "para",    │
│    loopback/AEC, fila de reprodução            │
└────────────────────────────────────────────────┘
```

### 4.1 Por que Edge em modo app em vez de pywebview *(minha escolha)*
O Edge real tem **Web Speech API** (reconhecimento sem chave), WebGL, `getUserMedia` com AEC e WebRTC (necessário ao `createLoopback` do Smith) — exatamente o ambiente em que o `voice.js` já funciona. O WebView2 não oferece `webkitSpeechRecognition` de forma confiável. O auxiliar inicia:

```
msedge.exe --app=http://127.0.0.1:<PORT>/?t=<TOKEN>
  --user-data-dir=%LOCALAPPDATA%\claude-modo-conversa\edge
  --window-size=340,420 --window-position=<canto inferior direito>
  --disable-background-timer-throttling --disable-renderer-backgrounding
  --disable-backgrounding-occluded-windows --no-first-run --no-default-browser-check
```

Depois localiza a janela (título fixo "Modo conversa", via `EnumWindows` pelo PID/título com `ctypes`) e aplica `SetWindowPos(HWND_TOPMOST)`. Perfil próprio do Edge mantém a permissão de microfone concedida uma vez. Porta **fixa** 47811 (ver seção 10) para a origem — e portanto a permissão do mic — ser estável.

Risco a validar primeiro (spike, tarefa 1 do plano): Web Speech no Edge `--app` com perfil próprio; topmost; mic sem throttling com a janela em segundo plano. Se o Web Speech falhar, o padrão de STT passa a OpenAI e o mod pede a chave na primeira ativação.

### 4.2 Protocolo mod ↔ auxiliar
- O mod inicia: `$.process.spawn({ argv: [helperExe, "--port", "47811"], env: { CONVERSA_TOKEN, CONVERSA_CONFIG(json), OPENAI_API_KEY?, ELEVENLABS_API_KEY? } })`. Token aleatório por ativação.
- **Auxiliar → mod**: uma linha JSON por evento no stdout (o mod remonta linhas a partir dos pedaços):
  - `{"type":"ready","port":47811}`
  - `{"type":"utterance","text":"..."}` — fala final, já limpa (`clean_transcript`)
  - `{"type":"stop"}` — comando de parar reconhecido
  - `{"type":"approval","id":"...","decision":"allow"|"deny"|"other","utterance":"..."}` — resposta falada ou clique
  - `{"type":"closed"}` — janela fechada pelo usuário (o mod desliga o modo)
  - `{"type":"error","message":"..."}`
- **Mod → auxiliar**: `POST http://127.0.0.1:PORT/cmd` com header `X-Conversa-Token`, corpo JSON:
  - `{"type":"state","state":"listening|thinking|speaking|error"}`
  - `{"type":"speak","turn":"<id>","chunks":["..."],"final":false}` — enfileira blocos (o auxiliar repassa à página)
  - `{"type":"flush"}` — esvazia fila e para fala (ex.: usuário mandou parar)
  - `{"type":"approval","id":"...","question":"..."}` / `{"type":"approval-done","id":"..."}`
  - `{"type":"caption","text":"..."}`
  - `{"type":"quit"}`
- **Página ↔ auxiliar**: `GET /events` (SSE) recebe os comandos acima; `POST /stt` (multipart áudio WAV16k) → `{text}`; `POST /tts` `{text}` → `audio/mpeg` (204 se vazio); `POST /event` envia `utterance/stop/approval/closed` que o auxiliar ecoa no stdout. Toda rota exige o token (query `t` na página, guardado em memória) e o auxiliar só escuta em 127.0.0.1.
- Encerramento: `quit`, fim do processo do Claude ou fechamento da janela → auxiliar fecha o Edge que ele abriu e sai. O mod, ao descarregar, mata o processo (comportamento do `spawn`).

## 5. Comportamento

### 5.1 Ligar / desligar
- Faixa acima do prompt: botão **"🎙 Modo conversa"**; ligado, mostra **"● Conversa ligada — Desligar"** e o estado atual (ouvindo/pensando/falando). `/conversa` alterna. `$.ui.status` mostra "🎙 ouvindo" etc. enquanto ligado.
- Ligar: inicia o auxiliar, espera `ready` (timeout 10 s → toast de erro com o motivo), estado `listening`.
- Desligar: `quit`, limpa fila, status apagado.

### 5.2 Estados (iguais ao Smith)
`off | listening | thinking | speaking | error`. A página mantém o estado de áudio (como `voice.js`); o mod informa `thinking` ao enviar prompt e ao começar um turno, e volta a `listening` ao fim do turno se não houver fala na fila. Erro de turno → `error` e, após 2 s, fala "Tive um problema ao processar."

### 5.3 Ouvir (porta de `voice.js`)
- `getUserMedia({echoCancellation:true, noiseSuppression:true, autoGainControl:false})`.
- STT `browser` (padrão, Web Speech do Edge, `pt-BR`, `continuous`, `interimResults`, flush após `silenceMs`) ou `openai`/`elevenlabs` (VAD próprio: piso pela média dos 30 primeiros frames, limiar `(floor*3+0.02)×boost`, 300 ms para "ouvido", 200 ms enquanto fala, corte em `silenceMs` ou 15 s; WAV PCM16 mono 16 kHz via `toWav16k`; POST `/stt`).
- O laço de VAD **não pode depender de `requestAnimationFrame`** (janela em segundo plano): usar `setInterval` de ~20 ms ou `AudioWorklet`. A orbe pode usar rAF.
- Gate de proximidade (`isNearVoice`, `learnLevel`, proximity 45) mantido, `localStorage` com chave própria `conversa_voice_levels_*`.
- Eco: `isEcho` (≥60% das palavras no que foi falado), `echoPool`, `rememberEcho` (silence_ms+1500), `isLateEcho`; `createLoopback` com `tuneOpus` para o AEC tratar a fala como chamada.
- Utterance aceita durante `thinking`/`speaking` que não é eco nem stop: guardada e enviada como próximo prompt **ao fim do turno** (o mod mantém a fila) — caption "guardei: …".
- Remover o filler "smith" das listas; acrescentar "claude".

### 5.4 Parar e barge-in
- `isStopCommand` / `stopInPartial` / `isDuplicateStop` como no Smith (palavras de parar `pare, para, parar, stop, chega, silencio, cala`; fillers sem "smith", com "claude").
- Stop durante fala → `skipCurrent`/`stopPlayback` na página e evento `stop`. O mod, ao receber `stop`: `flush` e, **se houver turno em andamento, `$.turn.abort`** *(minha escolha: "para" no Claude Code significa parar o trabalho também)*. Caption "parei".
- Detector rápido de "para" (Web Speech, silenceMs 800) ligado durante a reprodução também quando o STT principal é por servidor, como no Smith.

### 5.5 Falar a resposta
- O mod observa `turn.step` (pedaços de texto do modelo) e acumula o texto do bloco de texto corrente; a cada fronteira de frase (`(?<=[.!?…])\s+`) aplica `speakable` e `chunk_sentences` (primeiro bloco 1 frase, depois até 2 frases/300 caracteres) e envia `speak` com os blocos novos. Pedaços de pensamento e de ferramenta não são falados.
- Texto **antes de uma chamada de ferramenta** (ex.: "Vou olhar o arquivo X.") é falado normalmente — é a confirmação natural do Claude.
- **Resposta longa** *(minha escolha, adaptando `spoken.py`)*: a fala em fluxo vai até ~350 caracteres falados no bloco final; o restante não é falado em fluxo. Ao `turn.complete`, se sobrou texto não falado, o mod pede a `$.model.complete` (modelo `claude-haiku-5-5`, timeout 15 s) um resumo do restante em até 2 frases/40 palavras e fala "Resumindo: … O detalhe está na tela." Se o resumo falhar, fala só "O detalhe está na tela."
- `speakable` (porta de `text.py`): JSON inteiro → "Mostrei os dados na tela."; bloco de código → "Deixei um trecho de código na tela."; tabela → "Mostrei uma tabela na tela."; remove `#`, `>`, bullets, numeração, ênfases; `[txt](url)` → `txt`; URL nua → "o link na tela"; caminhos de arquivo longos `a/b/c/arquivo.ext` → "arquivo.ext" *(minha escolha)*; inline code `` `x` `` → `x`; linha sem pontuação ganha "."; espaços colapsados.
- A página reproduz a fila como `voice.js`: prefetch do próximo bloco, `playId` invalida reproduções antigas, falha do TTS cai no `speechSynthesis` do Edge para o resto.
- **Instrução de estilo**: enquanto o modo está ligado, `prompt.compose` acrescenta uma seção de sessão: "O usuário está conversando por voz. Comece com uma frase curta que responda ou diga o que vai fazer. Prefira frases curtas, sem tabelas, e deixe detalhes técnicos no texto depois de um resumo falado." *(minha escolha)*. Removida ao desligar.

### 5.6 Confirmações e espera longa
- `tool.call` com modo ligado: se nada foi falado nos últimos 4 s e não há fala tocando, fala uma frase curta por tipo: Bash/PowerShell "Vou rodar um comando."; Read/Grep/Glob "Vou olhar os arquivos."; Edit/Write "Vou editar o arquivo."; WebSearch/WebFetch "Vou pesquisar."; Agent "Vou delegar uma parte."; MCP "Vou consultar {servidor}."; outros "Um momento." No máximo uma a cada 15 s *(minha escolha)*.
- Espera longa: 12 s após a última fala/estado com turno ainda ativo e sem aprovação pendente → "Ainda estou nisso." (repete no máximo a cada 30 s).

### 5.7 Aprovação por voz e clique
- `classic.PermissionRequest` com modo ligado: monta pergunta curta ("Posso rodar um comando: git status?", "Posso editar config.py?", "Posso usar {ferramenta}?" — comando cortado em 60 caracteres), envia `approval` à página (que mostra **Permitir/Negar** e fala a pergunta) e aguarda até **20 s** *(minha escolha)*.
- Decisão local na página: porta de `approvalDecision` + `classify_consent` (`consent.py`): NÃO (`nao, cancela, cancelar, pare, negado, nao pode`) tem prioridade; SIM exige cláusulas de sim (`sim, pode, pode seguir, pode rodar, autorizo, confirmo, manda ver`…); pergunta → outro; "other" na 1ª vez repete a pergunta uma vez.
- Resultado `allow` → hook responde allow; `deny` → deny com mensagem "Negado por voz."; timeout/`other` duas vezes/desligar → `next(e)` (a caixa normal do Claude decide). Ao concluir, `approval-done`.
- Risco a validar no spike: se a caixa normal só aparece depois que o hook retorna. Se for assim, o timeout de 20 s é o preço; se a caixa aparece em paralelo, um clique nela deve cancelar a espera (o mod observa o fim da chamada de ferramenta e manda `approval-done`).

## 6. Configuração (opções do mod, `userConfig`)
| Opção | Padrão | Notas |
|---|---|---|
| `sttProvider` | `browser` | `browser`, `openai`, `elevenlabs` |
| `ttsProvider` | `edge` | `edge`, `openai`, `elevenlabs`, `browser` |
| `ttsVoice` | `pt-BR-AntonioNeural` | OpenAI `onyx`, ElevenLabs `pNInz6obpgDQGcFmaJgB` como padrões por provedor |
| `ttsRate` | `+0%` | |
| `silenceMs` | 1200 | 300–5000 |
| `proximity` | 45 | 0–90 |
| `openaiApiKey` | — | sensível |
| `elevenlabsApiKey` | — | sensível |
| `sttPrompt` | glossário curto genérico de programação | até 1000 caracteres |

Chaves vão ao auxiliar só por variável de ambiente; nunca para a página nem para log. Provedor pago que falha cai para Edge TTS (como `VoiceService.speak`) com aviso único na legenda.

## 7. Estrutura do repositório *(minha escolha)*
```
claude-modo-conversa/
  .claude-plugin/plugin.json, marketplace.json
  hooks/hooks.json, hooks/register.tsx, hooks/*.ts (speech, chunker, approvals)
  types/index.d.ts
  hooks/*.test.ts
  helper/ (Python: server.py, providers/, text.py, consent.py, window.py, web/)
  helper/web/ (index.html, voice.js portado, orb.js, vendor/three.module.min.js, style.css)
  helper/tests/ (pytest)
  bin/conversa-helper.exe (gerado por PyInstaller; versionado no repositório)
  scripts/build-helper.ps1
  docs/
```
Desenvolvimento: se `bin/conversa-helper.exe` não existir e houver Python, o mod roda `python helper/server.py` (modo dev). Dependências Python do auxiliar: `httpx`, `edge-tts` (só); servidor HTTP da stdlib (`http.server` com `ThreadingHTTPServer`).

## 8. Código de origem (copiar e adaptar, sem vínculo)
Do projeto Atlas: `orchestrator/static/orb.js`, `static/vendor/three.module.min.js`, funções de `static/voice.js` (1–381 e fila/reprodução 849–999, activate/deactivate), CSS do palco de `index.html` (267–278), `voice/base.py`, `voice/text.py`, `voice/stt_openai.py`, `voice/stt_elevenlabs.py`, `voice/tts_edge.py`, `voice/tts_openai.py`, `voice/tts_elevenlabs.py`, `orchestrator/consent.py`. Remover tudo de `window.atlas`, auth, secretstore, yaml, persona "Smith".

## 9. Testes e verificação
- `claude plugin validate`, `tsc -p`, `claude plugin test` (chunker, speakable em TS, fila de prompts, aprovação, stop→abort, protocolo de linhas) nas superfícies `desktop` e `terminal`.
- `pytest` no auxiliar: text/consent, rotas com token, provedores com transporte falso.
- Testes JS puros das funções portadas (eco, stop, consent) rodando em Node se disponível no build; senão em pytest via mesma tabela de casos do Python.
- Verificação manual final (pelo dono): ligar, falar, ouvir, interromper, aprovar.

## 10. Decisões tomadas após a revisão
- **Máquina-alvo inclui Windows corporativo gerenciado** (a do dono é Windows 10 Enterprise). O spike roda já com o **exe empacotado** pelo PyInstaller, não só com Python; se AppLocker/SmartScreen/política do Edge bloquear, registrar e avaliar plano B (auxiliar em PowerShell/.NET) antes de seguir. *(minha escolha)*
- **Uma sessão por vez** *(minha escolha)*: o modo é por sessão do Claude Code. Ao ligar, o mod consulta `GET http://127.0.0.1:47811/ping` (sem token, responde só `{"app":"modo-conversa","busy":true}`); se outro auxiliar responde, mostra toast "O modo conversa já está ligado em outra sessão." e não liga. Porta única 47811 (sem faixa); ocupada por outro programa → erro claro. A fala, aprovações e "para" vão sempre para a sessão dona do auxiliar.
- **Distribuição**: repositório local, sem remoto, uso do dono, como o beta do Atlas. Publicar exigirá revisar a origem do código copiado. *(minha escolha)*
- **Falar por cima sem "para"** segue o Smith: a fala atual continua e a frase vai para a fila ("guardei: …"), enviada ao fim do turno. Só o comando de parar corta. (Resolvido pelo comportamento existente.)
- **Origem da cópia**: HEAD do Atlas em 811f003; os trechos são localizados **pelo nome da função**, não pelo número de linha.

## 11. Deixado ao construtor
Nomes internos, divisão de arquivos do mod, layout exato da janelinha (seguir o palco do Smith), formato de logs de depuração, detalhes do script de build.
