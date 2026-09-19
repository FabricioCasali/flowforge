# FlowForge — regras do projeto (editor React Flow)

> Este arquivo é lei. Vale para mim e para todos os subagents. Docs e comentários
> em **PT-BR**; identificadores de código como estão.

## 1. O que está acontecendo

O FlowForge é ferramenta de trabalho **diária** de quem o usa: a pessoa desenha o problema,
clica **Analisar**, e o agente conectado responde editando os arquivos. O editor é React Flow +
elkjs (`web-next/`), portado do NEON (Context Builder,
`app/packages/canvas/src/editor/`) e servido em `/`.

O FlowForge é a **bancada viva**: evolui rápido aqui, e o Context Builder recebe o
aprendizado depois **como implementação nova** — por isso o código é **copiado**, não
compartilhado em pacote. Os dois têm liberdade de divergir. Não crie dependência
entre os repos.

**O porte terminou em 06/08/2026** (FF-001..FF-008), e a regra de ouro que o guiou
continua valendo para o que vier: o editor é uma *prancheta*, não um visualizador
bonito. Trocar edição por estética é regressão, não progresso.

O projeto é **aberto (MIT)** e é distribuído para outras pessoas. **Nada do repositório pode ter
vínculo com uma pessoa, uma máquina ou um ambiente**: nada de nome próprio em comentário ou
documento, caminho absoluto, pasta pessoal, nome de outro projeto de quem contribui, nem ferramenta
que só existe no ambiente de alguém. Isso vale para código, testes, documentos e para este arquivo.
A exceção é a atribuição legítima: o titular do copyright no `LICENSE` e a URL do repositório.
Os verificadores que precisam de diagramas reais recebem as pastas por `FLOWFORGE_VERIFY_DIRS`.

**O controle do projeto é por issues do GitHub** (decisão de projeto de 18/09/2026). O que está
por fazer, em andamento ou em discussão é uma issue em https://github.com/FabricioCasali/flowforge/issues — não existe
quadro em arquivo. Ao terminar um trabalho, feche a issue pelo commit (`Closes #N`); trabalho que
aparece no caminho vira issue nova, não comentário solto. O `docs/HISTORICO.md` é o quadro antigo,
congelado: serve para entender por que uma coisa é como é (os ids `FF-###` citados aqui e no código
moram lá), e **não recebe cards novos**.

## 2. Leis invioláveis

1. **A ferramenta de quem usa não pode parar.** _Cumprida no corte:_ o `web/` (Cytoscape)
   viveu em `/` até o `/v2` ser validado na tela, e só então saiu — com `/v2` redirecionando
   para `/` para não quebrar aba aberta nem link salvo. A lei permanece como regra de
   conduta: mudança grande entra ao lado do que funciona, e o que funciona só morre depois
   que o substituto foi usado de verdade.

2. **Arquivos são a fonte da verdade.** O servidor espelha arquivo ↔ browser via
   `fs.watch`; o agente edita os arquivos direto e a mudança chega sozinha no canvas.
   Nunca invente um canal paralelo ao arquivo.

   **Mas o FlowForge NÃO é memória.** Ele é ferramenta de *raciocínio*: serve pra tomar
   decisão e entender fluxo, e o diagrama é descartável depois que cumpriu isso. O que
   precisa sobreviver vai para a documentação de quem usa (decisão de projeto de 06/08/2026).
   Consequência prática: **não pese decisão de contrato pelo custo de migrar o passado.**
   Campo novo que nasce vazio nos diagramas existentes é aceitável — refazer um diagrama
   custa pouco, e carregar um modelo ruim pra sempre custa caro.

3. **Contrato antes de consumir.** `web-next/src/types.ts` é a barreira: modelo ou campo
   novo entra ali **antes** de qualquer componente ou do servidor consumir. É a cópia
   local do modelo — sem `@neon/shared`, sem import cruzando repo.

