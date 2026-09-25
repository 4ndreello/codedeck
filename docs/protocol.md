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

## Console web (`web.ensure`)

O daemon não abre porta HTTP. Ele sobe, logo depois de iniciar, um processo filho
(`dist/web/child.js --web-child`) que serve o console inteiro: `/`, `/review`,
`/setup`, `/usage` e as rotas `/api/*`. `codedeck ui`, `review`, `setup` e
`usage --web` pedem esse filho ao daemon, abrem ou imprimem a URL e voltam para
o shell. Se o start junto com o daemon falhar, o `daemon.log` recebe
`web autostart failed: <message>` e o próximo `web.ensure` tenta de novo.

Request:
```json
{ "id": "w1", "method": "web.ensure", "params": { "host": "100.101.102.103", "preferredPort": 7777, "build": "1790000000000", "entry": "/abs/dist/web/child.js" } }
```

- `host` (opcional): endereço IP explícito, enviado por `codedeck ui --host
  <addr>`. Se diferir do filho atual, o supervisor encerra o filho e inicia
  outro nesse endereço.
- `preferredHost` (opcional): endereço resolvido de `web.host`, enviado quando
  não há `ui --host`. Ele move um filho iniciado para uma preferência ou sem
  pedido de host, mas não move um filho iniciado para um `host` explícito.
  Quando ambos os campos faltam, um filho atual é reaproveitado em qualquer
  endereço; se não houver filho, o supervisor inicia em `127.0.0.1`.
- `port` (opcional): porta explícita (`--port`). Só vale quando um filho
  precisa subir, e nunca cai para outra porta. Um filho já rodando é
  reaproveitado em qualquer porta.
- `preferredPort` (opcional): a porta preferida de quem chamou, `web.port` do
  `config.json` ou 7777. O filho escuta nela e cai numa porta efêmera com
  qualquer erro de listen. Um pedido com `preferredPort` e sem `port` reinicia
  o filho que não subiu para essa mesma porta preferida. Sem nenhum dos dois, o
  filho atual é reaproveitado.
- `build` (opcional): identidade do build do chamador, o maior `mtime` dos
  `.js` na árvore `dist/` dele.
- `entry` (opcional): caminho absoluto do `dist/web/child.js` do chamador. Sem
  ele, o daemon usa o próprio.

Response:
```json
{ "id": "w1", "result": { "baseUrl": "http://127.0.0.1:7777", "port": 7777, "token": "..." } }
```

A página abre em `<baseUrl><path>?<query>&t=<token>`. O token vira cookie
(`303` sem `t`, `Max-Age` de 365 dias, renovado a cada página servida), e toda
rota `/api/*` exige esse cookie. Uma página aberta sem token nem cookie responde
`403 Run "codedeck ui" once in a terminal to open CodeDeck in this browser.`
Uma página pedida em `localhost:<port>` responde `302` para `127.0.0.1:<port>`
quando o bind é `127.0.0.1`, `0.0.0.0` ou `::`, que anunciam a URL canônica de
loopback. O servidor não faz esse redirecionamento para outros binds específicos.
O cookie de `127.0.0.1` não vai para `localhost`.

O token fica em `~/.run-agent/web-token` (modo 0600) e vale para todo servidor
do console, inclusive o fallback no próprio processo, então um bookmark
sobrevive a restarts do filho e do daemon. Para trocar o token, apague o arquivo:
o próximo filho que subir grava um novo. O review
recebe o repositório em `?repo=<cwd>`, porque o filho não roda no cwd de quem
chamou.

Erros:

| `code` | Quando | `details` |
| --- | --- | --- |
| `WEB_LISTEN_FAILED` | a porta pedida está ocupada (o CLI imprime `Failed to listen on <host>:<port>: ...`, com IPv6 entre colchetes, e sai com 1) | `{ "port": n }` |
| `WEB_START_FAILED` | o filho morreu antes do handshake, não respondeu em 5 s ou mandou um handshake inválido | |
| `WEB_BAD_ENTRY` | `entry` não é absoluto, não termina em `/web/child.js` ou não existe | |

Ciclo de vida do filho:

- Existe no máximo um filho e no máximo um start por vez. Um pedido que chega
  durante um start espera ele terminar e decide pelos próprios parâmetros.
- Argumentos do filho: `--host <addr>` (ausente, usa `127.0.0.1`),
  `--port <n>` (explícita, sem fallback),
  `--preferred-port <n>` (fallback efêmero) ou nenhum (7777 com fallback).
- Handshake: a primeira linha do stdout do filho é `{ port, token, build }` ou
  `{ error: { message, port } }`. O stderr vai para `~/.run-agent/logs/web-child.log`.
- Se `build` ou `entry` do pedido diferem do filho atual, o daemon manda
  `SIGTERM`, espera até 3 s, manda `SIGKILL` se preciso e sobe um filho novo.
  Um pedido sem `build` reaproveita o filho atual. Sessões não são tocadas.
- Se o filho morre depois do handshake, o daemon registra
  `web child exited code=<code>` no `daemon.log` e sobe outro no próximo
  `web.ensure`. O token nunca vai para o log.
- O filho sai quando o stdin fecha (o daemon morreu) ou com `SIGTERM`. No
  shutdown, o daemon manda `SIGTERM` sem esperar.

Fallback: se `web.ensure` falhar com qualquer outro erro (por exemplo
`UNKNOWN_METHOD` de um daemon antigo ou `SERVICE_UNAVAILABLE` durante o
shutdown), ou se o daemon não subir, o comando serve as páginas no próprio
processo, como antes, e fica rodando até `SIGINT` ou `SIGTERM`.
