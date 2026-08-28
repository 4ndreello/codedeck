# Protocolo IPC

`Unix Domain Socket` em `~/.run-agent/daemon.sock`, framing `JSON + \n`.

Request:
```json
{ "id": "a1b2", "method": "session.create", "params": { "prompt": "...", "agent": "claude" } }
```

Response:
```json
{ "id": "a1b2", "result": { "session": {...} } }
{ "id": "a1b2", "error": { "code": "SESSION_NOT_FOUND", "message": "..." } }
```

Streaming (`session.subscribe`, `session.logs --follow`):
```json
{ "type": "event", "event": { "type": "message", "sessionId": "...", "content": "...", "raw": {...} }, "id": "sess" }
{ "type": "done", "id": "sess" }
```

`session.subscribe` também encerra imediatamente quando a sessão já está em
estado terminal; quando existe, reenvia o último evento `session.completed` ou
`session.failed` antes de `done`. O comando `codedeck wait <id>` usa esse
stream para aguardar sem polling no consumidor.

`session.failed` pode incluir `failure` com `code`, `blame` (`harness`, `task`
ou `infra`) e `retryable`; agentes não precisam interpretar texto de erro.

Processos de harness são destacados e escrevem em `~/.run-agent/logs/`; se o
daemon reiniciar, ele reatacha pelo PID + identidade de início persistidos e
continua do offset salvo, sem iniciar um segundo processo.

Persistência: `sessions` + `events(seq)` monotônico, `raw_payload` preservado.
