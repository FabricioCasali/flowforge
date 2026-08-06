# FlowForge

Um canvas de diagramas que roda na sua máquina e serve para pensar um problema **junto
com um agente de código**. Você desenha o fluxo, marca o que aprova, reprova ou
questiona, clica **Analisar** — e o agente responde **editando os arquivos do diagrama**.
O canvas atualiza sozinho, sem refresh.

O problema que ele resolve: desenho de arquitetura costuma morrer em imagem — bonito,
congelado, longe do código. E discutir arquitetura só por texto perde a forma. Aqui o
diagrama é um JSON dentro do próprio projeto, versionado junto com o código, e é esse
arquivo que serve de canal entre você e o agente.

Tudo é local: um processo Node, um browser. Sem serviço externo, sem chave de API.

## O que muda em relação a um editor de diagramas comum

**O arquivo é a fonte da verdade.** O servidor não guarda estado — ele espelha
`workspace.json` ↔ browser com `fs.watch`. Quem edita o arquivo (você pelo canvas, o
agente pelo disco, você pelo `vim`) aparece na tela dos dois lados.

**O agente não fala com o canvas, ele edita o arquivo.** Não existe API de desenho para
ele chamar, nem formato intermediário: ele lê `workspace.json`, escreve `workspace.json`
com `rev+1` e `updatedBy:"claude"`, e o `fs.watch` faz o resto. É o mesmo caminho que
você usaria na mão.

**O desenho carrega a decisão, não só a forma.** Cada nó tem status
(`proposed` / `approved` / `questioned` / `rejected`) e um histórico de comentários com
autor. Reprovar um nó pede o motivo, e o motivo fica no arquivo — o agente lê isso e
rebate.

```
browser  --(WS patch)-->  servidor  --grava-->  <dados>/<sessão>/workspace.json
                                                        |
agente   --edita o arquivo------------------------------+   (rev+1, updatedBy:"claude")
                                                        |
browser  <--(WS state)--  servidor  <--fs.watch---------+   (o canvas atualiza sozinho)

clique "Analisar"  --(WS)-->  servidor  --(WS /claude)-->  agente conectado
```

## Rodar em 5 minutos

Precisa de **Node 20 ou mais novo** e um browser. Depois de instalado, funciona offline
(as fontes são auto-hospedadas, nada vem de CDN).

```bash
git clone https://github.com/FabricioCasali/flowforge.git
cd flowforge

npm install                    # o servidor: só a lib `ws`
cd web-next && npm install && npm run build && cd ..

node server/index.js --data-dir "./.flowforge" --port 4317 --session meu-problema
```

Abra `http://localhost:4317/?session=meu-problema`.

O `--data-dir` é onde os diagramas ficam. O uso pretendido é apontá-lo para **o projeto
sobre o qual você está desenhando**, para o diagrama ser versionado com o código:

```bash
node server/index.js --data-dir "/caminho/do/seu/projeto/.flowforge" --port 4317
```

Argumentos:

| argumento | o que faz |
| --- | --- |
| `--data-dir <dir>` | raiz das sessões (padrão: `sessions/` aqui do repo; também lê `FLOWFORGE_DATA`) |
| `--port <n>` | porta HTTP/WS (padrão `4317`; também lê `PORT`) |
| `--session <slug>` | cria/abre uma sessão já na subida e vira o padrão de quem não passa `?session=` |

Trocar de sessão no browser: o seletor na barra do topo, ou `?session=<slug>` na URL.
Sessão que não existe é criada na hora.

Para desenvolver o front com hot reload: `cd web-next && npm run dev` (o servidor Node
continua sendo quem fala com os arquivos — mantenha ele no ar).

## Ligar o agente

O servidor abre um WebSocket em `ws://localhost:4317/claude`. Quem se conectar ali
recebe, em JSON, cada clique em **Analisar**:

```json
{ "kind": "analyze", "session": "meu-problema", "note": "e se a fila cair?",
  "workspacePath": "<abs>/meu-problema/workspace.json",
  "workspaceRev": 3,
  "threadPath": "<abs>/meu-problema/thread.json", "at": "2026-08-06T12:00:00.000Z" }
```

O contrato de resposta tem dois passos, e os dois importam:

1. **edite o `workspacePath`** — mexa nos nós/arestas, responda comentários, e grave com
   `rev` do topo somado em 1 e `updatedBy: "claude"`. Sem isso o browser descarta a
   escrita;
2. **escreva no `threadPath`** — acrescente `{"author":"claude","text":"…","ts":<ms>}` em
   `messages[]`. É a sua resposta na conversa, **e** é o que destrava o canvas: ao
   despachar o "Analisar" a sessão entra em modo leitura, e ela só sai de lá quando uma
   mensagem `claude` aparece no thread (ou após 180s de timeout).

O formato dos arquivos está em [`docs/SCHEMA.md`](docs/SCHEMA.md).

