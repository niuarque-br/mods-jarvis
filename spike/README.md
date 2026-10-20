# Spike de plataforma — 2026-10-19

Máquina: Windows 10 Enterprise 19045, Edge 155.

| Pergunta | Resultado | Evidência |
|---|---|---|
| Edge `--app` com perfil próprio abre a página local | sim | relatório chegou em `/report` |
| `webkitSpeechRecognition` / `SpeechRecognition` | presentes | `true/true` no relatório |
| Web Speech reconhece de fato | **não testado** | exige microfone e permissão do dono |
| WebGL2, `RTCPeerConnection`, `getUserMedia`, contexto seguro em `http://127.0.0.1` | sim | todos `true` |
| Vozes pt do `speechSynthesis` em 1,5 s | lista vazia | carregam de forma assíncrona; tratar `voiceschanged` |
| `setInterval(20)` com a janela minimizada | continua (~50 Hz) | ticks 453 → 1414 com `hidden` |
| `requestAnimationFrame` com a janela minimizada | para | frames fixos em 677 |
| Janela sempre por cima | sim | `SetWindowPos(HWND_TOPMOST)` com `argtypes` corretos; `WS_EX_TOPMOST` ligado |
| Exe PyInstaller `--onefile --noconsole` roda nesta máquina | sim | sem bloqueio de AppLocker/SmartScreen; 8 MB |
| stdout do exe sem console chega pelo pipe | sim | `READY 47811` capturado |

Decisões:
- STT padrão continua `browser`; se o reconhecimento falhar no uso real, a página mostra o erro e o dono escolhe `openai` nas opções.
- VAD e detectores rodam em `setInterval`; só a orbe usa `requestAnimationFrame`.
- `SetWindowPos` precisa de `argtypes` com `HWND` (sem isso falha em 64 bits).
