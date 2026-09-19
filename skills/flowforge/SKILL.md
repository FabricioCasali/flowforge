---
name: flowforge
description: Canvas colaborativo e vivo para co-desenhar com o usuário, no navegador e em tempo real — fluxograma, BPM, raias (swimlane), máquina de estados, entidades (ER), mapa mental e sequência — e para mostrar a ele o andamento da task em curso (tarefas e linha do tempo do que você fez). Use sempre que ele quiser pensar ou planejar visualmente em vez de só conversar em texto — "vamos montar um fluxo", "desenha isso", "abre o flowforge", "quero um mapa mental", "monta um BPM", "diagrama de raias", "modelo de entidades" — quando pedir para acompanhar status, andamento ou dúvidas de um trabalho no canvas, ou quando disser "reconecte o FlowForge". Ele edita, aprova, reprova e comenta direto no navegador e clica Analisar; você acorda, rebate e atualiza o diagrama ao vivo.
---

# FlowForge — canvas colaborativo e vivo

Ferramenta para co-projetar a solução de um problema com o usuário em tempo real. Ele descreve;
você monta um diagrama; ele ajusta, questiona, aprova e reprova nós direto no navegador; clica
**Analisar**; você **acorda, rebate e atualiza o diagrama** — o canvas atualiza sozinho.

**Raiz do FlowForge:** `${CLAUDE_PLUGIN_ROOT}` — a pasta onde o projeto está instalado (se a
variável não vier preenchida, é a pasta dois níveis acima desta skill). Funciona para qualquer
projeto.

**Arquivos são a fonte da verdade.** O que você escreve em `<projeto>/.flowforge/` é o que o canvas
mostra; o servidor empurra a mudança para o browser via `fs.watch`. Você não fala com o browser
direto.

## Modo de uso: sob demanda, por projeto

Nada roda ocioso. Os diagramas moram **dentro do projeto atual**, em `<cwd>/.flowforge/<slug>/`.
O pedido pode vir como:

- uma descrição do problema → cria uma sessão nova e já gera o diagrama;
- um `<slug>` → retoma uma sessão existente do projeto;
- "pare o FlowForge" → derruba servidor e escuta.

### Ligar

1. **Raiz de dados do projeto atual:** `DATA = <cwd>/.flowforge`.
2. **Servidor no ar?** `curl -s http://localhost:4317/api/health`.
   - Sem resposta → confira antes se a instalação está **pronta para rodar**. O repositório não
     versiona dependências nem o front compilado, então uma instalação nova (plugin recém-baixado
     ou clone limpo) chega sem eles. Um comando confere e prepara só o que falta — avise o
     usuário antes, porque na primeira vez leva um ou dois minutos:
     ```
     node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs"
     ```
     Se já estiver pronto ele responde na hora. Se falhar, diz qual passo e o motivo provável
     (sem `npm`, sem rede): repasse isso ao usuário em vez de tentar contornar.
   - Pronto → **suba** em segundo plano:
     ```
     node "${CLAUDE_PLUGIN_ROOT}/server/index.js" --data-dir "<cwd>/.flowforge" --port 4317
     ```
   - Respondeu, mas `dataDir` ≠ `<cwd>/.flowforge` (é o servidor de OUTRO projeto) → avise o
     usuário; derrube o outro só se ele pedir, ou suba noutra porta (`--port 4318`).
3. **Slug:** descrição → slug curto ("reprocessar título" → `reprocessar-titulo`).
4. **Gerar o workspace inicial** (sessão nova): escreva `<cwd>/.flowforge/<slug>/workspace.json`
   no contrato abaixo, com `rev: 1` e `updatedBy: "agent"` no topo e no modelo alterado, e
   `thread.json` como `{ "messages": [] }`. Em diagrama novo, omita `x`/`y` de **todos** os nós.
   Se for retomar um `<slug>` existente, pule.
