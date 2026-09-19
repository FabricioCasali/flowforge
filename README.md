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
com `rev+1` e `updatedBy:"agent"`, e o `fs.watch` faz o resto. É o mesmo caminho que
você usaria na mão.

**O desenho carrega a decisão, não só a forma.** Cada nó tem status
(`proposed` / `approved` / `questioned` / `rejected`) e um histórico de comentários com
autor. Reprovar um nó pede o motivo, e o motivo fica no arquivo — o agente lê isso e
rebate.

```
browser  --(WS patch)-->  servidor  --grava-->  <dados>/<sessão>/workspace.json
                                                        |
agente   --edita o arquivo------------------------------+   (rev+1, updatedBy:"agent")
                                                        |
browser  <--(WS state)--  servidor  <--fs.watch---------+   (o canvas atualiza sozinho)

clique "Analisar"  --(WS)-->  servidor  --(WS /agent)-->  adapter do usuário
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

O servidor abre um WebSocket em `ws://localhost:4317/agent`. O harness escolhido pelo
usuário conecta por meio de um adapter externo, recebe o `hello` e se registra:

```json
{ "type": "register", "protocol": 1, "adapterId": "meu-adapter", "label": "OpenCode" }
```

Depois do registro, cada clique em **Analisar** produz:

```json
{ "type": "analyze", "protocol": 1, "requestId": "<uuid>",
  "session": "meu-problema", "note": "e se a fila cair?",
  "workspacePath": "<abs>/meu-problema/workspace.json",
  "workspaceRev": 3,
  "threadPath": "<abs>/meu-problema/thread.json", "at": "2026-08-06T12:00:00.000Z" }
```

O contrato de resposta tem quatro passos, e os quatro importam:

1. envie `accepted` com o mesmo `requestId`;
2. edite o `workspacePath`, subindo o `rev` do topo e marcando `updatedBy: "agent"`;
3. acrescente `{"author":"agent","text":"…","ts":<ms>}` ao `threadPath`;
4. envie `completed` ou `failed` com o mesmo `requestId`, liberando a trava do canvas.

O transporte é pelo menos uma vez: depois de queda ou timeout, o mesmo `requestId` pode
ser reenviado. O adapter deve deduplicá-lo entre reconexões e nunca iniciar uma segunda
execução para um pedido que ainda esteja trabalhando. Pedidos da mesma sessão chegam em
série.

O formato dos arquivos está em [`docs/SCHEMA.md`](docs/SCHEMA.md).

Enquanto trabalha, o adapter pode enviar `{"type":"progress","requestId":"…"}`: é um batimento
que rearma o prazo da trava (3 minutos por padrão), para análises longas.

O servidor e o editor não executam nem escolhem Claude Code, OpenCode, Codex ou outro produto. O
adapter traduz este protocolo para o harness preferido do usuário e registra o nome que a
interface deve mostrar. Apenas um adapter fica ativo por vez.

### Instalar como plugin do Claude Code

O repositório **é** um plugin: traz a skill `/flowforge` (que ensina o agente a subir o servidor,
desenhar, publicar as tarefas e responder ao Analisar) e o hook da linha do tempo.

```
/plugin marketplace add FabricioCasali/flowforge
/plugin install flowforge@flowforge
```

