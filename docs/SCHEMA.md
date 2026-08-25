# O formato dos arquivos

Este é o contrato entre o editor, o servidor e qualquer agente que queira participar do
loop. O arquivo é a fonte da verdade: quem entende o que está aqui consegue ler e escrever
um diagrama sem passar por API nenhuma.

A definição autoritativa em código é `web-next/src/types.ts` — campo novo entra lá antes
de ser consumido por qualquer lado.

## Uma sessão

```
<data-dir>/<slug>/
    workspace.json   os 5 modelos + rev + updatedBy
    thread.json      a conversa
    inbox.jsonl      log append-only dos cliques em "Analisar"
```

## workspace.json

```jsonc
{
  "process": { "type": "flowchart|bpm|swimlane", "title": "…",
               "rev": 3, "updatedBy": "user", "lanes": [], "nodes": [], "edges": [] },
  "state":   { "type": "flowchart", "title": "…", "lanes": [], "nodes": [], "edges": [] },
  "er":      { "type": "er",        "title": "…", "lanes": [], "nodes": [], "edges": [] },
  "mind":    { "type": "mindmap",   "title": "…", "lanes": [], "nodes": [], "edges": [] },
  "seq":     { "participants": [{ "id": "p1", "label": "Serviço A" }],
               "messages": [{ "from": "p1", "to": "p2", "label": "…", "kind": "call" }] },
  "rev": 3,
  "updatedBy": "user"
}
```

São **5 modelos** lidos por **6 lentes**: `process` serve o Fluxograma **e** a Swimlane
(mesmo grafo, arranjo diferente); `state`, `er` e `mind` têm uma lente cada; `seq` não é
um diagrama — é participantes e mensagens, sem `nodes`/`edges`.

Preencha só as lentes que fazem sentido para o assunto. Lente vazia (`nodes: []`) é o
normal, e é melhor que lente inventada para não ficar vazia.

O `title` de cada modelo é o título da sessão. O `rev` que vale é o **do topo**; o `rev`
de dentro de cada modelo é um espelho de quando aquela lente foi tocada pela última vez.

### Nó

```jsonc
{
  "id": "n1",
  "label": "Validar título",
  "kind": "task",
  "status": "proposed",            // proposed | approved | questioned | rejected
  "description": "detalhamento técnico: lógica, serviço, tabela",
  "comments": [
    { "author": "user", "kind": "reject", "text": "e se a fila cair?", "ts": 0 }
  ],
  "x": 420, "y": 180,              // opcionais — CENTRO do nó, não o canto
  "lane": "l1",                    // só na Swimlane
  "fields": [                      // só no ER
    { "name": "id", "type": "int", "key": "pk" }
  ]
}
```

`kind` escolhe a forma. Os conhecidos:

| família | kinds |
| --- | --- |
| fluxo | `start`, `task`, `decision`, `end`, `idea` |
| BPM | `event-start`, `event-intermediate`, `event-end`, `gateway-exclusive`, `gateway-parallel`, `subprocess`, `data-object`, `annotation` |
| estado | `state` |
| ER | `entity` |

`kind` desconhecido não some do canvas: vira retângulo.

`comments[]` é a linha do tempo do nó. `kind` do comentário: `note` (anotação livre),
`reject` (motivo da reprovação), `question` (o que foi questionado). Reprovar ou
questionar no browser abre um campo pedindo o motivo, e é dali que vem a entrada.

### Aresta

```jsonc
{
  "id": "e1",
  "source": "n1", "target": "n2",
  "label": "não",
  "status": "proposed",
  "sourceSide": "bottom", "targetSide": "top",   // opcional: ancora a ponta num lado
  "sourceCard": "1", "targetCard": "N",          // cardinalidade, só no ER
  "routing": "segments",                          // segments | bezier
  "waypoints": [{ "x": 300, "y": 240 }]           // quebras manuais, coords do canvas
}
```

Sem `routing`/`waypoints` o roteador ortogonal decide o traço (e desvia dos nós no
caminho). Com `waypoints` + `routing: "segments"`, quem manda são os pontos.

### Raias

```jsonc
"lanes": [ { "id": "l1", "label": "Atendimento", "order": 0 } ]
```

