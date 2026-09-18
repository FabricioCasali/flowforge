# Quadro do projeto

Toda tarefa combinada vira um **card** com ID estável (`FF-###`).
Status: 🗂️ Backlog · 📋 A fazer · 🔄 Fazendo · ✅ Feito · ⏸️ Pausado
Tamanho: **P** (uma sessão) · **M** (poucas) · **G** (frente maior)
Classe: **importante** · **melhoria**
Épico entre [colchetes].

> Contexto do épico [porte] — **encerrado em 06/08/2026**: o canvas Cytoscape do `web/` foi
> substituído pelo editor React Flow + elkjs vindo do Context Builder. As leis estão em
> `CLAUDE.md` na raiz. O corte saiu no FF-008: o `web/` foi removido, o editor novo é servido
> em `/` e o `/v2` responde 301 para `/`. O que vem agora é o épico `[uso]` — melhoria vinda
> do uso diário — e o `[aberto]`, o projeto como software público.

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

- **FF-008** **Corte do antigo** — o editor Cytoscape (`web/`) saiu e o React Flow passou a
  ser servido em `/`. `/v2` responde **301 para `/`** preservando a query, porque havia aba
  aberta e link salvo. O payload do WS perdeu o campo `diagram`; patch sem `lens` agora é
  recusado em voz alta em vez de adivinhar a lente. O `safeReadState` deixou de exigir
  `diagram.json` — sessão nova não tem mais esse arquivo, e exigi-lo deixaria o canvas
  vazio para sempre. A **migração lazy continua** (lei 5): sessão antiga vira `workspace.json`
  na primeira abertura e o `diagram.json` fica preservado como backup, sem ninguém ler nem
  escrever nele. Skill e leis atualizadas. · `[porte/fase-3]` · P · importante

- **FF-014** **O projeto aberto** — LICENSE MIT, `README.md` reescrito para quem nunca viu
  o projeto (o antigo descrevia o editor Cytoscape e o `diagram.json`, que não existem mais),
  `docs/SCHEMA.md` tirando o formato dos arquivos de dentro da skill na máquina do autor, e
  `CONTRIBUTING.md`. O SCHEMA é o que permite plugar **outro** agente no loop — sem ele, a
  parte interessante da ferramenta fica privada. Os comandos do README foram exercitados
  contra esta árvore, não escritos de memória. · `[aberto]` · P · importante

- **FF-015** **Modo guiado** — painel de etapas em cartões à esquerda; clicar num cartão
  seleciona o nó e voa a tela até ele, e clicar num nó no canvas rola o painel até o cartão
  (é de mão dupla, senão você perde o fio ao navegar). Campo novo `concept` em `types.ts`:
  **painel = teoria, card = exemplo real** — duas frentes, decisão do Fabricio em
  06/08/2026. Ordem por **posição** (`y`, `x` de desempate), não topológica: 3 dos 11
  diagramas têm ciclo e 4 têm mais de uma raiz. Anotações vão pro fim (não são etapas).
  Só nas lentes de percurso (Fluxograma, Swimlane, Máq. estados) — `mind`, `er` e `seq`
  pediriam outra forma e ficam fora até o gesto se provar. Preferência lembrada em
  `localStorage`. · `[uso]` · M · melhoria

- **FF-016** **Nós sobrepostos são afastados ao abrir** — o desempilhamento do FF-001 só
  rodava para nó **sem** posição; quando todas vinham do arquivo, o layout devolvia o desenho
  sem olhar sobreposição. A causa é o porte: caixa fixa de 162×54 virou 330×92 calculada pelo
  conteúdo, e as caixas engordaram sobre coordenadas preservadas fielmente — **25 pares
  sobrepostos** nos diagramas reais, 6 com anotação. Como isto **reescreve o desenho do
  usuário**, virou exceção escrita na lei 4. Três garantias viraram teste (determinístico,
  mínimo, converge na 2ª abertura), o eixo do empurrão é por lente (na Swimlane empurra em X,
  senão o nó sai do ator dele) e o editor **avisa** quando mexe. · `[uso]` · P · importante

