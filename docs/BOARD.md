# Quadro do projeto

Toda tarefa combinada vira um **card** com ID estável (`FF-###`).
Status: 🗂️ Backlog · 📋 A fazer · 🔄 Fazendo · ✅ Feito · ⏸️ Pausado
Tamanho: **P** (uma sessão) · **M** (poucas) · **G** (frente maior)
Classe: **importante** · **melhoria**
Épico entre [colchetes].

> Contexto do épico [porte]: o canvas Cytoscape do `web/` está sendo substituído pelo editor
> React Flow + elkjs vindo do Context Builder. As leis estão em `CLAUDE.md` na raiz. A fase 0
> (fundação) está entregue e provada: 11/11 diagramas migram sem perda, `/` continua servindo
> o editor antigo intacto, e o Fabricio viu o `/v2` funcional na tela em 05/08/2026.

## ✅ Feito

- **FF-001** **Layout fiel ao arquivo** — quem tem `x`/`y` no arquivo é desenhado ali; o elk
  só calcula quem não tem, e o resultado dele é transladado para o referencial do desenho
  salvo (nó novo do Claude nasce perto dos vizinhos, e desce se cair em cima de alguém).
  Arrastar grava a posição de **todos** os nós, como o editor antigo faz. A **Swimlane é
  lente derivada** — recalcula sempre e não grava (decisão do Fabricio em 06/08/2026, lei 4);
  sem `lanes` ela avisa "sem raias definidas" em vez de fingir uma faixa. Prova nova:
  `scripts/verifica-layout.mjs` (com `--autoteste`) — 20 combinações diagrama×lente, todas
  fiéis. · `[porte/fase-1]` · M · importante

- **FF-002** **As 11 formas por `kind`** — as 9 famílias de forma saíram: `rect`,
  `subprocess` ([+]), `pill`, `diamond`, `gate` (✕/✛, 92px, rótulo fora), `event` (círculo
  62px, rótulo fora, `end` com borda grossa e `intermediate` com borda dupla), `idea`
  (elipse), `data` (canto cortado) e `annotation` (tracejada, esmaecida). A tabela virou
  `editor/shapes.ts` — módulo sem React que o render **e** o `nodeSize` leem, para não
  divergirem de novo. Regra de cor: fundo/contorno = `kind`, borda/glow = status.
  Travado no verificador (15 kinds conferidos). · `[porte/fase-1]` · M · importante

- **FF-fix** **`x`/`y` é o centro do nó** — o Cytoscape ancora no centro e o React Flow no
  canto, então o `/v2` desenhava tudo deslocado e desalinhado. A conversão passou a morar na
  borda (`savedPositions` / `toSavedPoint`); o arquivo mantém a semântica antiga porque o
  `web/` ainda lê os mesmos diagramas. Achado ao abrir o FF-002. · `[porte/fase-1]` · P ·
  importante

- **FF-003** **Pele** — Space Grotesk e JetBrains Mono agora são auto-hospedadas via
  `@fontsource` (7 arquivos: subset `latin`, só os pesos que a pele usa — sem CDN, porque a
  ferramenta não pode depender de rede). O `inset: 52px` da barra do NEON saiu do
  `editor.css`: o editor preenche o container e quem o recua é o shell; o recuo do
  `.seqview` virou `calc()` sobre `--lensbar-top`/`--lensbar-h`. · `[porte/fase-1]` · P ·
  melhoria

- **FF-004** **Edição: inspector de nó** — o `VerdictPanel` virou `NodeCard`, com abas
  descrição/notas: rótulo, `kind` (13 opções agrupadas Fluxo/BPM), descrição técnica e notas
  livres. Escreve no `change` (blur/Enter), nunca por tecla — senão cada caractere viraria um
  `rev` e o eco comeria o cursor. Prova nova: `scripts/verifica-edicao.mjs`, que cobre o
  caminho de escrita inteiro da fase 2. · `[porte/fase-2]` · M · importante

- **FF-005** **Edição: criar, deletar e ligar** — paleta flutuante com os 13 kinds (mini-SVG
  da forma real), criar por arrastar-soltar, por clique ou por duplo-clique no vazio;
  `Del`/`Backspace` apaga e leva as arestas penduradas junto; nozinhos nos 4 lados (só no
  hover) gravando `sourceSide`/`targetSide`. O `orthRoute` passou a **respeitar** o lado
  gravado — sem isso o campo seria enfeite e as 54 pontas ancoradas dos diagramas reais
  desenhariam diferente do editor antigo. · `[porte/fase-2]` · M · importante

- **FF-006** **Edição: aresta, campos ER e raias** — `EdgeCard` no meio da seta selecionada
  (rótulo, status próprio, cardinalidade na lente ER, excluir); aba **campos** no card da
  entidade (nome/tipo/pk/fk); `LanesPanel` para criar, renomear, reordenar e remover raia, e
  seletor de raia no card do nó. A propagação virou **local** (`propagateFrom`) — é a lei 10,
  decidida em 06/08/2026 depois de medir que 24% das arestas reais divergem das pontas. ·
  `[porte/fase-2]` · M · importante

- **FF-007** **Ferramentas** — undo/redo (20 níveis, por lente, com Ctrl+Z/Ctrl+Shift+Z),
  busca com salto (Enter circula pelos achados), menu de arranjos (Vertical/Horizontal/
  Árvore/Radial/Força — recalculam **e gravam**), export **SVG, PNG e Mermaid** sem
  dependência nova (o SVG é desenhado do modelo; o PNG sai dele por canvas), título editável
  na topbar, e o destaque do que o Claude mudou com toast "ver ↷". · `[porte/fase-2]` · M ·
  importante

## 📋 A fazer

_(fases 1 e 2 fechadas. O `/v2` edita tudo o que o `web/` antigo edita — falta a validação
do Fabricio na tela antes de encostar no FF-008, que é irreversível.)_

## 🗂️ Backlog

- **FF-008** **Corte do antigo** — `/v2` vira `/`, o `web/` e o Cytoscape saem, e o campo
  `diagram` sai do payload do WS. Só depois que FF-004..007 fecharem. · `[porte/fase-3]` · P
  · importante

- **FF-009** **`title` no nível do workspace** — hoje cada um dos 5 modelos tem `title`
  próprio. Decisão de contrato ainda em aberto; enquanto isso, o FF-007 **mitigou**: renomear
  na topbar grava em todos os modelos com conteúdo, ao custo de um patch (e um `rev`) por
  modelo. É esse custo que justifica fechar o card. · `[porte]` · P · melhoria

- **FF-010** **Bundle de 1,8 MB** — o elkjs vai inteiro no chunk principal. Candidato a
  import dinâmico quando incomodar. · `[porte]` · P · melhoria

- **FF-011** **Quebras e roteamento de aresta** — as bend handles arrastáveis e o roteador
  ortogonal com desvio de obstáculos (A\*) do editor antigo (`app.js:196`, `app.js:1124-1236`)
  não têm equivalente no novo. **Confirmado na validação de 06/08/2026**: o Fabricio viu
  linhas voltando pelo próprio eixo e cruzando por baixo de cards. Ele classificou como "não
  grave, já tínhamos antes" — mas é o argumento a favor de trazer o desvio de volta. Decidir
  antes de FF-008. · `[porte]` · M · melhoria

- **FF-012** **Card do nó em diagrama denso** — o `.fpanel` abre sempre à direita do nó
  (`left: calc(100% + 16px)`). Num nó colado na borda direita da viewport ele nasce fora da
  tela. Precisa escolher o lado (ou virar popover com colisão). Saiu da validação de
  06/08/2026. · `[porte]` · P · melhoria