Ficam no topo do modelo, e cada nó aponta a sua com `lane`. **O servidor não mescla esse
array**: quem grava reescreve `lanes` inteiro, senão as raias somem.

## thread.json

```jsonc
{ "messages": [ { "author": "user|agent|system", "text": "…", "ts": 1754400000000 } ] }
```

## Regras que quebram o desenho se forem ignoradas

1. **Sempre suba o `rev` do topo em 1 e marque `updatedBy: "agent"`.** O servidor é a
   autoridade do `rev` para as escritas que vêm do browser; a escrita direta no arquivo é
   responsável pelo próprio incremento. Sem isso o browser descarta a mudança.

2. **`x`/`y` é o CENTRO do nó, não o canto superior-esquerdo.** Num fluxo vertical, todos
   os nós da mesma coluna têm o mesmo `x`. Escrever pensando em canto desloca o diagrama
   inteiro, e o erro fica pior quanto mais larga é a caixa.

3. **Nó novo pode ir sem `x`/`y` — e esse é o melhor default.** O editor posiciona quem
   não tem posição com o elk, no referencial do desenho que já existe, e desempilha se
   cair em cima de alguém. Só escreva `x`/`y` quando quiser **mover** um nó existente.

4. **A seta tem status próprio.** Ao mudar o status de um nó, recalcule só as arestas
   **daquele** nó (as duas pontas com o mesmo status não-neutro → a seta pega esse status;
   senão volta para `proposed`). Recalcular o diagrama inteiro apaga marcação de seta do
   outro lado do desenho.

5. **Preserve o que já está lá.** Ids, posições, `comments` do autor `user`, `lanes`,
   `lane`, `fields`, `sourceCard`/`targetCard`, `sourceSide`/`targetSide`, `waypoints`.
   Campo que você não conhece também sobrevive — a normalização do servidor completa o que
   falta e não poda o resto.

6. **Termine escrevendo no `thread.json` e enviando `completed`.** O arquivo é a resposta
   visível; a mensagem do protocolo com o mesmo `requestId` é o que solta a trava. Ordem
   segura: `workspace.json`, `thread.json`, `completed`.

## Protocolo WebSocket

`/ws?session=<slug>` — o browser:

| direção | mensagem |
| --- | --- |
| recebe | `{ type:'state', session, workspace, thread, busy, agentOnline, agentLabel }` |
| recebe | `{ type:'busy', session, busy }` |
| recebe | `{ type:'agent', online, label }` |
| envia | `{ type:'patch', session, lens, diagram }` — `lens` ∈ `process\|state\|er\|mind\|seq` |
| envia | `{ type:'analyze', session, note }` |

`/agent` — o adapter externo: recebe `{type:'hello', protocol:1}`, registra-se com
`{type:'register', protocol:1, adapterId, label}` e recebe eventos `analyze` com
`requestId`, `workspacePath`, `threadPath` e `projectPath` absolutos. Responde com
`accepted`, `completed` ou `failed`, sempre repetindo o `requestId`. Pedidos sem terminal
ficam no `inbox.jsonl` e são reenviados. Dentro de uma sessão os pedidos são entregues em
série; sessões diferentes podem avançar em paralelo. `/claude` é apenas um alias temporário
de URL e exige o mesmo registro de `/agent`.

A entrega é pelo menos uma vez. Queda ou timeout desconectam o adapter, mas mantêm a sessão
travada e o pedido pendente; na reconexão ele volta com o mesmo `requestId`. O adapter deve
deduplicar esse identificador entre reconexões e não pode iniciar duas execuções do mesmo
pedido.

## Migração de sessão antiga

Versões anteriores gravavam um `diagram.json` — um único diagrama de um único tipo. Na
primeira abertura de uma sessão assim, o servidor converte para `workspace.json` e
**mantém o `diagram.json` intocado**, como backup. O mapa é `flowchart|bpm|swimlane` →
`process` (o `type` de dentro é preservado, e é ele que sustenta as raias e as formas
BPM), `er` → `er`, `mindmap` → `mind`; `state` e `seq` nascem vazios. A conversão é por
cópia integral do diagrama para dentro do modelo de destino, então nenhum campo se perde
no caminho — inclusive os que este documento não nomeia.
