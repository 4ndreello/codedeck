# Setup Picker

**Substitui**: o wizard de linha única de `.specs/features/codedeck-open/spec.md`, seção "P2: Config de modelo por agente". Os requisitos OPEN-21 a OPEN-25 continuam valendo; esta spec troca a interface que os cumpre.

**Status**: Spec, não implementado.

## Problema

O wizard atual desenha uma tela com todos os harnesses instalados e seus modelos numerados, respondida por uma linha. Rodando na máquina do usuário, com quatro harnesses, isso deu ~50 linhas ilegíveis:

| agente | providers | modelos |
| - | - | - |
| claude | 1 | 14 |
| codex | 1 | 5 |
| opencode | 6 | 614 |
| omp | 7 | 829 |

Três defeitos concretos:

1. A tela achata os providers, que já vêm agrupados em `HarnessModels.providers`. A shortlist de 16 do `omp` é 100% `amazon-bedrock/*` por acidente alfabético.
2. O corte em 16 (`MAX_LISTED`) esconde 813 modelos atrás de `+813 more`.
3. A tela não comunica que responder é opcional. O usuário leu como obrigatório escolher os quatro, quando Enter já pegava todos os defaults.

**Não é** falta de paginação. Mesmo dentro de um provider só, `openrouter` no omp tem 509 modelos. O que funciona em 509 itens é filtrar, não folhear.

---

## P1: Picker interativo por agente

**User Story**: As a dev com quatro harnesses instalados, I want escolher o modelo de cada um numa tela navegável e filtrável so that eu não precise ler 50 linhas nem decorar números.

**Why P1**: É a única parte. Sem ela a config de modelo continua sendo a tela que motivou esta spec.

**Escopo**: uma sessão de raw mode atravessando todas as telas. O `codedeck open` continua abrindo só Claude Code; a config serve principalmente o `codedeck run`.

**Dono único**: `runModelSetupWizard` é o único dono de raw mode, dos listeners e da limpeza. Funções por agente não instalam nem removem nada. Sem essa regra, `SETUP-02`, `SETUP-22` e `SETUP-30` se contradizem sobre quem restaura o quê.

**Ordem obrigatória de partida** (uma etapa depende da anterior, e a ordem não é dedutível da ordem das seções): validar TTY em ambos os streams; anunciar a descoberta; descobrir **sem** raw mode ligado; ler dimensões; sair se o terminal tiver menos de 8 linhas; instalar os handlers de saída e de SIGTERM; ligar raw mode; instalar o listener de resize; rodar as telas; persistir.

**Acceptance Criteria** (each line is one EARS pattern):

1. The wizard SHALL mostrar uma tela por harness instalado (`available: true`), com contador `agente N de M` <!-- ubiquitous --> `SETUP-01`
1b. The wizard SHALL exigir que **stdin e stdout** sejam TTY, não só stdout. Isso corrige a redação de OPEN-22 #2, que fala só de stdout: um stdin em pipe deixa a leitura esperando entrada que nunca chega <!-- ubiquitous --> `SETUP-01`
2. The wizard SHALL adquirir raw mode uma única vez pra todas as telas e soltá-lo num único `finally`, nunca por tela <!-- ubiquitous --> `SETUP-02`
3. WHEN o filtro está vazio THEN a tela SHALL agrupar os modelos por provider, na ordem em que o harness os reportou, com cabeçalho nomeando o provider e sua contagem <!-- event-driven --> `SETUP-03`
4. WHEN o usuário digita THEN a lista SHALL refiltrar a cada tecla, os cabeçalhos de provider SHALL sumir, cada linha SHALL ganhar seu provider à direita, e o rodapé SHALL mostrar `<achados> de <total>` <!-- event-driven --> `SETUP-04`
5. The filtro SHALL casar substring case-insensitive contra os mesmos campos que `filterHarnessModels` casa (id, name, provider, aliases), pra não divergir de `codedeck models --search` <!-- ubiquitous --> `SETUP-04`
6. The lista SHALL rolar dentro do viewport sem cortar itens, e não SHALL exibir mensagem de "mais N" <!-- ubiquitous --> `SETUP-05`
7. The viewport SHALL ser `altura - chrome`, onde chrome é a soma das linhas fixas de fato desenhadas naquele frame (logo quando presente, cabeçalho, linha de erro quando presente, filtro, rodapé), calculada e não constante <!-- ubiquitous --> `SETUP-05`
8. The `<total>` do rodapé SHALL contar ids canônicos após deduplicação, como `getModelIds` já faz, não registros de provider, que podem repetir o mesmo id <!-- ubiquitous --> `SETUP-05`