4. **`workspace.json` é o novo arquivo-verdade**, com os 5 modelos coexistindo:
   `{ title, process, state, er, mind, seq, rev, updatedBy }`. As 6 lentes leem esses 5 modelos —
   `process` serve Fluxograma **e** Swimlane (mesmo grafo, layout diferente).

   **O `title` é da SESSÃO e mora no topo** (issue #7): um workspace é um assunto só visto
   por 6 lentes, e renomear custa **uma** escrita e **um** `rev`. Antes o título morava
   dentro de cada modelo e a topbar gravava em todos os que tinham conteúdo. O campo é
   opcional: arquivo sem ele abre com o título derivado dos modelos (`process`, `state`,
   `er`, `mind`, nessa ordem) e **quando os dois existem o do topo manda**. O `title` de
   dentro dos modelos continua no arquivo — migração lazy não apaga nada (lei 5).

   **EXCEÇÃO À REGRA DA POSIÇÃO — sobreposição.** O editor afasta nós que se sobrepõem
   ao abrir, e **grava**. É a única coisa que move um nó sem o usuário pedir, e existe
   porque o porte causou o problema: o editor antigo desenhava caixa fixa de 162×54 e o
   novo calcula pelo conteúdo, chegando a 330×92 — as coordenadas foram preservadas
   fielmente e as caixas engordaram em cima delas, deixando 25 pares sobrepostos nos
   diagramas reais. Decidido em 06/08/2026, ciente de que perde o caso de
   dois nós colados de propósito. Regras: empurra **o mínimo** e só quem colide, é
   determinístico (mesma entrada → mesma saída), e **não roda na Swimlane** (lente
   derivada não grava posição).

   **A posição é do arquivo, e a Swimlane é lente derivada.** Quem tem `x`/`y` no
   `workspace.json` é desenhado ali; o elk só calcula quem não tem, e o que ele calcular é
   transladado para o referencial do desenho salvo. Arrastar grava a posição de **todos** os
   nós — no primeiro arrasto o layout se materializa no arquivo e a sessão reabre idêntica.
   A **Swimlane fica de fora** (`savesPos: false` em `lenses.ts`): ela divide o par `x`/`y`
   com o Fluxograma, e num fluxograma vertical todo nó tem quase o mesmo `x` — herdar isso
   empilharia a raia inteira numa coluna. Ela recalcula sempre, e arrastar lá vale só na
   sessão. Decidido em 06/08/2026; o contrato de `types.ts` ficou **inalterado**
   (nada de posição por lente). Swimlane num diagrama sem `lanes` **avisa** "sem raias
   definidas" em vez de inventar uma faixa. Prova: `node scripts/verifica-layout.mjs`.

   **`tasks.json` NÃO é o sexto modelo.** As tarefas ao vivo do CLI (FF-034) moram num arquivo
   próprio na raiz do data-dir, por PROJETO, com `rev` próprio. Decidido em
   18/09/2026: o agente escreve ali várias vezes por minuto, e dentro do workspace cada tarefa
   concluída subiria o `rev` do desenho e disputaria a escrita com o arrasto de um nó. A lente
   **Tarefas** é a única que não lê o workspace. O tipo é `TasksFile`, em `types.ts` (lei 3), com
   cópia em `server/tasks.js`; a escrita é SEMPRE pelo `adapters/tasks.js` (trava + rename atômico),
   porque mais de um agente publica no mesmo arquivo.

   **`activity.jsonl` segue a mesma regra** (FF-035): a linha do tempo do que o agente FEZ, append-only,
   na raiz do data-dir. Escrita só pelo `adapters/activity.js`. **É narração, não transcrição** — nunca
   o pedido do usuário, nunca conteúdo de arquivo nem saída de ferramenta, nunca o comando cru: é um
   arquivo dentro do projeto dos outros, e o verificador trava isso com segredos plantados nos payloads.
   A tradução de cada harness mora em `adapters/hooks/<harness>.js`; o resto é neutro.

5. **Migração é lazy e não destrutiva.** Ao abrir uma sessão que só tem `diagram.json`,
   o servidor converte para `workspace.json` **preservando o `diagram.json` como está**
   (backup). Mapa: `flowchart|bpm|swimlane` → `process` (preservando o `type` de dentro,
   que é o que mantém as formas BPM), `er` → `er`, `mindmap` → `mind`; `state` e `seq`
   nascem vazios. **Nunca** perca `x`/`y`, `comments`, `description`, `fields`, `lanes`,
   `lane`, `sourceSide`/`targetSide`, `sourceCard`/`targetCard`.

6. **O servidor é a autoridade do `rev`.** Ele incrementa a cada escrita de origem-usuário.
   O agente escreve com `rev+1` e `updatedBy:"agent"`.

7. **A trava `busy` continua valendo.** Ao despachar o "analyze" a sessão trava e o browser
   entra em modo leitura; só libera quando o adapter conclui o `requestId`. O editor novo
   precisa honrar isso (`{type:'busy'}` no WS) — senão o usuário edita por cima da escrita.

8. **As formas por `kind` são requisito, não polimento.** `annotation` (tracejado,
   esmaecido) é o 2º kind mais usado nos diagramas reais; `data-object` é canto cortado;
   `subprocess` leva `[+]`; `idea` é elipse; `event-*` são círculos de 62px com rótulo
   embaixo (o intermediate tem borda dupla); os gateways são losangos de 92px com ✕ / ✛.
   A tabela é `web-next/src/editor/shapes.ts`, e ela é UMA só de propósito: o render e o
   `nodeSize` leem dela, senão divergem em silêncio (nó com tamanho de losango e desenho
   de retângulo). O verificador confere os 15 kinds — se mexer lá, rode-o.
   _Referência histórica: `web/app.js:60-74`, no git antes do FF-008._

9. **Nada de dependência nova sem necessidade.** O stack é: Vite + React + TS +
   `@xyflow/react` + `elkjs` + `@fontsource/*` no front; `ws` e Node puro no servidor.
   Cytoscape e dagre saíram com o `web/`.

10. **A seta tem status PRÓPRIO.** A propagação nó→aresta (o consenso das duas pontas)
    só pode recalcular **as arestas do nó que acabou de receber veredito** — é o que o
    editor antigo fazia (`app.js:831`, no git antes do FF-008). Recalcular o diagrama inteiro a
    cada clique apagaria marcação de seta do outro lado do desenho, e isso não é
    hipótese: **34 das 143 arestas dos diagramas reais** têm status que a regra não
    derivaria das pontas. Elas existem porque a seta pode discordar do consenso.
    Decidido em 06/08/2026; contrato inalterado. A versão global
    (`propagateEdges`, em `types.ts`) sobrou só para proposta crua vinda de fora, onde
    não existe marcação anterior a preservar — **não a use no editor**.

11. **~~A divergência entre os dois editores é ACEITA~~ — ENCERRADA no FF-008.** Existia
    um editor antigo em `/` escrevendo `diagram.json` e o novo em `/v2` escrevendo
    `workspace.json`, e a lei mandava não "consertar" a divergência entre eles. O antigo
    saiu; sobrou **um** editor e **um** arquivo-verdade. Fica registrado porque o motivo
    ainda ensina: a divergência era real, mas o usuário nunca rodava os dois em paralelo
    — o risco era teórico e não valia código.

## 3. Protocolo (WS) — não mude sem atualizar os dois lados

Browser ↔ servidor em `/ws?session=<slug>`:
- recebe `{type:'state', session, workspace, thread, busy, agentOnline, agentLabel}`
- recebe `{type:'busy', session, busy}`
- recebe `{type:'tasks', tasks}` — o `tasks.json` do projeto (FF-034), ao conectar e a cada
  mudança do arquivo, em **toda** sessão. O browser só lê; quem escreve é `adapters/tasks.js`
- recebe `{type:'activity', events}` — o fim do `activity.jsonl` do projeto (FF-035): a linha do
  tempo do que o agente fez. Mesma regra das tarefas: por projeto, só leitura no browser
- recebe `{type:'agent', online, label}` — **duas conexões, duas luzes**. O pill de
  conexão é do browser com o servidor; este diz se existe adapter no `/agent`.
  Sem essa distinção o "Analisar" sai com a tela verde e volta "agente offline"
  (aconteceu na validação de 06/08/2026)
- envia `{type:'patch', session, lens, diagram}` — **lens-aware**: `lens` ∈
  `process|state|er|mind|seq` diz qual modelo do workspace o patch altera
- envia `{type:'rename', session, title}` — o título da **sessão** (o `title` do topo do
  workspace). Não é um patch de lente porque o título não é da lente: uma escrita, um `rev`.
  Mesma trava do patch (lei 7) — durante o `busy` é recusado, e título vazio não renomeia
- envia `{type:'analyze', session, note}`

Adapter externo em `/agent`: registra `adapterId` e `label`, recebe o evento `analyze`
com `requestId`, `workspacePath`, `threadPath`, `projectPath` e `workspaceRev`, e responde
com `accepted`, `completed` ou `failed` — e, enquanto trabalha, com `progress` (mesmo `requestId`),
que só rearma o prazo da trava. Sem adapter conectado o pedido fica no
`inbox.jsonl` e é reenviado quando um registrar. A entrega é pelo menos uma vez: queda ou
timeout mantêm a trava e reenviam o mesmo `requestId`, que o adapter deve deduplicar. Pedidos
da mesma sessão são seriais. `/claude` é alias de URL legado temporário e usa o mesmo
protocolo de `/agent`.

`/v2` responde 301 para `/` — o editor morou lá durante o porte e há links salvos.

## 4. Comandos

```
node scripts/setup.mjs                                              # prepara a instalação (deps + build), só o que falta
node server/index.js --data-dir "<projeto>/.flowforge" --port 4317   # servidor
claude --plugin-dir .                                               # carrega ESTE repo como plugin (skill + hooks) numa sessão
claude plugin validate .                                            # valida plugin.json, hooks e a skill
node adapters/live.js                                               # SESSÃO VIVA: vigie com o Monitor; responde quem já está aberto
node adapters/live.js wait                                          # o ouvinte do hook Stop (rearma a escuta sozinho); `stop` encerra a ponte
node adapters/index.js <claude-code|opencode|codex>                 # execução à parte (sem sessão aberta)
node adapters/tasks.js plan "objetivo" "tarefa" ...                  # o agente publica as tarefas dele (lente Tarefas)
node adapters/activity.js install claude-code                       # liga o hook da linha do tempo neste projeto
node scripts/verifica-opencode.mjs                                  # prova a sessão viva e a linha do tempo do OpenCode
node scripts/verifica-activity.mjs                                  # prova a linha do tempo, do hook ao browser
node scripts/verifica-codex.mjs                                     # prova o hook e a entrega na sessão aberta do Codex
node scripts/verifica-tasks.mjs                                     # prova as tarefas ao vivo, do comando ao browser
node scripts/verifica-adapter.mjs                                   # prova o núcleo do adapter (driver falso)
node scripts/verifica-wait.mjs                                      # prova o rearme automático da escuta (hook Stop)
node scripts/prova-adapter.mjs <harness>                            # loop vivo com o CLI real (gasta token)
cd web-next && npm run dev                                          # front em dev
cd web-next && npm run build                                        # bundle servido pelo server
```

## 5. Definition of Done

Nenhuma fase é "pronta" sem: build limpo, os diagramas reais abrindo sem perda
(rode a checagem contra `sessions/` e os `.flowforge/` dos projetos), e o loop vivo
provado ponta-a-ponta — clicar Analisar, o harness do usuário editar o arquivo, concluir
o `requestId` e o canvas atualizar sozinho. O adapter precisa seguir `docs/SCHEMA.md`;
instrução específica de fornecedor fica fora do núcleo do FlowForge.

**Quem responde ao Analisar é a sessão que já está aberta** (decisão de projeto, 18/09/2026): o
CLI que abriu o FlowForge tem o contexto da task, e qualquer outro respondedor gasta token para
reconstruí-lo. O caminho padrão é `adapters/live.js` vigiado pelo harness; a execução à parte
(`adapters/index.js`) é o secundário, para quando não há sessão aberta.

**Onde fica o que é de fornecedor:** em `adapters/`. `server/` e `web-next/` não sabem que
harness existe e não podem passar a saber — nada de `if (claude)` no servidor. Dentro de
`adapters/`, o `core.js` e o `prompt.js` também são neutros; só `adapters/drivers/<harness>.js`
conhece flag de CLI. Harness novo = um driver novo, e a prova dele é o `prova-adapter.mjs`.
