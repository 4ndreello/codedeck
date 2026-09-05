# CodeDeck Open Tasks

**Spec**: `.specs/features/codedeck-open/spec.md`
**Status**: Implementado, verificado ponta a ponta

## O que a integração encontrou

As fatias chegaram dentro do contrato, mas a junção expôs quatro coisas que nenhum worker conseguia ver sozinho:

| # | Achado | Onde |
| - | ------ | ---- |
| 1 | O seletor de papel decidia por `process.stdout.isTTY`. Sob um pty (CI, `script`) isso é verdadeiro, então `open -- --print` travava para sempre no "Role [general]". `isNonInteractiveLaunch` passou a olhar `-p`/`--print`, e o mesmo vale para o wizard | `src/cli/commands/open.ts` |
| 2 | O gate de tema usava `--print`, que nunca desenha TUI. Ele reprovava um tema correto. Agora abre sessão interativa sob pty, com a config isolada para o wizard não bloquear | `scripts/theme-gate.sh` |
| 3 | `secrets` não é um contexto que `if:` de step consegue ler, então o gate não decidia nada. Passou a subir para `env` no job | `.github/workflows/ci.yml` |
| 4 | O wizard gravava `models: {}` mesmo sem ter perguntado nada, queimando a única pergunta que o usuário recebe. Sem pergunta, não grava | `src/cli/commands/setup.ts` |

Menores: `rawArgs` não é tipado pelo commander (cast estreito em vez de `any`), `lastIndexOf` do nome do comando pegava a palavra errada quando o passthrough continha "open", e o aviso de modelo do `run.ts` só olhava a flag, ignorando typo vindo da config.

## Provas coletadas

- `open`, `open reviewer` e `open orchestrator` rodados via `dist/`: banner, papel e as duas regras do `ultra.md` respondidos pela própria sessão. O reviewer confirma que não edita arquivos.
- Tema quebrado de propósito por **uma letra** (`codedeck-ultraa`): sessão sobe sem erro nenhum e pinta a paleta padrão. `plugin validate --strict` **passa**; o gate falha e `tests/plugin-manifest.test.ts` falha em 2 testes. Ou seja, a armadilha é pega mesmo sem credencial no CI.
- `plugin validate --strict` roda sem credencial (verificado com `CLAUDE_CONFIG_DIR` isolado), então o job não depende de segredo.
- Suíte inteira em 5 batches: 32 arquivos, 189 testes, verde.

---

## Contrato compartilhado (fixado antes do fan-out, ninguém altera sozinho)

Estes nomes são load-bearing. Duas grafias desta lista falham **em silêncio** se erradas, sem erro e sem log, então elas são o contrato e não sugestão.

### Nome e layout do plugin

O plugin se chama `codedeck`. Layout exato:

```
plugin/
  .claude-plugin/plugin.json
  themes/codedeck-ultra.json
  agents/orchestrator.md
  agents/reviewer.md
  ultra.md
  settings.json
  statusline.sh
```

### Grafias que não podem mudar

| O quê | Valor exato | O que acontece se errar |
| ----- | ----------- | ----------------------- |
| Ref de tema no `settings.json` | `custom:codedeck:codedeck-ultra` | Sessão sobe **sem tema**, sem erro, sem log, nem com `--debug` |
| Slug do tema | O **basename do arquivo** (`codedeck-ultra`), não o campo `name` do JSON | Mesma falha muda |
| Declaração de tema no manifesto | `experimental.themes: "./themes"` | Warning de deprecação, e a forma top-level some numa versão futura |
| Ref de agente | `codedeck:orchestrator`, `codedeck:reviewer` | Nome nu resolve, mas liga no primeiro plugin em caso de colisão, sem aviso |
| Flag de system prompt | `--append-system-prompt-file` | Sem entrada própria no `--help`; erra e o commander diz `unknown option` |
| `author` no manifesto | obrigatório | `plugin validate --strict` falha com `No author information provided` |