**Independent Test**: Dirigir o picker por `PassThrough` com `isTTY: true` e `setRawMode` no-op, com um harness de 614 modelos em 6 providers; conferir que o primeiro frame tem 6 cabeçalhos, que digitar `sonnet` remove os cabeçalhos e o rodapé vira `<n> de 614`, e que nenhum frame contém `more`.

---

## P1: Teclas

**User Story**: As a dev, I want teclas que respondem na hora e nunca escolhem por mim so that eu confie no que apertei.

**Why P1**: Duas teclas do desenho original são inseguras sob raw mode, provado por probe. Sem isso o picker escolhe modelo sozinho.

**Acceptance Criteria**:

1. The picker SHALL mover o cursor com seta cima e seta baixo, filtrar com caractere imprimível, e apagar do filtro com Backspace <!-- ubiquitous --> `SETUP-10`
2. WHEN o usuário aperta Enter THEN o picker SHALL escolher o item destacado <!-- event-driven --> `SETUP-10`
3. WHEN o usuário aperta Ctrl+G THEN o picker SHALL pular o agente sem gravar nada pra ele <!-- event-driven --> `SETUP-11`
4. The picker SHALL NOT tratar Esc como pular, e uma sequência de escape fragmentada SHALL NOT disparar pulo <!-- unwanted-behavior --> `SETUP-11`
5. WHEN o usuário aperta Ctrl+C THEN o picker SHALL abortar tudo sem gravar nada, tratando `key.ctrl && key.name === "c"` explicitamente, porque raw mode não gera SIGINT <!-- event-driven --> `SETUP-12`
6. WHEN chega `paste-start` THEN o picker SHALL bufferizar até `paste-end`, e durante o paste Enter, Ctrl+G e setas SHALL NOT executar; só o texto entra no filtro, com CR/LF normalizados <!-- event-driven --> `SETUP-13`
7. WHEN o picker termina THEN ele SHALL desligar bracketed paste na limpeza <!-- event-driven --> `SETUP-13`

**Independent Test**: Empurrar pelo stdin falso, em sequência: `\x1b[A` (sobe), `s` `o` `n` (filtra), `\x07` (pula). Conferir resultado `skipped`. Depois, num segundo picker, empurrar `\x1b[200~alpha\nbeta\x1b[201~` e conferir que o filtro virou `alphabeta` e que nada foi escolhido.

---

## P1: Render

**User Story**: As a dev num terminal estreito, I want a tela redesenhada limpa a cada tecla so that eu não veja restos do frame anterior.

**Why P1**: Ids chegam a 55 caracteres. Sem truncar, o redraw deixa lixo, provado por probe.

**Acceptance Criteria**:

1. The renderer SHALL truncar cada linha à largura disponível antes de escrever <!-- ubiquitous --> `SETUP-20`
2. The renderer SHALL medir largura depois de remover códigos ANSI, nunca por `string.length` <!-- ubiquitous --> `SETUP-20`
3. The picker SHALL guardar a altura física do frame anterior e limpar todas as suas linhas antes de escrever o novo, porque um frame filtrado pode ser menor que o anterior <!-- ubiquitous --> `SETUP-21`
4. The picker SHALL emitir cada frame numa única escrita <!-- ubiquitous --> `SETUP-21`
5. The orquestrador SHALL instalar um único listener de `resize` e removê-lo no `finally`; ao disparar, ele SHALL recalcular dimensões e viewport e redesenhar o frame atual <!-- ubiquitous --> `SETUP-22`
6. The orquestrador SHALL ler as dimensões de `process.stdout` e passar um snapshot `{ rows, columns }` pra UI, tratando `0` e `undefined` como ausência e caindo em 24 linhas por 80 colunas. Um pty sem winsize reporta `0`, então testar só por `undefined` não basta <!-- ubiquitous --> `SETUP-23`
7. IF o terminal tem menos de 15 linhas THEN o wizard SHALL omitir o logo <!-- unwanted-behavior --> `SETUP-23`
8. IF o terminal tem menos de 8 linhas THEN o wizard SHALL avisar que o terminal é curto demais e sair sem gravar nada <!-- unwanted-behavior --> `SETUP-23`
9. The `ui.ts` SHALL permanecer puro: recebe o snapshot de dimensões e um conjunto de cores como argumento, e não lê `process.stdout` nem `process.env`. Com cor desligada, cada função SHALL devolver texto sem nenhum código ANSI, que é o que torna a asserção de largura dos testes possível <!-- ubiquitous --> `SETUP-24`

