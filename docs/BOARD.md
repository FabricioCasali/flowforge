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

## 📋 A fazer

_(fase 1 fechada — a fase 2 começa no FF-004)_

## 🗂️ Backlog

- **FF-004** **Edição: inspector de nó** — rótulo, `kind`, descrição técnica e notas livres.
  Hoje o `VerdictPanel` só dá veredito. · `[porte/fase-2]` · M · importante

- **FF-005** **Edição: criar, deletar e ligar** — paleta com os 13 kinds, `Del`, e os nozinhos
  dos 4 lados com aresta-fantasma gravando `sourceSide`/`targetSide`. O editor novo não cria
  nada hoje. · `[porte/fase-2]` · M · importante

- **FF-006** **Edição: aresta, campos ER e raias** — rótulo e status próprio da seta,
  cardinalidade `sourceCard`/`targetCard`, editor de campos da entidade (nome/tipo/pk/fk),
  criar e renomear raia, atribuir nó à raia. · `[porte/fase-2]` · M · importante

- **FF-007** **Ferramentas** — export PNG e Mermaid, busca com salto, undo/redo (20 níveis),
  menu de layouts nomeados, título editável, e o destaque do que o Claude mudou (o diff com
  toast "ver ↷", que é o que faz achar a edição num diagrama grande). · `[porte/fase-2]` · M
  · importante

- **FF-008** **Corte do antigo** — `/v2` vira `/`, o `web/` e o Cytoscape saem, e o campo
  `diagram` sai do payload do WS. Só depois que FF-004..007 fecharem. · `[porte/fase-3]` · P
  · importante

- **FF-009** **`title` no nível do workspace** — hoje cada um dos 5 modelos tem `title`
  próprio; renomear estando numa lente faz as lentes divergirem. Decisão de contrato em
  aberto. · `[porte]` · P · melhoria

- **FF-010** **Bundle de 1,8 MB** — o elkjs vai inteiro no chunk principal. Candidato a
  import dinâmico quando incomodar. · `[porte]` · P · melhoria

- **FF-011** **Quebras e roteamento de aresta** — as bend handles arrastáveis e o roteador
  ortogonal com desvio de obstáculos (A\*) do editor antigo (`app.js:196`, `app.js:1124-1236`)
  não têm equivalente no novo. Nenhum diagrama real usa `waypoints` hoje, então isso pode
  simplesmente não voltar — decidir antes de FF-008. · `[porte]` · M · melhoria