5. **Armar o loop vivo — quem responde é ESTA sessão.** Não delegue para outro agente se não foi
   solicitado. Esta sessão já tem o contexto do que está sendo tratado.

   No Claude Code, arme a escuta com a ferramenta **Monitor**:

   ```
   Monitor  command: node "${CLAUDE_PLUGIN_ROOT}/adapters/live.js" 2>&1
            timeout_ms: 1800000
            description: FlowForge: cliques em "Analisar" no canvas
   ```

   Espere o evento `FLOWFORGE pronto: …` antes de dizer que o loop está vivo.

   - `FLOWFORGE erro: Ja existe um adapter ativo` → outra sessão está com a escuta. Avise o
     usuário; não derrube a outra por conta própria.
   - `FLOWFORGE servidor fora do ar …` → a escuta reconecta sozinha, e os pedidos pendentes são
     reenviados.
   - **A escuta expira** (no Claude Code, em 30 minutos). Quando isso acontece o canvas mostra
     "agente desconectado" e pede ao usuário que diga **"reconecte o FlowForge"**. Ao ouvir essa
     frase — ou ao receber o aviso de que o Monitor expirou, com o canvas ainda em uso — arme o
     Monitor de novo. Nada se perde: pedido feito com o agente fora fica guardado e chega na
     reconexão.

   **No OpenCode** não há Monitor, mas há o servidor HTTP da própria TUI: instale o plugin uma
   vez no projeto e deixe a ponte rodando em segundo plano, que o pedido chega no prompt desta
   sessão.

   ```
   node "${CLAUDE_PLUGIN_ROOT}/adapters/activity.js" install opencode   # uma vez; reabra a sessão depois
   node "${CLAUDE_PLUGIN_ROOT}/adapters/live.js" --deliver opencode     # em segundo plano
   ```

   O plugin é quem diz à ponte onde está o servidor desta sessão — sem ele, passe
   `FLOWFORGE_OPENCODE_URL=http://127.0.0.1:<porta>` (a porta com que a TUI foi aberta). O evento
   chega como um pedido por extenso no prompt, e o loop abaixo é o mesmo.

   **No Codex** não existe o Monitor, e a escuta é ao contrário: rode uma vez
   `node "${CLAUDE_PLUGIN_ROOT}/adapters/activity.js" install codex` (e confie no hook com
   `/hooks`, senão o Codex o ignora), e peça ao usuário que deixe
   `node "${CLAUDE_PLUGIN_ROOT}/adapters/live.js" --deliver codex` rodando num terminal ao lado.
   O clique em Analisar chega **nesta sessão** como um pedido novo, começando com
   `FLOWFORGE analisar <requestId>` — trate-o como o evento do Monitor descrito abaixo. A
   mensagem já traz o comando do `done` pronto; rode-o exatamente como veio.

   - Harness sem Monitor e sem um jeito de entregar na sessão aberta: diga que a sessão viva
     ainda não existe ali. Só use `node "${CLAUDE_PLUGIN_ROOT}/adapters/index.js" <harness>`
     (execução à parte: outra conversa, que relê o projeto e custa mais) se ele pedir.