- **FF-017** **O card do nó em duas colunas** — o card de 268px empilhava tudo e punha a
  descrição, o campo mais lido, num textarea espremido no fim; e o veredito, o gesto mais
  frequente, caía abaixo da dobra (apareceu cortado num print). Agora a aba "prática" é grid
  de duas colunas — identidade à esquerda, texto à direita numa caixa alta — e o card foi a
  468px. O veredito virou `position: sticky` no rodapé com degradê. · `[uso]` · P · melhoria

- **FF-018** **O card media contra a janela, não contra a área de desenho** — o FF-012 decidia
  o lado com `r.right <= window.innerWidth - 12`, mas o desenho acaba onde a conversa começa.
  Entre as duas fronteiras havia uma faixa em que o card "cabia" na conta e abria fora da
  vista — o mesmo defeito que o FF-012 existe para evitar ("o card existia e era
  inalcançável"), com a fronteira errada. O FF-017 alargou a faixa: ela é proporcional à
  largura do card, que cresceu 75%.

  A área útil acabou sendo a **interseção de dois retângulos**, porque nenhum basta sozinho:
  o `.react-flow` responde pela **esquerda** (o modo guiado o recua 306px) mas transborda o
  pai à direita, indo parar debaixo da conversa; o `.neon-editor` responde pela **direita**
  mas ignora o recuo do guia. Um `min`/`max` nos dois dá o que o olho vê.

  Prova (janela de 1135, modo guiado, área útil 306→795): pela regra antiga, **6 nós
  visíveis** — `n3`, `n4`, `n5`, `n7`, `n10`, `a1` — abriam card fora da área; pela nova,
  **nenhum**. Dos 21 nós, 18 ficam inteiramente dentro e os 3 que sobram têm o **próprio nó**
  fora da área visível, onde card nenhum caberia. · `[uso]` · P · importante

  _Sem verificador: é geometria de DOM, e cobri-la exigiria jsdom — dependência nova que a
  lei 9 não autoriza por isto. Foi medida no browser._

- **FF-019** **O status falava cinco vezes por nó** — ponto com glow, badge, borda, glow da
  caixa e a seta na mesma cor. No `arquitetura-flowforge` (20 de 21 aprovados) o canvas inteiro
  brilhava verde e o único questionado sumia. Aprovado virou o **repouso**: `LIVE` é só
  `questioned`, o badge some no aprovado (`BADGED`), o ponto só brilha em quem está vivo e a
  seta aprovada é neutra (`EDGE_COLOR`, token `--edge-quiet`) — a cor fica pra seta que
  discorda, que é a da lei 10. · `[uso]` · P · importante

- **FF-020** **O diagrama abria desenquadrado, e o "fit" ignorava os painéis** — o `fitView` do
  React Flow roda na montagem, quando o layout assíncrono ainda não chegou: o canvas abria num
  zoom arbitrário (medido: 1,26× na abertura, 0,49× depois do fit). Agora enquadra quando o
  DESENHO troca (sessão, lente) e nunca numa edição; folga por lado desconta barra de lentes,
  paleta e HUD (antes as anotações do topo e os rótulos das raias ficavam atrás deles), e
  `maxZoom: 1` impede que 3 entidades abram a 1,8×. O `EditorView` ganhou `key` por sessão —
  o que também fecha um bug: o histórico de desfazer atravessava a troca de sessão. Botões de
  zoom saíram de trás do HUD; em janela estreita a toolbar desce pra 2ª linha em vez de passar
  por cima das lentes. · `[uso]` · P · importante

- **FF-021** **Setas: âncoras distribuídas, trechos afastados, rótulo fora dos nós** — toda
  aresta saía do MEIO do lado, então três setas no mesmo nó viravam um tronco só. Agora as
  pontas que dividem um lado se espalham nele, na ordem de quem está do outro lado
  (`distribuirAncoras`; só em forma de lado reto — losango, círculo e elipse continuam no
  meio), e os trechos de miolo que corriam colados se afastam (`afastarTrechos`, com o sentido
  escolhido pra não trocar sobreposição por cruzamento). O rótulo deixou de morar numa quina
  do traço: `labelPoint` testa posições por trecho e fica com a que menos invade nós **e outros
  rótulos**; o export SVG usa a mesma função. Quebra manual continua mandando (FF-011).
  Medido no `conceito-model-view`: rótulos sobre nó 4→0, trechos sobrepostos 1→0, cruzamentos
  2→0; no `processo-atendimento`, sobrepostos 4→1. Contrato inalterado. · `[uso]` · M ·
  importante

- **FF-022** **Texto estourando forma fixa, e nível de detalhe por zoom** — `decision`
  (168×104), `data-object` (128×72) e `idea` (altura 40) não cresciam com o rótulo, e frase de
  50 letras vazava por cima e por baixo; agora o `nodeSize` estima as linhas, como a anotação
  já fazia (evento e gateway seguem fixos — lei 8, conferido pelo verificador). E abaixo de
  0,62× de zoom o container ganha `.lod-longe`: some descrição e badge, o título cresce — a
  0,5× eles eram mancha. É classe no container, não refaz nó. · `[uso]` · P · melhoria

- **FF-023** **Menos painel em cima do desenho** — paleta recolhida por padrão (só as
  silhuetas, 48px em vez de 122; lembrada em `localStorage` como o guiado), minimapa menor,
  translúcido e colorido por status (acha-se o questionado sem percorrer o desenho) e fora da
  Swimlane, onde disputava o canto com o painel de raias; lente vazia diz o que fazer em vez de
  abrir um canvas preto. · `[uso]` · P · melhoria

- **FF-024** **Casa arrumada no `EditorView`** — o elk (1,4 MB) virou `import()` sob demanda:
  bundle inicial **1.860 → 412 kB** (desenho inteiro salvo nem o chama). O ciclo do card e o
  desfazer/refazer saíram pra `useCardAberto.ts` e `useHistorico.ts`; quem está com o card
  aberto chega aos nós por contexto, não pelo `data` — antes, passar o mouse num nó refazia a
  lista inteira de nós do React Flow. Durante o arrasto as setas usam as mesmas âncoras do
  traçado final (`routeMoved`), senão pulavam ao soltar. · `[uso]` · P · melhoria

- **FF-025** **O arranjo automático não começava pelo início, e fluxo comprido virava uma tira**
  — o `layered` do elk quebra ciclo invertendo a seta que sair mais barata, e todo laço de volta
  ("não pegou a carteira → tranca de novo") é um ciclo: um desvio qualquer ia parar no topo e o
  início ficava no meio. Agora o início é preso na 1ª camada (`layerConstraint: FIRST`, só em
  quem não recebe seta — o elk lança exceção se receber), os nós vão em ordem de leitura com os
  inícios na frente (`considerModelOrder`), os ciclos quebram em profundidade e os pedaços
  desconectados entram no mesmo layering (antes o bloco do início podia ir pra baixo de um
  pedaço solto maior). `BRANDES_KOEPF` + `favorStraightEdges` deixa o tronco reto. E o
  **wrapping** do layered faz o fluxo comprido dar a volta em colunas: o exemplo de 35 nós saiu
  de ~600×3.500px (enquadrado a 0,24×, ilegível) pra 3 colunas a 0,47×. A Swimlane não quebra
  (só usa o `x` do elk). Se o elk recusar o grafo, segunda tentativa sem as restrições — canvas
  vazio nunca. · `[uso]` · M · importante

- **FF-026** **Âncora velha: a seta saía pela esquerda pra chegar em quem estava à direita** —
  `sourceSide`/`targetSide` são gravados pra UMA geometria; depois de um arranjo (ou de arrastar)
  o lado passa a custar uma volta inteira. Três correções: (1) o arranjo **limpa** lado ancorado
  e quebra manual das setas — "reorganiza pra mim" inclui as setas, e Ctrl+Z desfaz; (2) no
  traço, âncora que custa muito mais que o caminho natural (`> 1,8× + 120px`) é ignorada, e a
  que ficou de costas também — o arquivo não muda; a exceção é o par de ida-e-volta (A→B e
  B→A), onde o desvio é de propósito; (3) seta **contra a corrente** (destino noutra coluna e
  acima — o que o wrapping produz) sai pelo lado, sobe pelo corredor entre as colunas e entra por
  cima, em vez de subir por dentro da própria coluna colada no tronco. `ladosDe` virou a fonte
  única de "por onde a seta sai e chega" pro traço, pro desvio e pras âncoras distribuídas. Muda
  a lei implícita do FF-005 ("o lado gravado manda") pra "manda enquanto fizer sentido" —
  decisão do Fabricio em 17/09/2026, depois de ver o defeito no exemplo do Pedro. O enquadramento
  passou a incluir as SETAS (o conector entre colunas passa por cima dos nós e ficava cortado),
  com botão próprio no lugar do `fitView` do React Flow. · `[uso]` · M · importante

- **FF-027** **Modo guiado na ordem do fluxo, e o HUD acusa fluxo sem início/fim** — o guia
  ordenava por posição (`y`, `x`), e bastava um arranjo automático ou um desenho em circuito (ida
  descendo, volta subindo) pra ele começar pelo meio da história. Agora percorre as setas a
  partir do início, em **largura** (o desvio de uma decisão aparece logo depois dela, não no fim
  do caminho principal); ciclo não trava, vários inícios são aceitos, e quem o percurso não
  alcança entra no fim em vez de sumir. No HUD do Fluxograma/Swimlane: `⚠ sem início`, `⚠ sem
  fim`, `⚠ N fora do percurso`, `⚠ N sem caminho até o fim` (o `title` lista quem). Medido nos
  diagramas reais: 1 de 8 sem início/fim, e o `arquitetura-flowforge` com 7 etapas que o início
  não alcança. Abrir uma sessão também deixou de contar como "o agente mexeu em N etapas". ·
  `[uso]` · P · importante

- **FF-028** **Um roteador só, e setas que encostam** — achados do Fabricio usando o exemplo do
  Pedro e o do vínculo do agente. (1) Diagrama recém-aberto (sem `x`/`y`) usava as setas do
  **elk**, que enxerga todo nó como retângulo: no losango a seta parava na caixa invisível, sem
  encostar, e "consertava" ao mover um nó — porque aí o `routeAll` assumia. Agora o elk só dá as
  posições; as setas são sempre do `routeAll`, e o desenho não pula no primeiro arrasto. (2) O
  eixo da seta livre passou a ser decidido pela **sobreposição das caixas** (sobrepostas em X →
  vertical), não pela maior distância: a decisão saía pelos lados do losango e voltava por baixo
  dele, parecendo sair de trás do nó. (3) O desvio A* parte de um **toco de 18px** perpendicular
  à borda, com os dois nós da seta como obstáculo — antes corria rente ao nó (há uma linha da
  grade a 10px dele); se o toco não fecha caminho, vale a tentativa antiga. (4) A âncora fica na
  **projeção** de quem está do outro lado, presa dentro do lado, em vez de sempre no meio. (5)
  Pontas a até 14px de prumo viram **reta** (o elk deixa centros alguns pixels fora, e o Z
  desenhava um degrau de 4px). · `[uso]` · M · importante

- **FF-029** **Cada ramo da decisão sai por uma ponta** — o losango (como gateway, evento e
  elipse) só encosta na seta pelas 4 pontas, então "sim" e "não" apontando pra baixo disputavam a
  MESMA ponta e desciam colados: a separação dos caminhos, que é a informação da decisão, só
  aparecia perto do destino. Agora (`separarRamos`): fica na ponta disputada o ramo de destino
  mais próximo; os outros vão pra ponta lateral do lado do destino, se ela estiver livre — ponta
  ocupada por seta que CHEGA não recebe ramo. Só saídas (várias chegando é junção, e junção lê
  bem), e lado gravado no arquivo continua mandando. A âncora de chegada passou a mirar o toco
  por onde a seta saiu, não o centro do nó (senão saía pela direita, descia e voltava pra
  esquerda). `distribuirAncoras` virou a fonte única dos lados; `routeAll`/`routeMoved` traçam a
  partir dela. Pedido do Fabricio em 18/09/2026, com 3 casos no autoteste. · `[uso]` · P ·
  importante

## 📋 A fazer

_(vazio — o que sobra está no backlog.)_

## 🗂️ Backlog

- **FF-009** **`title` no nível do workspace** — hoje cada um dos 5 modelos tem `title`
  próprio. Decisão de contrato ainda em aberto; enquanto isso, o FF-007 **mitigou**: renomear
  na topbar grava em todos os modelos com conteúdo, ao custo de um patch (e um `rev`) por
  modelo. É esse custo que justifica fechar o card. · `[porte]` · P · melhoria