### Interface pública de `src/cli/commands/open.ts`

Tudo puro e exportado, pra ser testável sem spawn:

```ts
export const ROLES = ["general", "orchestrator", "reviewer"] as const;
export type Role = (typeof ROLES)[number];

export interface OpenFlags {
  model?: string;
  effort?: string;
  resume?: string;
  worktree?: boolean;
  bypass?: boolean;   // default true; --no-bypass zera
  theme?: boolean;    // default true; --no-theme zera
}

export function resolvePluginDir(): string;
export function buildOpenArgs(role: Role, flags: OpenFlags, pluginDir: string, passthrough: string[]): string[];
export function parseRole(input: string | undefined): Role | undefined;
export function sanitizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function renderBanner(role: Role): string;
export function registerOpenCommand(program: Command): void;
```

---

## Propriedade de arquivo (regra dura)

Cada arquivo tem exatamente um dono. Worker que escrever fora da sua fatia tem o trabalho descartado.

| Fatia | Dono | Arquivos |
| ----- | ---- | -------- |
| A: conteúdo do plugin | worker A | `plugin/**`, `tests/plugin-manifest.test.ts` |
| B: comando CLI | worker B | `src/cli/commands/open.ts`, `src/cli/index.ts`, `tests/open-*.test.ts` |
| C: empacotamento e CI | orquestrador | `package.json`, `.github/workflows/**`, `scripts/**`, `README.md`, `.specs/**` |
| D: config por agente | worker D | `src/config/config.ts`, `src/cli/commands/setup.ts`, `src/cli/commands/run.ts`, `tests/setup-*.test.ts`, `tests/config-*.test.ts` |

O worker D **não** registra o comando em `src/cli/index.ts` nem chama o wizard de dentro do `open.ts`: os dois arquivos são do worker B. O orquestrador faz essa ligação no merge, quando B já terminou.

Nenhum worker roda `npm test` inteiro nem `npm run build`. Cada um roda só o próprio arquivo de teste: `npx vitest run tests/<seu-arquivo>.test.ts`. O build e a suíte completa rodam uma vez no fim, pelo orquestrador.

**Não adicionar Sonar em lugar nenhum.** O SonarCloud roda por Automatic Analysis, e um scanner no CI desativa isso.

---

## Fatia A: conteúdo do plugin

| # | Tarefa | AC coberto |
| - | ------ | ---------- |
| A1 | `.claude-plugin/plugin.json` com `name: codedeck`, `author`, `description`, `version` e `experimental.themes: "./themes"` | OPEN-05, OPEN-11 |
| A2 | `themes/codedeck-ultra.json` com a paleta completa de slots | OPEN-11 |
| A3 | `settings.json` declarando `theme: "custom:codedeck:codedeck-ultra"` e `statusLine` apontando pro `statusline.sh` | OPEN-11, OPEN-12 |
| A4 | `statusline.sh` lendo o JSON do stdin e imprimindo papel, modelo e branch, cada um derivado do payload ou do git, nunca fixo. Sem branch, não quebra | OPEN-12 |
| A5 | `agents/reviewer.md` com `tools` sem `Edit`, `Write` nem `Bash` | OPEN-09 |
| A6 | `agents/orchestrator.md` com `tools` sem `Edit` e sem `Write`, mantendo `Bash`. Corpo: fronteira de escrita, subagente nativo só pra leitura, despacho sempre com `--worktree`, artefato como autoridade, no máximo um ciclo corretivo, encerrar worker no fim, e aviso explícito de que o worker sobe sem o setup do CodeDeck | OPEN-13, OPEN-14, OPEN-15, OPEN-16 |
| A7 | `ultra.md`: identidade mais as duas regras invioláveis (delegação com prova, nunca arredondar pra sucesso). Curto de propósito | OPEN-02 |
| A8 | `tests/plugin-manifest.test.ts` pinando as grafias da tabela acima lendo os arquivos do disco | OPEN-06, OPEN-11 |