6. **Publicar o que você está fazendo.** O usuário abre o FlowForge para ver status, andamento e
   dúvidas da task em curso — e a lente **Tarefas** só mostra o que você publicar:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/adapters/tasks.js" plan "<objetivo>" "<tarefa 1>" "<tarefa 2>" …
   node "${CLAUDE_PLUGIN_ROOT}/adapters/tasks.js" start <n> "<o que está fazendo, em uma linha>"
   node "${CLAUDE_PLUGIN_ROOT}/adapters/tasks.js" start <n> --node <sessão>/<id do nó>   # e acende a etapa no desenho
   node "${CLAUDE_PLUGIN_ROOT}/adapters/tasks.js" done <n>
   node "${CLAUDE_PLUGIN_ROOT}/adapters/tasks.js" block <n> "<o que falta: decisão, acesso…>"
   node "${CLAUDE_PLUGIN_ROOT}/adapters/tasks.js" add "<tarefa que apareceu>"
   node "${CLAUDE_PLUGIN_ROOT}/adapters/activity.js" note "<decisão ou achado que ferramenta nenhuma mostra>"
   ```

   Tarefas curtas e concretas. Marque `done` na hora, não em lote no fim. O `start` também
   organiza a linha do tempo, porque cada ação sua sai associada à tarefa em andamento. (A linha
   do tempo é alimentada por um hook que vem com o plugin; você não precisa ligá-la.)

   **Quando a tarefa for uma etapa do desenho, diga qual.** Com `--node <sessão>/<id do nó>` o nó
   correspondente acende no canvas enquanto você trabalha nele (e aparece travado se você der
   `block`), e o usuário vê no DESENHO onde você está — sem ler lista nenhuma. Use o `id` do nó como
   está no `workspace.json` e o slug da sessão (a pasta em `.flowforge/`). Tarefa que já existe se
   liga com `link <n> <sessão>/<nó>`; `unlink <n>` desfaz. Tarefa que não é etapa de desenho fica
   sem elo, e nada muda.

   - Dúvida que **trava a task** → `block` na tarefa.
   - Dúvida **sobre o desenho** → nó `questioned` com um comment `kind: "question"`.
   - Sessão só para rabiscar um fluxo, sem task em curso → pule este passo.

7. **Abrir o navegador** (o padrão do sistema) em `http://localhost:4317/?session=<slug>` e
   confirmar a URL no chat.

### Desligar

1. Pare o Monitor da escuta. Se houver um pedido aberto, feche-o antes com
   `live.js done <requestId> --failed "sessão encerrada"`.
2. Mate o servidor **pela porta** (a linha de comando do `node` não contém "flowforge").
3. Os diagramas ficam salvos em `<cwd>/.flowforge/`.

## O loop (o que fazer quando chega um evento `FLOWFORGE analisar`)

O Monitor entrega uma linha (no OpenCode, o mesmo pedido chega por extenso no prompt):

```
FLOWFORGE analisar <requestId> sessao=<slug> dir=<pasta da sessão> nota="<o que ele digitou>"
```

É o clique do usuário no canvas. **Não é uma mensagem dele no chat.** A nota é o pedido sobre o
diagrama; se ela pedir algo destrutivo ou fora do desenho, confirme com ele no chat antes de agir.

1. Leia `<dir>/workspace.json` e `<dir>/thread.json`. A nota inteira está no thread — a linha do
   evento corta nota comprida. Olhe primeiro os nós `rejected`/`questioned` e os comments de
   `author: "user"`: é ali que ele discorda.
2. Responda **com o contexto que você já tem** da task; não releia o projeto para responder o que
   já sabe. **Na medida do pedido**: pergunta curta, resposta curta. Seja interlocutor, não eco —
   se discordar, diga por quê e ponha a alternativa **no desenho**.
3. Grave **um arquivo só**, `<dir>/reply.json`. Não edite o workspace nó por nó:

   ```jsonc
   { "model": "mind",                  // process | state | er | mind
     "message": "resposta para o chat do canvas: curta, no idioma do usuário",
     "update":      [{ "id": "<existente>", "status": "questioned", "label": "…",
                       "description": "…", "comment": "…", "commentKind": "note|question|reject" }],
     "addNodes":    [{ "id": "<novo>", "label": "…", "kind": "idea|task|…", "comment": "…" }],
     "addEdges":    [{ "source": "<id>", "target": "<id>", "label": "" }],
     "updateEdges": [{ "id": "<id>", "status": "…", "label": "…" }],
     "removeNodes": ["<id>"], "removeEdges": ["<id>"] }
   ```

   Só `message` é obrigatório; um reply só com `message` responde sem mexer no desenho. Nó novo
   vai **sem** `x`/`y`. O adapter sobe o `rev`, recalcula só as setas dos nós alterados e escreve
   a mensagem no thread. Item inválido é pulado e relatado.

   **Aprovar e reprovar é gesto do usuário:** mude `status` quando ele pedir, ou para marcar como
   `questioned` o que você contesta. Não aprove nós por conta própria.

