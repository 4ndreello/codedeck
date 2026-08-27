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

Métodos: `session.create`, `session.list`, `session.get`, `session.send`, `session.stop`, `session.logs`, `session.subscribe`, `session.diff`, `daemon.status`, `doctor`.

Daemon é dono do `pid`; CLI apenas acompanha eventos — fechar terminal não mata agente (graceful `SIGTERM` → 3s → `SIGKILL`).

Persistência: `sessions` + `events(seq)` monotônico, `raw_payload` preservado.
