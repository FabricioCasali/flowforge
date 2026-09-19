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
<data-dir>/tasks.json      as tarefas ao vivo do agente — do PROJETO, não de uma sessão
<data-dir>/activity.jsonl  o que o agente fez, na ordem (linha do tempo)
```

## workspace.json

```jsonc
{
  "title": "O assunto da sessão",
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

O `title` que vale é o **do topo**: é o título da SESSÃO, e um workspace é um assunto só
visto por 6 lentes. Ele é opcional — arquivo sem ele (escrito antes do campo, ou por um
agente que só conhece o `title` de dentro do modelo) abre com o título derivado dos
modelos, na ordem `process`, `state`, `er`, `mind`. **Quando os dois existem, o do topo
manda**, e o de dentro dos modelos continua no arquivo: nada é apagado. Renomear no
editor é uma escrita só, no topo.

O `rev` que vale também é o do topo; o `rev` de dentro de cada modelo é um espelho de
quando aquela lente foi tocada pela última vez.

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

## tasks.json — as tarefas ao vivo do agente

Fica na **raiz** do `<data-dir>`, não dentro de uma sessão: é do **projeto**. O que o agente
está fazendo no terminal não pertence a um desenho, e aparece na lente **Tarefas** de qualquer
sessão aberta.

```jsonc
{
  "rev": 12,
  "lists": [
    { "id": "claude-code",            // quem publica — estável entre escritas
      "label": "Claude Code",         // o nome mostrado no canvas
      "title": "Migrar o login",      // o objetivo desta leva (opcional)
      "updatedAt": 1789760000000,
      "tasks": [
        { "id": "t1", "title": "ler o código", "status": "completed" },
        { "id": "t2", "title": "escrever o teste", "status": "in_progress",
          "note": "cobrindo o refresh do token", "updatedAt": 1789760000000,
          "node": { "session": "login", "id": "n7" } },   // opcional: a etapa do desenho
        { "id": "t3", "title": "trocar a lib", "status": "blocked", "note": "falta decidir qual" }
      ] }
  ]
}
```

`status`: `pending`, `in_progress`, `completed` ou `blocked`. `note` é uma linha curta — o que está
sendo feito agora, ou por que travou. Uma **lista por publicador**: dois agentes no mesmo projeto
não pisam um no outro.

`node` é **opcional** e liga a tarefa a uma etapa do desenho: o nó apontado por uma tarefa
`in_progress` aparece **vivo** no canvas daquela sessão (travado, se a tarefa estiver `blocked`), e
volta ao normal quando ela conclui. Tarefa sem `node` se comporta exatamente como antes.

- Leva o `session` porque `tasks.json` é do **projeto** e o desenho é de uma **sessão**: só o id do
  nó não diria em qual prancheta procurar.
- **Não leva o modelo** (`process`/`state`/`er`/`mind`), de propósito: o id é procurado na sessão
  aberta, e um id que não existe ali simplesmente não acende nada. Guardar a lente obrigaria o
  agente a saber em qual delas o usuário desenhou.
- É **estado derivado**: o realce sai daqui, nunca do `workspace.json` — ligar uma tarefa, mudar o
  status dela ou desligá-la **não sobe o `rev` do desenho** nem grava nada nele.
- Meio elo (só `session`, só `id`) é descartado na leitura, como qualquer outro lixo do arquivo.

**Não é um modelo do `workspace.json`, de propósito.** O agente escreve aqui várias vezes por
minuto enquanto você edita o diagrama; dentro do workspace, cada tarefa concluída subiria o `rev`
do desenho e disputaria a escrita com o arrasto de um nó.

**Não edite este arquivo à mão — use o comando.** Mais de um processo escreve nele (um por agente),
e o comando faz leitura-modificação-gravação sob trava, com rename atômico:

```
node <flowforge>/adapters/tasks.js plan "Migrar o login" "ler o código" "escrever o teste" "trocar a lib"
node <flowforge>/adapters/tasks.js start 2 "cobrindo o refresh do token"
node <flowforge>/adapters/tasks.js done 2
node <flowforge>/adapters/tasks.js block 3 "falta decidir qual"
node <flowforge>/adapters/tasks.js add "avisar o time"      # também: reset, note, clear, show
node <flowforge>/adapters/tasks.js start 2 --node login/n7  # marca e já liga à etapa do desenho
node <flowforge>/adapters/tasks.js link 3 login/n9          # liga uma tarefa que já existe
node <flowforge>/adapters/tasks.js unlink 3                 # desfaz o elo
node <flowforge>/adapters/tasks.js from-plan login          # a lista sai do plano aprovado no canvas
```

**O plano aprovado.** `from-plan <sessão> ["<objetivo>"]` lê o modelo `process` daquela sessão — um
fluxograma comum, pelo "Contrato estrutural de processos" — e cria uma tarefa por etapa
**`approved`**, na ordem de leitura do fluxo (percurso a partir do início, caminho principal antes
do desvio) e já com `node: { session, id }`. Só os kinds de trabalho viram tarefa (`task`,
`subprocess`); início, fim, decisão, gateway, evento, anotação e objeto de dados não. O que ficou
de fora é impresso com o motivo. Não há kind novo nem campo novo: o veredito da etapa é o
`approved`/`questioned`/`rejected` que o usuário já dá no browser, e **aprovar é gesto dele**.

Rodar de novo depois de uma revisão nova **reconcilia** em vez de refazer: a tarefa é reencontrada
pelo elo, etapa que continua aprovada mantém status e nota, etapa nova aprovada entra na posição do
fluxo, e etapa que deixou de estar aprovada vira `blocked` com o motivo — sumir esconderia que algo
planejado não vai ser feito. Tarefa sem elo (ou ligada a outra sessão) é preservada. Por isso
`start` numa tarefa ligada a um nó do `process` que não está `approved` é recusado com exit 2;
`--force` passa por cima quando o usuário mandar seguir assim mesmo. Nada disso escreve no
`workspace.json`.

`--node <sessão>/<nó>` vale em `add` e `start`; o `plan` não tem sintaxe de elo (marcar o nó dentro
do título comeria texto de verdade — "revisar o handler @auth/login"), então ali se liga depois com
`link`. A validação é só de **formato**: a sessão e o nó não precisam existir ainda (dá para planejar
antes de desenhar), e sessão inexistente vira **aviso** no stdout, não erro.

Ele acha o `.flowforge/` subindo a partir do diretório atual e adivinha o publicador pelo ambiente
(`--list <id>` e `--label <nome>` mandam, e são o jeito de ter dois terminais do mesmo harness com
listas separadas). O browser **só lê**; um arquivo torto é normalizado, não derruba o canvas.

## activity.jsonl — a linha do tempo do agente

Irmão do `tasks.json`: na raiz do `<data-dir>`, por projeto, fora do workspace. **Append-only**,
uma linha JSON por ação:

```jsonc
{ "ts": 1789760000000,
  "source": "claude-code", "label": "Claude Code",   // o mesmo publicador do tasks.json
  "kind": "edit",          // read | edit | run | search | web | agent | tool | note | prompt | stop
  "summary": "editou web-next/src/editor/layout.ts",  // UMA linha
  "files": ["web-next/src/editor/layout.ts"],         // relativos ao projeto
  "task": "t3",            // a tarefa in_progress do publicador naquele instante
  "failed": true }         // só quando a ação falhou
```

`task` é o elo com as tarefas, carimbado na hora da escrita: é dele que saem "arquivos tocados por
tarefa" e "o que ele está fazendo agora", sem o agente declarar nada. `prompt` e `stop` são marcos de
turno, sem texto.

**É narração, não transcrição.** Nunca entram: o texto do pedido do usuário, a resposta do agente,
o conteúdo de arquivo, a saída de ferramenta, o comando cru (só a descrição dele, ou o programa e o
subcomando), a query de uma URL, os argumentos de uma ferramenta MCP. Arquivo fora do projeto
aparece só pelo nome. Isto é um arquivo dentro do seu projeto — trate como tal.

Quem escreve é o comando, chamado por um hook do harness ou pelo próprio agente:

```
node <flowforge>/adapters/activity.js install claude-code      # liga o hook NESTE projeto
node <flowforge>/adapters/activity.js install claude-code --global
node <flowforge>/adapters/activity.js install opencode         # no OpenCode o gancho é um plugin
node <flowforge>/adapters/activity.js note "decidi trocar a lib só depois do teste"
node <flowforge>/adapters/activity.js show
```

Cada harness liga o gancho do jeito dele — entrada de settings no Claude Code, arquivo de plugin em
`.opencode/plugin/` no OpenCode — e quem sabe disso é `adapters/hooks/<harness>.js`, não o núcleo.

O hook nunca atrapalha o harness: projeto sem `.flowforge/` sai calado, qualquer erro sai `0`, e roda
assíncrono. O arquivo é podado sozinho (fica o fim) — é linha do tempo, não auditoria.

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

6. **Processo tem começo e fim, e o arquivo conta a história na ordem.** Em `process`, todo
   fluxo tem pelo menos um `start`/`event-start` e um `end`/`event-end`, toda etapa é alcançável
   a partir de um início e chega a algum fim (`annotation` fica fora). Escreva `nodes[]` **na
   ordem de leitura, com o início primeiro**, e em cada decisão a seta do caminho principal antes
   da do desvio: o arranjo automático e o modo guiado usam essa ordem pra decidir o que vem
   primeiro. O editor confere e acusa no HUD (`⚠ sem início`, `⚠ 3 fora do percurso`…).

7. **Não ancore seta em diagrama que o editor vai arrumar.** `sourceSide`/`targetSide` e
   `waypoints` valem pra UMA geometria. Em nó sem `x`/`y` eles brigam com o arranjo automático;
   só grave quando estiver compondo as posições na mão, e pra expressar algo que o traço
   automático não expressa (o laço de volta saindo pelo lado, por exemplo). O editor ignora no
   traço a âncora que custa uma volta inteira, mas o arquivo fica mentindo.

8. **Termine escrevendo no `thread.json` e enviando `completed`.** O arquivo é a resposta
   visível; a mensagem do protocolo com o mesmo `requestId` é o que solta a trava. Ordem
   segura: `workspace.json`, `thread.json`, `completed`.

## Protocolo WebSocket

`/ws?session=<slug>` — o browser:

| direção | mensagem |
| --- | --- |
| recebe | `{ type:'state', session, workspace, thread, busy, agentOnline, agentLabel }` |
| recebe | `{ type:'busy', session, busy }` |
| recebe | `{ type:'agent', online, label }` |
| recebe | `{ type:'tasks', tasks }` — o `tasks.json` do projeto; ao conectar e a cada mudança, em toda sessão |
| recebe | `{ type:'activity', events }` — as últimas 200 ações do `activity.jsonl`; ao conectar e a cada ação |
| envia | `{ type:'patch', session, lens, diagram }` — `lens` ∈ `process\|state\|er\|mind\|seq` |
| envia | `{ type:'rename', session, title }` — o título da SESSÃO (o `title` do topo); uma escrita, um `rev` |
| envia | `{ type:'analyze', session, note }` |

`rename` obedece à mesma trava do `patch`: durante o `busy` o servidor recusa e devolve o
estado do disco. Título vazio não renomeia.

`/agent` — o adapter externo: recebe `{type:'hello', protocol:1}`, registra-se com
`{type:'register', protocol:1, adapterId, label}` e recebe eventos `analyze` com
`requestId`, `workspacePath`, `threadPath` e `projectPath` absolutos. Responde com
`accepted`, `completed` ou `failed`, sempre repetindo o `requestId`. Enquanto trabalha, pode mandar
`{type:'progress', requestId}` quantas vezes quiser: é um batimento que **rearma o prazo da trava**
(3 min por padrão, `FLOWFORGE_BUSY_TIMEOUT_MS`) e não registra nada — sem ele, uma análise mais
longa que o prazo tem o adapter desconectado no meio do trabalho. Pedidos sem terminal
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
no caminho — inclusive os que este documento não nomeia. O `title` do diagrama antigo vira
o título da sessão, no topo, **sem sair de dentro do modelo copiado**.

A mesma ideia vale para um `workspace.json` anterior ao `title` do topo: ele abre com o
título derivado dos modelos, e o campo do topo aparece na primeira escrita — nada é
convertido em massa e nada é apagado.
