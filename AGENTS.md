# FlowForge — regras do projeto (editor React Flow)

> Este arquivo é lei. Vale para mim e para todos os subagents. Docs e comentários
> em **PT-BR**; identificadores de código como estão.

## 1. O que está acontecendo

O FlowForge é a ferramenta de trabalho **diária** do Fabricio: ele desenha o problema,
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

O projeto é **aberto (MIT)** e já tem gente de fora usando. Isso muda uma coisa no dia
a dia: caminho de máquina, nome de pasta pessoal e decisão interna ficam **aqui**, não
no `README.md` nem em nada que um estranho leia primeiro.

## 2. Leis invioláveis

1. **A ferramenta do Fabricio não pode parar.** _Cumprida no corte:_ o `web/` (Cytoscape)
   viveu em `/` até o `/v2` ser validado na tela, e só então saiu — com `/v2` redirecionando
   para `/` para não quebrar aba aberta nem link salvo. A lei permanece como regra de
   conduta: mudança grande entra ao lado do que funciona, e o que funciona só morre depois
   que o substituto foi usado de verdade.

2. **Arquivos são a fonte da verdade.** O servidor espelha arquivo ↔ browser via
   `fs.watch`; o agente edita os arquivos direto e a mudança chega sozinha no canvas.
   Nunca invente um canal paralelo ao arquivo.

   **Mas o FlowForge NÃO é memória.** Ele é ferramenta de *raciocínio*: serve pra tomar
   decisão e entender fluxo, e o diagrama é descartável depois que cumpriu isso. O que
   precisa sobreviver vai pra wiki, na curadoria (dito pelo Fabricio em 06/08/2026).
   Consequência prática: **não pese decisão de contrato pelo custo de migrar o passado.**
   Campo novo que nasce vazio nos diagramas existentes é aceitável — refazer um diagrama
   custa pouco, e carregar um modelo ruim pra sempre custa caro.

3. **Contrato antes de consumir.** `web-next/src/types.ts` é a barreira: modelo ou campo
   novo entra ali **antes** de qualquer componente ou do servidor consumir. É a cópia
   local do modelo — sem `@neon/shared`, sem import cruzando repo.

4. **`workspace.json` é o novo arquivo-verdade**, com os 5 modelos coexistindo:
   `{ process, state, er, mind, seq, rev, updatedBy }`. As 6 lentes leem esses 5 modelos —
   `process` serve Fluxograma **e** Swimlane (mesmo grafo, layout diferente).

   **EXCEÇÃO À REGRA DA POSIÇÃO — sobreposição.** O editor afasta nós que se sobrepõem
   ao abrir, e **grava**. É a única coisa que move um nó sem o Fabricio pedir, e existe
   porque o porte causou o problema: o editor antigo desenhava caixa fixa de 162×54 e o
   novo calcula pelo conteúdo, chegando a 330×92 — as coordenadas foram preservadas
   fielmente e as caixas engordaram em cima delas, deixando 25 pares sobrepostos nos
   diagramas reais. Decidido pelo Fabricio em 06/08/2026, ciente de que perde o caso de
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
   O agente escreve com `rev+1` e `updatedBy:"agent"`.

7. **A trava `busy` continua valendo.** Ao despachar o "analyze" a sessão trava e o browser
   entra em modo leitura; só libera quando o adapter conclui o `requestId`. O editor novo
   precisa honrar isso (`{type:'busy'}` no WS) — senão o Fabricio edita por cima da escrita.

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
    Decidido pelo Fabricio em 06/08/2026; contrato inalterado. A versão global
    (`propagateEdges`, em `types.ts`) sobrou só para proposta crua vinda de fora, onde
    não existe marcação anterior a preservar — **não a use no editor**.

11. **~~A divergência entre os dois editores é ACEITA~~ — ENCERRADA no FF-008.** Existia
    um editor antigo em `/` escrevendo `diagram.json` e o novo em `/v2` escrevendo
    `workspace.json`, e a lei mandava não "consertar" a divergência entre eles. O antigo
    saiu; sobrou **um** editor e **um** arquivo-verdade. Fica registrado porque o motivo
    ainda ensina: a divergência era real, mas o Fabricio nunca rodava os dois em paralelo
    — o risco era teórico e não valia código.

## 3. Protocolo (WS) — não mude sem atualizar os dois lados

Browser ↔ servidor em `/ws?session=<slug>`:
- recebe `{type:'state', session, workspace, thread, busy, agentOnline, agentLabel}`
- recebe `{type:'busy', session, busy}`
- recebe `{type:'agent', online, label}` — **duas conexões, duas luzes**. O pill de
  conexão é do browser com o servidor; este diz se existe adapter no `/agent`.
  Sem essa distinção o "Analisar" sai com a tela verde e volta "agente offline"
  (aconteceu na validação de 06/08/2026)
- envia `{type:'patch', session, lens, diagram}` — **lens-aware**: `lens` ∈
  `process|state|er|mind|seq` diz qual modelo do workspace o patch altera
- envia `{type:'analyze', session, note}`

Adapter externo em `/agent`: registra `adapterId` e `label`, recebe o evento `analyze`
com `requestId`, `workspacePath`, `threadPath`, `projectPath` e `workspaceRev`, e responde
com `accepted`, `completed` ou `failed`. Sem adapter conectado o pedido fica no
`inbox.jsonl` e é reenviado quando um registrar. A entrega é pelo menos uma vez: queda ou
timeout mantêm a trava e reenviam o mesmo `requestId`, que o adapter deve deduplicar. Pedidos
da mesma sessão são seriais. `/claude` é alias de URL legado temporário e usa o mesmo
protocolo de `/agent`.

`/v2` responde 301 para `/` — o editor morou lá durante o porte e há links salvos.

## 4. Comandos

```
node server/index.js --data-dir "<projeto>/.flowforge" --port 4317   # servidor
cd web-next && npm run dev                                          # front em dev
cd web-next && npm run build                                        # bundle servido pelo server
```

## 5. Definition of Done

Nenhuma fase é "pronta" sem: build limpo, os diagramas reais abrindo sem perda
(rode a checagem contra `sessions/` e os `.flowforge/` dos projetos), e o loop vivo
provado ponta-a-ponta — clicar Analisar, o harness do usuário editar o arquivo, concluir
o `requestId` e o canvas atualizar sozinho. O adapter precisa seguir `docs/SCHEMA.md`;
instrução específica de fornecedor fica fora do núcleo do FlowForge.
