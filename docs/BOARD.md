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

- **FF-011** **Quebras e roteamento de aresta** — o `orthRoute` ganhou **desvio de
  obstáculo** (A* sobre grade de visibilidade, portado de `app.js:196`): o L/Z continua
  sendo o traço padrão e o A* só entra quando o caminho cruzaria um nó. E as **quebras
  manuais** voltaram — `waypoints` + `routing` entraram em `types.ts` (lei 3), com alças
  arrastáveis na aresta selecionada: cheia move, duplo-clique remove, fantasma no meio do
  trecho cria. Precedência: quebra manual > L/Z limpo > desvio. Paridade total com o editor
  antigo, escolhida pelo Fabricio em 06/08/2026 mesmo com 0 de 143 arestas usando quebra. ·
  `[porte]` · M · melhoria

- **FF-012** **Card do nó em diagrama denso** — o card mede a si mesmo depois de montado e
  escolhe o lado: direita por padrão, esquerda se não couber, abaixo se não couber de nenhum
  dos dois. Medir em vez de adivinhar, porque a largura do card e o zoom do canvas mudam e
  regra de CSS pura não enxerga nem um nem outro. · `[porte]` · P · melhoria

- **FF-013** **A topbar não distinguia as duas conexões** — o pill "conectado" é do browser
  com o servidor; o Claude é outra conexão. Saiu um segundo pill ("claude ouvindo/offline",
  âmbar quando offline porque não é falha) e o botão Analisar avisa antes do clique que o
  pedido vai pro inbox. Protocolo: `state.claudeOnline` + evento `{type:'claude'}`. ·
  `[porte]` · P · importante

## 📋 A fazer

_(FF-008 é o próximo, e é irreversível: só com o aval do Fabricio.)_

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