**Independent Test**: Renderizar um frame com id de 55 caracteres a 20 colunas e conferir que nenhuma linha do frame excede 20 células visíveis. Depois renderizar um frame de 5 linhas seguido de um de 2 e conferir que a saída limpa 5 linhas físicas.

---

## P1: Restauração do terminal

**User Story**: As a dev, I want meu terminal funcionando depois que o wizard sai so that eu não precise rodar `stty sane`.

**Why P1**: Raw mode preso é o dano mais visível que esta feature pode causar.

**Acceptance Criteria**:

1. The picker SHALL restaurar o modo do terminal num `finally` <!-- ubiquitous --> `SETUP-30`
2. The picker SHALL registrar um handler de `exit` que restaura, cobrindo exceção não capturada e `process.exit()` <!-- ubiquitous --> `SETUP-30`
3. The picker SHALL registrar um handler síncrono e idempotente de SIGTERM **antes** de ligar raw mode, que restaura e encerra explicitamente <!-- ubiquitous --> `SETUP-31`
4. IF o processo recebe SIGKILL THEN o terminal fica em raw mode e isso SHALL estar documentado como limite, sem tentativa de correção interna <!-- unwanted-behavior --> `SETUP-31`

**Independent Test**: Rodar sob `script -qec` e enviar SIGTERM no meio de um prompt; conferir por `stty -a` que `icanon` e `echo` voltaram, e que a restauração veio do handler e não do Node (logar de dentro do handler).

---

## P2: Escolha, gravação e catálogo vazio

**User Story**: As a dev que já configurou uma vez, I want pular um agente sem perder o que eu tinha escolhido antes so that o wizard não desfaça meu trabalho.

**Why P2**: Depende do picker existir, mas é onde a semântica erra silenciosamente.

**Acceptance Criteria**:

1. WHEN o wizard grava THEN ele SHALL preservar todos os campos de topo da config, `defaultModel` inclusive, partir de `config.models ?? {}` e sobrescrever só o que foi escolhido; pular SHALL deixar intacto o que já estava lá, nunca remover <!-- event-driven --> `SETUP-40`
2. WHEN todos foram pulados E ao menos uma tela foi mostrada E `config.models` estava ausente THEN o CodeDeck SHALL gravar `models: {}` pra não perguntar de novo <!-- event-driven --> `SETUP-41`
3. IF `config.models` já existia THEN pular todos SHALL deixá-la exatamente como estava, porque gravar `{}` ali apagaria escolhas anteriores <!-- unwanted-behavior --> `SETUP-41`
4. IF nenhuma tela foi mostrada (descoberta falhou, ou nada instalado) THEN o CodeDeck SHALL NOT gravar nada, preservando a única pergunta que o usuário recebe <!-- unwanted-behavior --> `SETUP-41`
5. WHEN existe `config.models[agent]` THEN essa linha SHALL ser fixada acima de todos os cabeçalhos de provider, marcada `atual`, com o cursor nela. A linha fixa fica **fora** do agrupamento, então ela não contradiz a ordem de provider de `SETUP-03` <!-- event-driven --> `SETUP-42`
6. WHEN não existe config E o harness declara um `isDefault` real (hoje claude e codex) THEN essa linha SHALL ser fixada do mesmo jeito, marcada `padrao` <!-- event-driven --> `SETUP-42`
7. IF nem config nem `isDefault` existem (hoje omp e opencode) THEN nada SHALL ser fixado nem marcado, e o cursor SHALL começar na linha 1, porque `ids[0]` é acidente alfabético e chamá-lo de padrão seria mentira <!-- unwanted-behavior --> `SETUP-42`
8. WHEN um harness volta com zero modelos THEN a tela SHALL abrir em modo filtro com uma linha sintética `usar "<texto>" como id` como única linha, e Enter SHALL ser no-op enquanto o filtro estiver vazio <!-- event-driven --> `SETUP-43`
9. WHEN o filtro não casa nada num harness com modelos THEN a mesma linha sintética SHALL aparecer <!-- event-driven --> `SETUP-43`
10. IF `harness.error` está presente E `available` é `true` THEN a tela SHALL exibi-lo no cabeçalho, porque `available: true` com `providers: []` é hoje indistinguível de "não tem modelo". Harness não instalado não ganha tela, então o `error` dele não é exibido em lugar nenhum <!-- unwanted-behavior --> `SETUP-44`
11. WHEN o usuário aperta Enter na linha sintética THEN o CodeDeck SHALL validar o texto contra `modelNames(harness)`; casando, grava direto <!-- event-driven --> `SETUP-45`
12. IF o texto não casa THEN a tela SHALL trocar o rodapé por `"<texto>" não está no catálogo. Enter de novo pra gravar assim mesmo, Ctrl+G pra voltar`, e só o **segundo** Enter consecutivo SHALL gravar. Qualquer outra tecla SHALL cancelar a confirmação <!-- unwanted-behavior --> `SETUP-45`
13. IF um id inválido pro claude fosse gravado sem confirmação THEN todo `codedeck open` seguinte falharia duro, porque `judgeModel` devolve `rejected`, `preflightModel` dá `throw` e `needsModelSetup` nunca mais pergunta <!-- unwanted-behavior --> `SETUP-45`
14. WHEN o `open` roda E `config.models.claude` existe E o preflight o rejeita THEN o CodeDeck SHALL dizer que o modelo salvo saiu do catálogo e mandar rodar `codedeck setup`, em vez de só falhar. Um modelo pode sumir do catálogo sozinho, sem ninguém ter digitado errado <!-- event-driven --> `SETUP-46`
15. The gravação SHALL ser last-writer-wins, sem lock. Duas execuções simultâneas de `setup` são raras e o custo de um lock não se paga; a regra fica escrita pra não virar surpresa <!-- ubiquitous --> `SETUP-47`