## Fatia B: comando CLI

| # | Tarefa | AC coberto |
| - | ------ | ---------- |
| B1 | `resolvePluginDir()` a partir de `import.meta.url`, nunca do `cwd`, resolvendo tanto rodando de `dist/` quanto do repo | OPEN-02 |
| B2 | `buildOpenArgs()` montando model, effort, bypass, plugin-dir, append-system-prompt-file, settings, agent, nome de sessão e passthrough | OPEN-02, OPEN-04, OPEN-08, OPEN-10 |
| B3 | `parseRole()` e seletor interativo em `readline` puro, com `general` pré-selecionado. Sem TTY e sem papel, assume `general` sem bloquear | OPEN-07 |
| B4 | `sanitizeEnv()` removendo `CLAUDE_CODE_CHILD_SESSION` | OPEN-03 |
| B5 | `renderBanner()` devolvendo **uma string só**, sem `sleep`, legível sem cor | OPEN-10 |
| B6 | Preflight de modelo em três estados: catálogo sem o modelo falha com sugestão de `findClosestModel`; catálogo indisponível segue com aviso; `unrecognized_model` do `claude` vira mensagem sobre direito de conta | OPEN-17, OPEN-19 |
| B7 | `client.ensureDaemonStarted()` deixando a falha propagar, como `run.ts` e `wait.ts`, e não engolindo como os outros comandos | OPEN-01 |
| B8 | Edge cases: `plugin/` ausente, `claude` fora do `PATH`, `cwd` morto, fora de repositório git | OPEN-20 |
| B9 | Registrar em `src/cli/index.ts` e testes em `tests/open-*.test.ts` | todos |

## Fatia C: empacotamento e CI

| # | Tarefa | AC coberto |
| - | ------ | ---------- |
| C1 | `build` copiando `plugin/` pra `dist/plugin` | OPEN-05 |
| C2 | Gate de `plugin validate --strict` no CI | OPEN-06 |
| C3 | Gate de tema pulado com aviso quando não houver credencial, nunca verde silencioso | OPEN-06 |
| C4 | README documentando `codedeck open` | - |

---

## Fatia D: config de modelo por agente

| # | Tarefa | AC coberto |
| - | ------ | ---------- |
| D1 | `RunAgentConfig` ganha `models?: Partial<Record<AgentId, string>>`, mantendo `defaultModel` funcionando como fallback | OPEN-21 |
| D2 | `resolveModel(agent, explicit, config)` puro e exportado, com precedência `--model` > `models[agent]` > `defaultModel` > default do driver | OPEN-25 |
| D3 | Wizard que, por harness **instalado**, oferece os modelos de `getCachedOrDiscoverModels` e aceita id digitado à mão quando a descoberta vier vazia | OPEN-23 |
| D4 | Wizard exportado como função pura de "precisa perguntar?" mais a parte interativa, pra ser testável sem TTY | OPEN-22 |
| D5 | `src/cli/commands/setup.ts` expondo `registerSetupCommand`, seguindo o padrão dos comandos existentes | OPEN-24 |
| D6 | Gravação da config, e falha de escrita vira aviso em vez de erro fatal | OPEN-24 |
| D7 | `run.ts` passa a usar `resolveModel` quando `--model` estiver ausente | OPEN-25 |
| D8 | Testes em `tests/setup-wizard.test.ts` e `tests/config-models.test.ts`, usando `RUN_AGENT_CONFIG_DIR` pra isolar o disco | OPEN-21 a OPEN-25 |

## Gates

| Nível | Quando | Comando |
| ----- | ------ | ------- |
| Worker | Depois da própria fatia | `npx vitest run tests/<arquivo>.test.ts` |
| Integração | Depois do merge das fatias | `npm run build` e a suíte em batches |
| PR | Antes de abrir | build, suíte, `plugin validate --strict` |