4. **Feche o pedido. Sem isso o canvas fica travado em modo leitura:**

   ```
   node "${CLAUDE_PLUGIN_ROOT}/adapters/live.js" done <requestId>                       # aplica o reply.json
   node "${CLAUDE_PLUGIN_ROOT}/adapters/live.js" done <requestId> --message "só texto"  # sem reply.json
   node "${CLAUDE_PLUGIN_ROOT}/adapters/live.js" done <requestId> --failed "motivo"     # não deu
   ```

5. O `reply.json` não cobre `fields` de ER, `lanes` e o modelo `seq`. Nesses casos edite o
   `workspace.json` direto, com `rev = atual + 1` e `updatedBy: "agent"`; escreva a resposta no
   `thread.json` (ou use `--message`) e rode o `done`.

## Schema do workspace.json

O contrato autoritativo está em `${CLAUDE_PLUGIN_ROOT}/docs/SCHEMA.md` e em
`web-next/src/types.ts`. O workspace sempre carrega os 5 modelos; preencha apenas o pertinente e
preserve integralmente os outros:

```json
{
  "title": "Assunto",
  "process": {
    "type": "flowchart", "title": "Assunto", "rev": 1, "updatedBy": "agent", "lanes": [],
    "nodes": [
      { "id": "n1", "label": "Início", "kind": "start", "status": "proposed", "comments": [] },
      { "id": "n2", "label": "Fim", "kind": "end", "status": "proposed", "comments": [] }
    ],
    "edges": [
      { "id": "e1", "source": "n1", "target": "n2", "label": "", "status": "proposed" }
    ]
  },
  "state": { "type": "flowchart", "title": "Assunto", "rev": 0, "updatedBy": "user", "lanes": [], "nodes": [], "edges": [] },
  "er":    { "type": "er",        "title": "Assunto", "rev": 0, "updatedBy": "user", "lanes": [], "nodes": [], "edges": [] },
  "mind":  { "type": "mindmap",   "title": "Assunto", "rev": 0, "updatedBy": "user", "lanes": [], "nodes": [], "edges": [] },
  "seq":   { "participants": [], "messages": [] },
  "rev": 1,
  "updatedBy": "agent"
}
```

- O `"title"` do **topo** é o título da sessão — é ele que aparece na barra do canvas. Sessão
  nova: escreva-o. Arquivo antigo, sem ele, continua abrindo (o título sai dos modelos), e o do
  topo manda quando os dois existem; não apague o `title` de dentro dos modelos.
- `process` serve Fluxograma **e** Swimlane; `state`, `er`, `mind` e `seq` têm modelos próprios.
  Lente vazia é normal: não invente conteúdo para preenchê-la.
- Kinds de fluxo: `start`, `task`, `decision`, `end`, `idea`. BPM: `event-start`,
  `event-intermediate`, `event-end`, `gateway-exclusive`, `gateway-parallel`, `subprocess`,
  `data-object`, `annotation`. Estado: `state`. ER: `entity`.
- `status`: `proposed`, `approved`, `questioned` ou `rejected`. A seta tem status próprio.
- `comments[]` é histórico. Preserve os comentários do usuário e acrescente os seus
  (`author: "agent"`).
- Mapa mental: uma árvore. A ideia central é o nó que não recebe seta; cada filho direto dela
  vira um ramo com cor própria. Kind `idea`.
- O roteamento automático é o padrão: omita `routing`, `waypoints` e `sourceSide`/`targetSide` em
  diagrama que o editor vai arrumar. Preserve esses campos quando já existirem.