É preciso ter Node e `npm`: o repositório não versiona dependências nem o front compilado, então na
primeira vez a skill prepara a instalação sozinha (um ou dois minutos). Veja a
[issue #15](https://github.com/FabricioCasali/flowforge/issues/15).

Para experimentar sem instalar: `claude --plugin-dir <pasta do clone>`. Depois é só pedir —
"abre o flowforge e me mostra o andamento desta task". O hook da linha do tempo é global, mas não
faz nada em projeto que não tenha uma pasta `.flowforge/`; quem não quiser, desabilita o plugin.

### Usar no OpenCode

O OpenCode não instala plugin do Claude Code, mas lê a mesma skill. Com o repositório clonado em
`<clone>`, acrescente ao `opencode.json` (ou `~/.config/opencode/opencode.jsonc`):

```jsonc
{
  "skills": { "paths": ["<clone>/skills"] },
  "permission": { "external_directory": { "<clone>/*": "allow" } }
}
```

A permissão importa: a skill manda o agente ler e executar arquivos de `<clone>`, que fica **fora**
do projeto em que você está trabalhando. Sem ela o OpenCode pergunta a cada acesso — e no modo não
interativo (`opencode run`) rejeita. Validado com um agente de verdade: skill carregada, servidor
no ar, mapa criado e tarefas publicadas como "OpenCode". O que ainda não existe ali é a sessão
aberta responder ao Analisar ([#10](https://github.com/FabricioCasali/flowforge/issues/10)).

### Quem responde

O melhor respondedor é a sessão de CLI que você **já tem aberta** no projeto: ela sabe o que está
sendo feito. O [`adapters/live.js`](adapters/README.md#sessão-viva) é uma ponte que não chama
ninguém — imprime cada pedido numa linha, e o harness que vigia o processo acorda a sessão. No
Claude Code isso é a ferramenta Monitor.

A escuta do agente **cai sozinha** de tempos em tempos (no Claude Code, a cada 30 minutos). O canvas
não esconde isso: o indicador vira **"agente desconectado"** e um aviso diz o que fazer — no terminal
do seu agente, peça **"reconecte o FlowForge"**. Nada se perde: o Analisar clicado nesse intervalo
fica guardado e é entregue na reconexão.

### Adapters prontos (execução à parte)

O repositório traz, em [`adapters/`](adapters/README.md), um adapter para três harnesses. Com o
servidor no ar e o CLI do harness instalado e autenticado:

```
node adapters/index.js claude-code     # ou: opencode | codex
```

A barra do topo passa a mostrar o agente conectado, e o **Analisar** chega nele. Cada sessão do
FlowForge mantém a própria conversa no harness: o segundo pedido lembra do primeiro. Para outro
harness, escreva um driver — são ~40 linhas, e o [README dos adapters](adapters/README.md) explica.

Para conferir que o canal está de pé, sem agente nenhum:

```js
// node monitor.js — imprime cada "Analisar"
const { WebSocket } = require('ws');
const ws = new WebSocket('ws://localhost:4317/agent');
ws.on('message', (raw) => {
  const msg = JSON.parse(raw);
  if (msg.type === 'hello') ws.send(JSON.stringify({ type: 'register', protocol: 1, adapterId: 'monitor', label: 'Monitor' }));
  else console.log(msg);
});
```

A barra do topo mostra as **duas** conexões separadas: a sua com o servidor e a do
agente. Sem adapter registrado em `/agent`, o botão avisa antes do clique. O pedido fica
pendente no `inbox.jsonl` e é reenviado com o mesmo `requestId` quando um adapter conectar.
`/claude` existe somente como alias temporário de URL e usa exatamente o mesmo protocolo
de registro de `/agent`.

## As lentes

O mesmo assunto, visto de seis jeitos — mais uma sétima lente, **Tarefas**, que não é desenho. Elas leem 5 modelos que convivem no mesmo
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
- **Tarefas** — o que o agente tem para fazer no projeto e em que pé está, ao vivo. Não lê o
  `workspace.json`: o conteúdo vem de um `tasks.json` que o próprio agente mantém (abaixo).

## Tarefas ao vivo

O agente que está trabalhando no seu projeto publica o plano dele e vai marcando o andamento; a
lente **Tarefas** atualiza sozinha, e o botão dela mostra o placar (`3/8`) de dentro de qualquer
diagrama. É um arquivo como os outros — `<data-dir>/tasks.json` — escrito por um comando que
qualquer agente com shell consegue chamar:

```
node <flowforge>/adapters/tasks.js plan "Migrar o login" "ler o código" "escrever o teste"
node <flowforge>/adapters/tasks.js start 1 "lendo auth.ts"
node <flowforge>/adapters/tasks.js done 1
```

A mesma lente mostra a **linha do tempo**: o que o agente leu, editou e rodou, na ordem, e — dentro
de cada tarefa — os arquivos que ela tocou e o que ele está fazendo agora. Quem alimenta é um hook do
harness, que você liga por projeto:

```
node <flowforge>/adapters/activity.js install claude-code
```

É narração, não transcrição: ficam de fora o seu pedido, o conteúdo dos arquivos, a saída das
ferramentas e o comando cru.

Para o agente fazer isso sem você pedir toda vez, cole no `AGENTS.md` (ou `CLAUDE.md`) do projeto
o trecho que está no [README dos adapters](adapters/README.md#tarefas-ao-vivo). O formato do
arquivo está em [`docs/SCHEMA.md`](docs/SCHEMA.md).

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
  index.js         rotas, WS /ws (browser) e /agent (adapter), fs.watch por sessão
  state.js         leitura/escrita da sessão, autoridade do `rev`, migração
  tasks.js         o `tasks.json` do projeto: leitura, normalização, escrita sob trava
adapters/          o lado do agente: liga um harness ao /agent e publica tarefas
web-next/          o editor (Vite + React + TypeScript + @xyflow/react + elkjs)
  src/types.ts     o contrato do modelo — campo novo entra aqui antes de ser usado
  src/editor/      canvas, lentes, layout, formas, roteamento, export
scripts/           verificadores: migração sem perda, layout fiel, caminho de escrita
docs/              SCHEMA.md (o formato dos arquivos) e HISTORICO.md (o que foi feito, e por quê)
sessions/          dados, quando você não passa --data-dir (fora do git)
```

Uma pasta por sessão dentro do `--data-dir`:

```
<data-dir>/<slug>/
    workspace.json   os 5 modelos + rev + updatedBy — o arquivo-verdade
    thread.json      a conversa entre você e o agente
    inbox.jsonl      log append-only dos cliques em "Analisar" (recuperação)
<data-dir>/tasks.json   as tarefas ao vivo do agente (do projeto, não de uma sessão)
```

Sessão criada por uma versão antiga tem um `diagram.json`. Na primeira abertura ele é
convertido para `workspace.json` e **preservado como está** — a conversão não apaga nem
reescreve o arquivo antigo.

O servidor também expõe `GET /api/health`, `/api/sessions`, `/api/tasks` e `/api/state?session=<slug>`,
úteis para script e para checar em que diretório de dados ele subiu.

## Contribuir

O controle do projeto é pelas **[issues do GitHub](https://github.com/FabricioCasali/flowforge/issues)**: o que está por fazer, em andamento
e em discussão está lá.

Ver [CONTRIBUTING.md](CONTRIBUTING.md). É um projeto pessoal, aberto porque é útil para
mais gente que só o autor — issues e PRs são bem-vindos, com a ressalva de que o rumo
segue o uso diário de quem o mantém.

## Licença

MIT — ver [LICENSE](LICENSE).