**Independent Test**: Com `RUN_AGENT_CONFIG_DIR` isolado e `{ defaultModel: "legacy", models: { codex: "gpt-x" } }` pré-gravado, rodar o wizard e pular todos; conferir que `codex` continua `gpt-x` e `defaultModel` continua `legacy`. Depois, com descoberta devolvendo `[]` pra todos, conferir que nada foi gravado.

---

## P2: Comando e latência

**User Story**: As a dev que acabou de instalar um harness, I want rodar `codedeck setup` e ver o harness novo so that eu não espere 4 horas de cache.

**Why P2**: Não bloqueia o picker, mas é o que faz ele responder à realidade.

**Acceptance Criteria**:

1. The `codedeck setup` SHALL aceitar `--refresh`, repassado pro `getCachedOrDiscoverModels`, porque `CACHE_TTL_MS` é 4h e um harness recém-instalado volta `available: false` <!-- ubiquitous --> `SETUP-50`
2. WHEN o wizard vai aguardar a descoberta THEN ele SHALL imprimir uma linha antes, sem spinner e sem raw mode, porque a descoberta leva até 12s e hoje fica muda <!-- event-driven --> `SETUP-51`
3. IF `codedeck setup` roda sem TTY THEN ele SHALL dizer que precisa de terminal, e essa mensagem SHALL viver na action do comando, não em `runModelSetupWizard`, porque o `open` chama a mesma função e OPEN-22 exige silêncio ali <!-- unwanted-behavior --> `SETUP-52`

**Independent Test**: Rodar `codedeck setup` com stdout redirecionado pra arquivo e conferir a mensagem e o exit code; rodar `open` no mesmo estado e conferir que nada foi impresso sobre o wizard.

---

## Sobre os Independent Test

Cada seção tem um Independent Test, seguindo a convenção de `codedeck-open/spec.md`. Ele é
**teste de fumaça da seção**, não cobertura por requisito: nenhum deles alcança todos os IDs
da sua seção. A cobertura um-a-um é trabalho do plano de implementação, que deve mapear cada
ID desta spec pra ao menos um caso de teste. Um ID sem caso no plano é um buraco no plano, não
uma licença pra deixar o requisito sem prova.

## Rastreabilidade

