# FlowForge — regras do porte (editor React Flow)

> Este arquivo é lei. Vale para mim e para todos os subagents. Docs e comentários
> em **PT-BR**; identificadores de código como estão.

## 1. O que está acontecendo

O FlowForge é a ferramenta de trabalho **diária** do Fabricio: ele desenha o problema,
clica **Analisar**, e o Claude responde editando os arquivos. O canvas de hoje
(`web/`, Cytoscape + vanilla JS) está sendo **substituído** por um editor React Flow +
elkjs, portado do NEON (`C:\desenv\particular\context_builder\app\packages\canvas\src\editor\`).

O FlowForge é a **bancada viva**: evolui rápido aqui, e o Context Builder recebe o
aprendizado depois **como implementação nova** — por isso o código é **copiado**, não
compartilhado em pacote. Os dois têm liberdade de divergir. Não crie dependência
entre os repos.

**Regra de ouro do porte:** o editor novo é um *visualizador com veredito*; o antigo é
uma *prancheta*. O porte só termina quando o novo **edita tudo** que o antigo edita.
Trocar desenho bonito por perda de edição é regressão, não progresso.

## 2. Leis invioláveis

1. **A ferramenta do Fabricio não pode parar.** O `web/` antigo continua servido em `/`
   e funcionando até o corte final. O editor novo nasce em `web-next/`, servido em `/v2`.
   Só na última fase o `/v2` vira `/` e o antigo morre.

2. **Arquivos são a fonte da verdade.** O servidor espelha arquivo ↔ browser via
   `fs.watch`; o Claude edita os arquivos direto e a mudança chega sozinha no canvas.
   Nunca invente um canal paralelo ao arquivo.

3. **Contrato antes de consumir.** `web-next/src/types.ts` é a barreira: modelo ou campo
   novo entra ali **antes** de qualquer componente ou do servidor consumir. É a cópia
   local do modelo — sem `@neon/shared`, sem import cruzando repo.

4. **`workspace.json` é o novo arquivo-verdade**, com os 5 modelos coexistindo:
   `{ process, state, er, mind, seq, rev, updatedBy }`. As 6 lentes leem esses 5 modelos —
   `process` serve Fluxograma **e** Swimlane (mesmo grafo, layout diferente).

   **A posição é do arquivo, e a Swimlane é lente derivada.** Quem tem `x`/`y` no
   `workspace.json` é desenhado ali; o elk só calcula quem não tem, e o que ele calcular é
   transladado para o referencial do desenho salvo. Arrastar grava a posição de **todos** os
   nós — no primeiro arrasto o layout se materializa no arquivo e a sessão reabre idêntica.
   A **Swimlane fica de fora** (`savesPos: false` em `lenses.ts`): ela divide o par `x`/`y`
   com o Fluxograma, e num fluxograma vertical todo nó tem quase o mesmo `x` — herdar isso
   empilharia a raia inteira numa coluna. Ela recalcula sempre, e arrastar lá vale só na
   sessão. Decidido pelo Fabricio em 06/08/2026; o contrato de `types.ts` ficou **inalterado**
   (nada de posição por lente). Swimlane num diagrama sem `lanes` **avisa** "sem raias
   definidas" em vez de inventar uma faixa. Prova: `node scripts/verifica-layout.mjs`.

5. **Migração é lazy e não destrutiva.** Ao abrir uma sessão que só tem `diagram.json`,
   o servidor converte para `workspace.json` **preservando o `diagram.json` como está**
   (backup). Mapa: `flowchart|bpm|swimlane` → `process` (preservando o `type` de dentro,
   que é o que mantém as formas BPM), `er` → `er`, `mindmap` → `mind`; `state` e `seq`
   nascem vazios. **Nunca** perca `x`/`y`, `comments`, `description`, `fields`, `lanes`,
   `lane`, `sourceSide`/`targetSide`, `sourceCard`/`targetCard`.

6. **O servidor é a autoridade do `rev`.** Ele incrementa a cada escrita de origem-usuário.
   O Claude escreve com `rev+1` e `updatedBy:"claude"` — sem isso o browser descarta.

7. **A trava `busy` continua valendo.** Ao despachar o "analyze" a sessão trava e o browser
   entra em modo leitura; só libera quando o Claude posta no `thread.json`. O editor novo
   precisa honrar isso (`{type:'busy'}` no WS) — senão o Fabricio edita por cima da escrita.

8. **As 11 formas por `kind` são requisito, não polimento.** `annotation` (tracejado, fundo
   8%) é o 2º kind mais usado nos diagramas reais; `data-object` é canto cortado;
   `subprocess` leva `[+]`; `idea` é elipse; `event-*` são círculos de 62px com label
   embaixo (o intermediate tem borda dupla); os gateways são losangos com ✕ / ✛.
   Referência exata: `web/app.js:60-74`. O `FlowNode` portado só conhece 3 famílias —
   ampliar é tarefa da fase de render.

9. **Nada de dependência nova sem necessidade.** O stack é: Vite + React + TS +
   `@xyflow/react` + `elkjs` no front; `ws` e Node puro no servidor. Cytoscape e dagre
   morrem junto com o `web/` antigo.

10. **A seta tem status PRÓPRIO.** A propagação nó→aresta (o consenso das duas pontas)
    só pode recalcular **as arestas do nó que acabou de receber veredito** — é o que o
    editor antigo faz (`app.js:831`, `propagateFrom`). Recalcular o diagrama inteiro a
    cada clique apagaria marcação de seta do outro lado do desenho, e isso não é
    hipótese: **34 das 143 arestas dos diagramas reais** têm status que a regra não
    derivaria das pontas. Elas existem porque a seta pode discordar do consenso.
    Decidido pelo Fabricio em 06/08/2026; contrato inalterado. A versão global
    (`propagateEdges`, em `types.ts`) sobrou só para proposta crua vinda de fora, onde
    não existe marcação anterior a preservar — **não a use no editor**.

11. **A divergência entre os dois editores é ACEITA — não a "conserte".** Depois da
    migração, `/` escreve em `diagram.json` e `/v2` em `workspace.json`, e os dois nunca
    mais conversam. Decidido pelo Fabricio em 05/08/2026, e o motivo é o que importa:
    **ele não vai ter os dois cenários rodando em paralelo** — usa um OU outro, não
    alterna dentro da mesma sessão. Logo o risco é teórico e não vale código.
    **Não implemente** re-sync, merge automático, tarja de aviso nem bloqueio — os três
    foram considerados e recusados. Se você achar que isso é um bug, leia esta lei de novo.

## 3. Protocolo (WS) — não mude sem atualizar os dois lados

Browser ↔ servidor em `/ws?session=<slug>`:
- recebe `{type:'state', session, workspace, thread, busy}`
- recebe `{type:'busy', session, busy}`
- envia `{type:'patch', session, lens, diagram}` — **lens-aware**: `lens` ∈
  `process|state|er|mind|seq` diz qual modelo do workspace o patch altera
- envia `{type:'analyze', session, note}`

Monitor do Claude em `/claude`: recebe o evento `analyze` com `workspacePath` e
`threadPath` absolutos.

## 4. Comandos

```
node server/index.js --data-dir "<projeto>/.flowforge" --port 4317   # servidor
cd web-next && npm run dev                                          # front em dev
cd web-next && npm run build                                        # bundle servido pelo server
```

## 5. Definition of Done

Nenhuma fase é "pronta" sem: build limpo, os **11 diagramas reais** abrindo sem perda
(rode a checagem contra `sessions/` e os `.flowforge/` dos projetos), e o loop vivo
provado ponta-a-ponta — clicar Analisar, o Claude editar o arquivo, o canvas atualizar
sozinho. Ao fim, a skill `~/.claude/skills/flowforge/SKILL.md` precisa descrever o
schema real, senão o Claude escreve no formato errado e o loop quebra.
