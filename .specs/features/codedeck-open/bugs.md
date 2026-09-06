# Bugs do `codedeck open`, sessão de 2026-09-05

Três achados de uma sessão real de `codedeck open orchestrator`, mais um pedido
de UI. Os dois primeiros se combinam num só sintoma: o orquestrador não
consegue orquestrar, e quando tenta, dispara no harness errado.

## 1. `codedeck` não existe dentro da sessão que o `open` abre

**Sintoma.** O orquestrador escreveu, em plena sessão: "codedeck não está
instalado como CLI aqui, então dispatch de worker que muda arquivo está fora".
E então se rebaixou sozinho para uma análise read-only.

**Medido.** `command -v codedeck` não devolve nada. O `bin` do pacote aponta
para `dist/cli/index.js`, e nada garante que esse bin esteja no PATH: quem roda
`node dist/cli/index.js open ...` do checkout local não tem `codedeck` em lugar
nenhum, e `npx` só coloca o shim no PATH do próprio processo `npx`.

**Por que dói tanto.** Os três prompts de papel são escritos inteiramente em
cima do binário. O `orchestrator.md` sozinho manda usar `codedeck run
--worktree`, `codedeck diff <id>`, `codedeck stop <id>` e `codedeck ps`. A
própria dica do spinner que aparece na tela diz "codedeck diff <id> shows what
a worktree session changed". Nada disso é executável na sessão em que é
prometido, e o modelo descobre isso do jeito mais caro: tentando.

**Direção.** O `launchClaude` já monta o env do filho (`sanitizeEnv`). É ali que
o PATH tem que ganhar um diretório com um `codedeck` que aponte para o mesmo
entrypoint que está rodando agora, e não para o que a PATH do usuário porventura
tenha. Lançar a versão que está rodando é a mesma regra que o `open` já segue
para o binário do Claude.

**Arquivos.** `src/cli/commands/open.ts`, `tests/open-args.test.ts`.

## 2. O orquestrador despacha papéis sem `--role`, então cai no harness padrão

**Sintoma.** O usuário só amarrou `claude` ao `orchestrator`. Mesmo assim o
orquestrador subiu um auditor em `claude`.

**Medido.** A sessão `f405 code-analysis` está no `ps` como `AGENT claude`,
`MODEL -`. O binding salvo em `~/.config/run-agent/config.json` diz
`auditor -> opencode / meta/muse-spark-1.3-contributor`.

**Causa.** O `orchestrator.md` nunca cita `--role`. Manda `codedeck run
--worktree` e mais nada. Sem `--role`, `resolveRoleBinding(undefined)` devolve
`undefined`, o `run` cai em `cfg.defaultAgent`, e `defaultAgent` é `claude`.

Uma omissão, duas perdas. O harness escolhido pelo usuário é ignorado, e o
corpo do papel (o contrato do auditor) nunca chega no worker: `--role` é o
único canal que carrega o prompt do papel para harness que não seja Claude.
O worker recebeu um briefing em prosa e nenhum contrato.

**Direção.** O contrato de despacho tem que nomear `--role` explicitamente, e a
sessão precisa saber quais bindings existem: dizer "use --role auditor" sem
dizer que auditor roda em opencode ainda deixa o modelo adivinhando quando o
usuário perguntar por quê. Vale considerar também o lado do `run`: hoje ele
aceita um despacho de papel silenciosamente degradado para o default.

**Arquivos.** `plugin/agents/orchestrator.md`, `plugin/agents/reviewer.md`,
`plugin/agents/auditor.md`, `tests/plugin-manifest.test.ts`.

## 3. A status line não reage a gasto alto

**Pedido.** O campo de custo é um número neutro em qualquer valor. Deveria
gritar quando o valor merece, algo na linha de `$4.20 <- omg thats a lot of $$`.

**Estado atual.** `costField()` já esconde abaixo de um centavo, mas acima disso
pinta tudo em `MUTED`, do primeiro centavo ao último dólar. O mesmo cinza para
$0.01 e para $12.00.

**Direção.** Faixas, do jeito que `contextField()` já faz com cor: o custo muda
de cor e ganha um comentário quando cruza um limiar. A linha é uma só e trunca
com `…`, então o comentário só pode aparecer quando o número justifica.

**Arquivos.** `plugin/statusline.sh`.

## Notas soltas da mesma sessão

- A sessão `f405` fechou com `Cost unavailable`. O driver do Claude não reportou
  custo nenhum numa run de 78 eventos.
- `doctor` marca `nativeDiff ✗ no` para o `omp`.
