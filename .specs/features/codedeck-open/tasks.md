# CodeDeck Open Tasks

**Spec**: `.specs/features/codedeck-open/spec.md`
**Status**: In Progress

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
| C: empacotamento e CI | orquestrador | `package.json`, `.github/workflows/**`, `README.md`, `.specs/**` |

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

## Gates

| Nível | Quando | Comando |
| ----- | ------ | ------- |
| Worker | Depois da própria fatia | `npx vitest run tests/<arquivo>.test.ts` |
| Integração | Depois do merge das fatias | `npm run build` e a suíte em batches |
| PR | Antes de abrir | build, suíte, `plugin validate --strict` |