| ID | Requisito | Seção | Status |
| - | - | - | - |
| SETUP-01 | Uma tela por agente com contador | P1 Picker | Pending |
| SETUP-02 | Sessão única de raw mode | P1 Picker | Pending |
| SETUP-03 | Agrupamento por provider | P1 Picker | Pending |
| SETUP-04 | Filtro incremental e seus campos | P1 Picker | Pending |
| SETUP-05 | Scroll sem corte | P1 Picker | Pending |
| SETUP-10 | Navegação e escolha | P1 Teclas | Pending |
| SETUP-11 | Pular com Ctrl+G, nunca Esc | P1 Teclas | Pending |
| SETUP-12 | Ctrl+C como byte | P1 Teclas | Pending |
| SETUP-13 | Bracketed paste | P1 Teclas | Pending |
| SETUP-20 | Truncar por largura visível | P1 Render | Pending |
| SETUP-21 | Limpeza do frame anterior | P1 Render | Pending |
| SETUP-22 | Listener único de resize | P1 Render | Pending |
| SETUP-23 | Dimensões e altura mínima | P1 Render | Pending |
| SETUP-24 | `ui.ts` puro | P1 Render | Pending |
| SETUP-30 | Restauração em `finally` e `exit` | P1 Terminal | Pending |
| SETUP-31 | SIGTERM e o limite do SIGKILL | P1 Terminal | Pending |
| SETUP-40 | Gravação por merge | P2 Escolha | Pending |
| SETUP-41 | Sentinela `{}` só com tela mostrada | P2 Escolha | Pending |
| SETUP-42 | Içar e marcar só com base real | P2 Escolha | Pending |
| SETUP-43 | Linha sintética e catálogo vazio | P2 Escolha | Pending |
| SETUP-44 | `harness.error` visível | P2 Escolha | Pending |
| SETUP-45 | Validar id digitado à mão, com confirmação dupla | P2 Escolha | Pending |
| SETUP-46 | Recuperação quando o modelo salvo sai do catálogo | P2 Escolha | Pending |
| SETUP-47 | Gravação last-writer-wins, declarada | P2 Escolha | Pending |
| SETUP-50 | `--refresh` | P2 Comando | Pending |
| SETUP-51 | Aviso antes da descoberta | P2 Comando | Pending |
| SETUP-52 | Mensagem de sem-TTY no lugar certo | P2 Comando | Pending |

## Fora de escopo

- Unificar com `renderModelsTree` de `src/cli/commands/models.ts`. Aquilo é árvore estática pra scrollback, sem cursor, sem viewport, sem filtro. Um renderer parametrizado em árvore-vs-plano, cortado-vs-rolado e com-vs-sem-cursor seria pior que duas funções. Só os helpers de cor são movidos.
- Abrir sessão em codex, opencode ou omp pelo `open`. Continua fora, como já estava.
- Fuzzy matching. `levenshtein` existe em `core/models.ts` mas em 829 ids por tecla vira ruído.
- PgUp/PgDn. Nenhum requisito atrás, e o filtro instantâneo é a resposta pra listas longas.

## Limites conhecidos

- SIGKILL deixa o terminal em raw mode. Não tem correção de dentro do processo.
- `defaultModel` é cross-agent (`config.ts:23`), então pular o omp numa config legada entrega um id de Claude pro omp. `tests/config-models.test.ts:37` já afirma isso. Não é regressão desta spec.
- As medições de mecânica rodaram em Node v26.7.0. Node 24 exato ficou não verificado.
- Instalar um harness novo depois de já ter respondido o wizard **não** faz o `open` perguntar de novo: `needsModelSetup` só olha a ausência de `models`. O caminho é `codedeck setup --refresh`. É o comportamento de hoje, não regressão desta spec, mas passa a valer a pena estar escrito e testado.

## O que sai do código

`buildModelMenu`, `parseModelSelection`, `columnize`, `headingWith`, `blockWidth`, `MAX_LISTED`, e os cinco testes de `describe("runModelSetupWizard")` em `tests/setup-wizard.test.ts`, que dirigem um `readline` orientado a linha. Sobra `renderLogo`.

Seis testes atuais carregam requisito e **têm que ser portados**, não deletados. Cada um com o ID que passa a cobrir:

| teste atual | cobre | vira |
| - | - | - |
| `needsModelSetup` | OPEN-22 | `SETUP-01` |
| sem TTY, silencioso e sem descoberta | OPEN-22 #3 | `SETUP-01`, `SETUP-52` |
| falha ao salvar avisa e continua | OPEN-24 #10 | `SETUP-40` |
| guard da pergunta queimada | fix desta branch | `SETUP-41` |
| harness não instalado é omitido | OPEN-23 #4 | `SETUP-01`, `SETUP-44` |
| harness com catálogo vazio | OPEN-23 #5 | `SETUP-43` |
| default oferecido | OPEN-23 | `SETUP-42` |
| largura zero não colapsa a grade | fix desta branch | `SETUP-23` |

Dois comportamentos pequenos precisam de casa nova: o dedupe de agente repetido (`setup.ts:123-127`, defensivo contra cache de disco mesclado) e a linha `saved: ...`.