**Com o Claude Code**, é isso que a integração faz: um monitor de WebSocket persistente
apontado para `ws://localhost:4317/claude`, e um prompt (uma skill, um `CLAUDE.md`) que
ensine o schema e as duas regras acima. Vale para qualquer agente que saiba ler um socket
e escrever um arquivo — não há nada específico de um fornecedor no servidor.

Para conferir que o canal está de pé, sem agente nenhum:

```js
// node monitor.js — imprime cada "Analisar"
const { WebSocket } = require('ws');
const ws = new WebSocket('ws://localhost:4317/claude');
ws.on('message', (raw) => console.log(raw.toString()));
```

A barra do topo mostra as **duas** conexões separadas: a sua com o servidor e a do
agente. Com ninguém ouvindo em `/claude`, o botão avisa antes do clique — o pedido não se
perde, vai para o `inbox.jsonl` da sessão e pode ser lido depois.

## As 6 lentes

O mesmo assunto, visto de seis jeitos. Elas leem 5 modelos que convivem no mesmo
`workspace.json`, e trocar de lente não converte nada: cada modelo tem o conteúdo dele.

- **Fluxograma** — o processo passo a passo, de cima para baixo, com o vocabulário de
  fluxo e de BPM (tarefa, decisão, gateway, evento, subprocesso, anotação).
- **Swimlane** — o mesmo grafo do Fluxograma em raias por ator/setor: quem faz o quê, e
  onde uma seta cruza a fronteira entre dois times. É derivada — o arranjo é recalculado,
  não gravado.
- **Máq. estados** — os estados de uma entidade e as transições permitidas entre eles.
- **ER** — entidades com campos (`pk`/`fk`) e relações com cardinalidade `1`/`N`.
- **Mind map** — ideias abrindo a partir de um centro, para a fase em que o problema
  ainda não tem forma de processo.
- **Sequência** — participantes e as mensagens trocadas entre eles, na ordem do tempo.

## O que dá para fazer no canvas

- **Criar** arrastando da paleta (cada item mostra a silhueta real da forma), clicando, ou
  com duplo-clique no vazio. **Ligar** pelos nós dos quatro lados de cada caixa — o lado
  escolhido fica gravado e a seta sai por ele. **Apagar** com `Del`/`Backspace`, que leva
  as arestas penduradas junto.
- **Card do nó**: rótulo, tipo, descrição técnica, notas, campos (na lente ER), raia (na
  Swimlane) e os botões de veredito. **Card da aresta**: rótulo, status próprio e
  cardinalidade.
- **Roteamento ortogonal** com desvio de obstáculo, e quebras manuais arrastáveis quando
  você quiser mandar no traço.
- **Desfazer/refazer** (`Ctrl+Z` / `Ctrl+Shift+Z`, 20 níveis por lente), **busca** com
  salto para o nó, **arranjos** automáticos (vertical, horizontal, árvore, radial, força)
  e **export** para PNG, SVG e Mermaid.
- Quando o agente responde, o que ele mexeu fica realçado, com um atalho para saltar até lá.

## Estrutura de pastas

```
server/            a ponte: HTTP + WebSocket + estado em arquivo (Node puro + ws)
  index.js         rotas, WS /ws (browser) e /claude (agente), fs.watch por sessão
  state.js         leitura/escrita da sessão, autoridade do `rev`, migração
web-next/          o editor (Vite + React + TypeScript + @xyflow/react + elkjs)
  src/types.ts     o contrato do modelo — campo novo entra aqui antes de ser usado
  src/editor/      canvas, lentes, layout, formas, roteamento, export
scripts/           verificadores: migração sem perda, layout fiel, caminho de escrita
docs/              notas do projeto (BOARD.md é o quadro de tarefas)
sessions/          dados, quando você não passa --data-dir (fora do git)
```

Uma pasta por sessão dentro do `--data-dir`:

```
<data-dir>/<slug>/
    workspace.json   os 5 modelos + rev + updatedBy — o arquivo-verdade
    thread.json      a conversa entre você e o agente
    inbox.jsonl      log append-only dos cliques em "Analisar" (recuperação)
```

Sessão criada por uma versão antiga tem um `diagram.json`. Na primeira abertura ele é
convertido para `workspace.json` e **preservado como está** — a conversão não apaga nem
reescreve o arquivo antigo.

O servidor também expõe `GET /api/health`, `/api/sessions` e `/api/state?session=<slug>`,
úteis para script e para checar em que diretório de dados ele subiu.

## Contribuir

Ver [CONTRIBUTING.md](CONTRIBUTING.md). É um projeto pessoal, aberto porque é útil para
mais gente que só o autor — issues e PRs são bem-vindos, com a ressalva de que o rumo
segue o uso diário de quem o mantém.

## Licença

MIT — ver [LICENSE](LICENSE).