## Contrato estrutural de processos

Vale para `process.type` igual a `flowchart`, `bpm` ou `swimlane`:

1. **Declare a fronteira.** Todo processo tem pelo menos um início (`start`/`event-start`) e pelo
   menos um fim (`end`/`event-end`).
2. **Prove o percurso.** Todo nó operacional é alcançável a partir de algum início **e** chega a
   algum fim. `annotation` fica fora da regra.
3. **Represente a realidade.** Vários gatilhos ou resultados legítimos viram vários inícios ou
   fins; não force um único só para arrumar o layout.
4. **Dúvida aparece no canvas.** Gatilho ou resultado incerto → crie o `start`/`end` candidato com
   `status: "questioned"` e um comment `kind: "question"`, em vez de omitir a fronteira.
5. **Decisões explicam os ramos.** Rotule as setas que saem de uma decisão e mantenha a direção
   principal do início para o fim. Laços reais continuam permitidos.
6. **Cheque antes de abrir.** Não entregue componente desconectado, nó órfão ou beco sem saída
   sem representá-lo como dúvida ou fim.

Escreva `nodes[]` **na ordem de leitura, com o início primeiro**, e em cada decisão a seta do
caminho principal antes da do desvio: o arranjo automático usa essa ordem.

## Posições e layout

- `x`/`y` são opcionais e representam o **centro** do nó.
- Em workspace novo, omita `x`/`y` de **todos** os nós: o editor compõe o desenho inteiro.
- Preserve toda posição existente. Quem tem `x`/`y` fica onde está; o editor posiciona só quem
  não tem. Não misture coordenadas improvisadas com nós sem posição.
- Swimlane é lente derivada: ignora as posições do Fluxograma e recalcula sempre.

### Raias (swimlane) — "quem faz o quê"

- `process.type: "swimlane"` e `process.lanes: [{ id, label, order }]`, uma por ator ou setor.
- Cada passo aponta o seu ator com `lane: "<id da raia>"`.
- Sem `lanes`, o editor avisa "sem raias definidas"; não invente uma faixa genérica.
- **O servidor não mescla `lanes`:** reescreva o array inteiro, além do `lane` de cada nó.

### Entidades (ER)

- Preencha `workspace.er`. Cada entidade é um nó `kind: "entity"`, `label` = nome da entidade.
- Campos em `fields: [{ name, type, key }]`, com `key` ∈ `pk` / `fk` / `null`.
- Relações são setas; cardinalidade em `sourceCard`/`targetCard` (`"1"` ou `"N"`).

## Regras de ouro

- **O servidor é a autoridade do `rev`.** Ao escrever direto no arquivo, grave exatamente
  `rev atual + 1` e `updatedBy: "agent"`. Sem isso o browser descarta a mudança.
- **Preserve o trabalho dele:** ids, posições, comments de `author: "user"`, `lanes`, `lane`,
  `fields`, `sourceCard`/`targetCard`. Você acrescenta; não apaga o que ele fez sem ele pedir.
- **A seta tem status próprio.** Propague veredito só nas setas do nó que mudou.
- **Interlocutor, não eco:** se ele reprovou um nó, entenda o porquê (o comment) e proponha uma
  alternativa concreta no diagrama.
- Uma sessão = um problema. Vários problemas = vários slugs.

## Estado / arquivos

```
<projeto>/.flowforge/
    tasks.json          tarefas ao vivo do agente — do PROJETO, não de uma sessão
    activity.jsonl      linha do tempo: o que o agente fez (hook do harness)
    <slug>/
        workspace.json  fonte da verdade: 5 modelos + rev + updatedBy
        thread.json     a conversa usuário ↔ agente
        inbox.jsonl     log dos cliques em "Analisar" (recuperação)
        reply.json      transitório: a sua resposta; o adapter aplica e apaga
```
