# Adapters — ligando um harness ao FlowForge

O servidor do FlowForge abre um WebSocket em `/agent` e fala um protocolo neutro
([`docs/SCHEMA.md`](../docs/SCHEMA.md)). Ele **não sabe** que Claude Code, OpenCode ou Codex
existem. O adapter é o outro lado desse socket: recebe o clique em **Analisar**, entrega o
pedido ao CLI do harness, e avisa o servidor quando terminou.

```
browser ⇄ servidor Node ⇄ (WS /agent) ⇄ adapter ⇄ CLI do harness
                 ⇅                                      ⇅
          workspace.json / thread.json  ←── o harness edita os arquivos
```

## Dois jeitos de responder — e qual usar

**Sessão viva ([`live.js`](live.js)) — o padrão.** Quem responde ao **Analisar** é a sessão de CLI
que você já tem aberta trabalhando no projeto. Ela já sabe o que está sendo feito; qualquer outro
respondedor gasta token relendo o projeto para chegar onde ela já está. A ponte não chama harness
nenhum: imprime uma linha por pedido, e o harness, que vigia o processo, acorda a sessão.

**Execução à parte ([`index.js`](index.js)).** O adapter chama o CLI do harness em modo
não-interativo, numa conversa própria. Serve para quando não há sessão aberta. Custa mais e sabe
menos: medido no mesmo mapa, 113 s e 58 mil tokens de saída na primeira versão, contra 25 s da
sessão viva.

## Sessão viva

### No Claude Code

**Com o plugin instalado, a escuta se arma sozinha.** O `hooks/hooks.json` traz um hook `Stop`
(`async` + `asyncRewake`) que roda `adapters/live.js wait` no fim de **cada turno** — não há nada
a pedir à sessão, e não há teto de 30 minutos.

```
node <flowforge>/adapters/live.js wait    # o que o hook Stop roda (não rode à mão)
node <flowforge>/adapters/live.js stop    # encerra a ponte destacada deste servidor
```

São **dois papéis**, porque acordar a sessão exige um processo que *sai* e segurar o socket exige
um que *fica*:

- **a ponte** (fica) é o mesmo `live.js` de sempre: segura o `/agent`, manda `progress`, atende o
  `done`. Sob o hook ela roda **destacada** — sem terminal, sobrevivendo ao fim do turno — e o
  próprio `wait` a sobe na primeira vez. A porta de controle continua anunciada em
  `~/.flowforge/live-<porta>.json`, agora com o modo em que a ponte está;
- **o ouvinte** (sai) é o `wait`. Ele fica pendurado num long-poll (`GET /next`) na porta de
  controle e, quando chega um pedido, escreve no **stderr** e sai com **código 2** — é isso que
  acorda a sessão ociosa. O aviso chega ao modelo rotulado como *"Stop hook blocking error"*, então
  a primeira linha do texto desmente o rótulo: não é erro, é o clique no canvas.

O `wait` **sai 0 e calado** — o hook roda a cada turno e não pode virar ruído — quando o projeto
não tem `.flowforge/`, quando não há servidor FlowForge **deste** projeto no ar (ele compara o
`dataDir` do `GET /api/health`: outro projeto pode estar na mesma porta), quando já existe um
ouvinte vivo, e quando o `/agent` está ocupado por outro adapter (um Monitor antigo, por exemplo) —
não disputa. Ele procura o servidor em `4317` e `4318`; noutra porta, use `FLOWFORGE_PORT`.

Pedido que chega enquanto **não há ouvinte** (a sessão estava no meio de um turno) não se perde: a
ponte guarda na fila e entrega ao próximo `wait`.

**A ponte destacada não fica órfã.** Ela encerra sozinha depois de 10 minutos com o servidor fora
do ar, ou de 30 minutos sem ouvinte **nem** pedido pendente — como o hook `Stop` dispara a cada fim
de turno, uma sessão viva rearma o ouvinte em um turno, e meia hora sem nenhum é sessão que foi
embora. O `live.js stop` encerra na hora. Não há hook `SessionEnd`: duas sessões no mesmo projeto
dividem a mesma ponte, e fechar uma derrubaria a escuta da outra.

### Sem o plugin: a ferramenta Monitor

Peça à sessão para armar a ponte com a ferramenta **Monitor**:

```
Monitor:  node <flowforge>/adapters/live.js        (timeout no máximo; rearmar quando expirar)
```

A cada clique em Analisar chega à conversa um evento de uma linha:

```
FLOWFORGE analisar <requestId> sessao=<slug> dir=<pasta da sessão> nota="<o que o usuário pediu>"
```

A sessão lê `<dir>/workspace.json` e `<dir>/thread.json`, grava a resposta em `<dir>/reply.json`
(formato em [`reply.js`](reply.js)) e avisa a ponte:

```
node <flowforge>/adapters/live.js done <requestId>                       # aplica o reply.json
node <flowforge>/adapters/live.js done <requestId> --message "só texto"  # responde sem mexer no desenho
node <flowforge>/adapters/live.js done <requestId> --failed "motivo"     # não deu
```

**Quando a escuta cai.** O Monitor do Claude Code expira em no máximo 30 minutos, e rearmar sozinho
dependeria de o modelo lembrar. É esse o caminho de quem **não** tem o plugin — com ele, o hook
`Stop` acima rearma sozinho. Sem ele o canvas avisa: o indicador vira "agente desconectado" e
pede ao usuário a frase **"reconecte o FlowForge"**, que a skill ensina o agente a reconhecer. O pedido
feito no intervalo fica no `inbox.jsonl` e é reenviado, com o mesmo `requestId`, na reconexão.

Uma ponte por servidor: quem chega depois não disputa. Com o hook armado, o Monitor encontra a
ponte já no ar e encerra dizendo isso — pare a ponte (`live.js stop`) antes de armar o Monitor.

É o `done` que destrava o canvas. Enquanto a sessão trabalha, a ponte manda `progress` para a
trava não expirar. A linha é curta de propósito — o harness corta evento comprido —, então a nota
inteira está sempre no `thread.json`.

### No OpenCode

O OpenCode não tem uma ferramenta que transforme o stdout de um processo em evento na conversa —
mas tem um servidor HTTP dentro da própria TUI. Então lá a ponte **escreve no prompt da sessão
aberta** ([`deliver/opencode.js`](deliver/opencode.js)), em vez de imprimir uma linha:

```
node adapters/activity.js install opencode      # uma vez por projeto (ou --global)
node adapters/live.js --deliver opencode        # rode em segundo plano, de dentro da sessão
```

O `install` escreve `.opencode/plugin/flowforge.js`, e é esse plugin que faz os dois trabalhos:
narra a [linha do tempo](#linha-do-tempo) e deixa em `~/.flowforge/opencode/` a URL do servidor
daquela instância (o `serverUrl` chega pronto no plugin). **É assim que a ponte acha a TUI**: ela
sorteia a porta e não publica a URL em variável de ambiente. Como o plugin só carrega na abertura,
**reabra a sessão do OpenCode depois de instalar**.

A cada Analisar a ponte faz `POST /tui/append-prompt` com o pedido e `POST /tui/submit-prompt` —
o texto cai no prompt da conversa que estiver aberta e é enviado. Diferente da linha do Claude
Code, aqui vai o pedido **por extenso** (onde ler, o formato do `reply.json`, o comando que fecha),
porque do outro lado pode não haver skill carregada. O `done` é o mesmo.

| como mandar sem o plugin | quando |
| --- | --- |
| `FLOWFORGE_OPENCODE_URL=http://127.0.0.1:<porta>` ou `--opencode-url <url>` | você abriu a TUI com `--port` fixo |
| `FLOWFORGE_OPENCODE_SESSION=<id>` ou `--opencode-session <id>` | servidor sem TUI (`opencode serve`): a entrega vira `POST /session/<id>/prompt_async` |

Se o OpenCode estiver fechado, a ponte avisa no stdout e segue viva; o pedido continua pendente e
pode ser fechado à mão com `live.js done <requestId> --failed "…"`.

Outros harnesses: a ponte serve a qualquer um que consiga transformar o stdout de um processo em
evento na conversa, ou que aceite um módulo de entrega — o contrato está em
[`deliver/README.md`](deliver/README.md).

### Codex

O Codex não tem nada parecido com o Monitor — nenhum modo em que o stdout de um processo vire
evento na conversa. Tem o **caminho inverso**, e ele serve melhor: `codex queue` enfileira uma
mensagem numa sessão que já existe. Com a sessão ociosa, a mensagem **abre um turno novo**, sem
ninguém digitar nada.

```
node adapters/activity.js install codex          # (uma vez) o hook anota qual sessão está aberta
node adapters/live.js --deliver codex            # a ponte, num terminal ao lado
```

A cada Analisar a ponte roda `codex queue --thread <sessão> --message "…"`; a sessão aberta acorda,
lê `workspace.json` e `thread.json`, grava `reply.json` e roda o `live.js done`. Provado ponta a
ponta na versão `codex-cli 0.154.0`: o canvas travou no clique, a sessão respondeu sem receber nada
digitado, e o `done` destravou.

Em qual sessão entregar, nesta ordem: `FLOWFORGE_CODEX_THREAD`; `CODEX_THREAD_ID` (a ponte aberta de
dentro da própria sessão — o Codex exporta essa variável para o que ele roda); ou o que o hook da
linha do tempo anotou em `~/.flowforge/codex-threads.json`, por projeto. É por isso que instalar o
hook basta: o `session_id` que chega no hook **é** o id que o `codex queue --thread` aceita.

Limites, com a evidência:

- **A sessão precisa ter pelo menos um turno gravado.** Thread recém-criado, sem nada respondido:
  `thread/queue/add failed: … no rollout found for thread id`.
- **No meio de um turno a mensagem espera** o turno acabar e vira o turno seguinte; com a sessão
  fechada ela fica na fila para a próxima vez que aquele thread for retomado — e até lá o canvas
  fica travado.
- **A ponte fora da porta 4317 precisa passar a url**, e ela vai na mensagem: o `done` acha a ponte
  pela porta. Sem isso o `done` falha e o canvas não destrava (aconteceu na primeira prova).
- **`codex agents` e `codex resume` são telas**, não API: não dá para listar de forma programável
  qual sessão está viva. O que existe de máquina é o app-server
  (`codex app-server --listen`, métodos `thread/start`, `thread/queue/add`, `thread/loaded/list`);
  o `codex queue` é o atalho de linha de comando para o mesmo `thread/queue/add`.

## Execução à parte

Com o servidor no ar e o CLI do harness instalado e autenticado na sua máquina (um adapter por
vez — pare a ponte viva antes):

```
node adapters/index.js claude-code
node adapters/index.js opencode --model anthropic/claude-sonnet-4-5
node adapters/index.js codex
```

| opção | o que faz |
| --- | --- |
| `--url <ws>` | servidor (padrão `ws://localhost:4317/agent`) |
| `--model <m>` | modelo, no formato que o harness entende |
| `--effort <n>` | esforço de raciocínio, onde o harness tem isso (`low`, `medium`, `high`) |
| `--label <nome>` | nome mostrado na barra do canvas |
| `--fresh` | não retoma a conversa anterior da sessão |
| `-- <args>` | tudo depois de `--` vai cru para o CLI do harness |

Um adapter por vez: o servidor recusa o segundo registro, e o adapter recusado encerra.

## O que acontece a cada "Analisar"

1. O adapter responde `accepted` e chama o harness em **modo não-interativo**, com o
   diretório do projeto como `cwd` — o agente pode ler o código para embasar a resposta.
2. O pedido ([`prompt.js`](prompt.js)) diz onde estão os dois arquivos e pede a resposta num
   **arquivo só**, `<sessão>/reply.json` ([`reply.js`](reply.js)): a mensagem para o chat e as
   operações no desenho (`update`, `addNodes`, `addEdges`, `updateEdges`, `removeNodes`,
   `removeEdges`). O adapter aplica, sobe o `rev`, recalcula as setas dos nós mexidos e apaga o
   arquivo. Item inválido é pulado e relatado no chat, sem derrubar o resto. É o mesmo texto para
   todo harness, e editar o `workspace.json` direto continua valendo para o que a resposta não
   cobre (campos de entidade, raias, o modelo `seq`).
3. Enquanto o harness trabalha, o adapter manda `progress` a cada 30 s, para a trava do
   canvas não expirar.
4. Quando o harness termina, o adapter **sela os arquivos**: se o agente mexeu no
   `workspace.json` e esqueceu de subir o `rev`, sobe; se não escreveu no `thread.json`, a
   fala final dele vira a mensagem. São os dois esquecimentos que fazem o canvas ignorar
   uma resposta em silêncio.
5. `completed` (ou `failed`, com o motivo, que aparece no chat do canvas).

**Por que um arquivo de resposta.** Medido num mapa de 33 nós: deixando o agente editar o
`workspace.json` (22 KB) nó por nó, um "Analisar" levou 113 s — ~50 s em 13 edições em sequência
e ~30 s pensando no modelo e esforço padrão da máquina. Com o `reply.json` e o padrão abaixo, o
mesmo pedido caiu para 18 s, e um pedido que questiona três nós, comenta e cria outro, 56 s.

**Modelo e esforço.** O driver do Claude Code usa `sonnet` com esforço `medium` por padrão: o
canvas é conversa, com alguém olhando para a tela. Para uma pergunta que pede profundidade:
`node adapters/index.js claude-code --model opus --effort high`. OpenCode e Codex usam o que
estiver na configuração deles, salvo `--model`.

**Conversa por sessão.** O id da conversa do harness fica em
`~/.flowforge/adapter-state.json`, por `workspace.json` e por harness. O segundo "Analisar" da
mesma sessão retoma a conversa (`claude --resume`, `opencode run --session`,
`codex exec resume`); se a retomada falhar, o adapter tenta de novo com conversa nova.

**Permissões.** Cada driver pede o mínimo para ler o projeto e gravar dois JSON:

| harness | como roda |
| --- | --- |
| Claude Code | `--permission-mode acceptEdits`, só `Read,Edit,Write,Glob,Grep` — sem shell, sem rede |
| Codex | sandbox `workspace-write` — escreve dentro do projeto, sem rede |
| OpenCode | as permissões do seu `opencode.json` |

Para afrouxar ou apertar, passe as flags do próprio harness depois de `--`.

## Tarefas ao vivo

Outra peça, independente do adapter: [`tasks.js`](tasks.js) é o comando com que o agente publica
as tarefas dele na lente **Tarefas** do canvas. Não depende de harness — nem todo harness tem lista
de tarefas própria, e as que existem não se parecem; então o FlowForge não espelha a de ninguém,
oferece um arquivo (`<projeto>/.flowforge/tasks.json`) e um comando.

```
node adapters/tasks.js plan "<objetivo>" "<tarefa>" "<tarefa>" ...   começa (ou troca) a lista
node adapters/tasks.js start <n> ["nota"]        done <n>        block <n> "<motivo>"
node adapters/tasks.js add "<tarefa>"            reset <n>       note <n> "<texto>"
node adapters/tasks.js show                      clear
node adapters/tasks.js link <n> <sessão>/<nó>    unlink <n>
```

`<n>` é a posição ou o id da tarefa. O comando acha o `.flowforge/` subindo a partir do diretório
atual; `--list <id> --label <nome>` separa dois terminais do mesmo harness.

**Etapa viva.** `--node <sessão>/<nó>` (em `add` e `start`) liga a tarefa a um nó do desenho: o nó
apontado por uma tarefa `in_progress` aparece vivo no canvas daquela sessão, e travado se ela estiver
`blocked`. É estado derivado — não escreve nada no `workspace.json`. O `plan` não tem sintaxe de elo
de propósito (marcar o nó dentro do título comeria texto de verdade); ali se usa `link` depois.
A sessão e o nó não precisam existir ainda: sessão que falta vira aviso, não erro.

Para o agente manter a lista sem você pedir, cole isto no `AGENTS.md` / `CLAUDE.md` do projeto
(troque o caminho):

```markdown
## Tarefas no FlowForge

Em trabalho de mais de um passo, publique o seu plano no canvas e mantenha-o em dia:

- ao começar: `node <flowforge>/adapters/tasks.js plan "<objetivo>" "<tarefa 1>" "<tarefa 2>" ...`
- ao pegar uma tarefa: `... start <n> "<o que está fazendo, em uma linha>"`
- se ela for uma etapa de um desenho aberto: `... start <n> --node <sessão>/<id do nó>` — o nó acende
  no canvas enquanto você estiver nele
- ao terminar: `... done <n>` — na hora, não em lote no fim
- se travar esperando decisão ou acesso: `... block <n> "<o que falta>"`
- descobriu trabalho novo: `... add "<tarefa>"`

Tarefas curtas e concretas (um verbo, um objeto). É o que o usuário olha para saber onde você está.
```

## Linha do tempo

[`activity.js`](activity.js) grava em `<projeto>/.flowforge/activity.jsonl` o que o agente fez. Quem
instala o FlowForge como **plugin** não precisa fazer nada: os hooks vêm no
[`hooks/hooks.json`](../hooks/hooks.json). Sem plugin, o `install` escreve três hooks (`PostToolUse`, `UserPromptSubmit`, `Stop`) no
`.claude/settings.local.json` do projeto — ou no `~/.claude/settings.json` com `--global`, o que é
seguro: em projeto sem `.flowforge/` o hook sai calado. Reinstalar não duplica; `uninstall` tira só
o que é do FlowForge. O Claude Code recarrega o settings a quente: vale na sessão aberta.

Cada ação sai carimbada com a tarefa `in_progress` de quem publica — então **marcar o andamento com
`tasks.js start` é o que organiza a linha do tempo**. O agente também pode narrar o que ferramenta
nenhuma mostra: `node adapters/activity.js note "decidi X porque Y"`.

**No OpenCode o gancho é um plugin**, não uma entrada de settings: `node adapters/activity.js
install opencode` escreve `.opencode/plugin/flowforge.js` (ou o do config global, com `--global`).
Ele escuta `tool.execute.after`, `chat.message` e o evento `session.idle`, e de quebra anuncia o
servidor da sessão para a [ponte viva](#no-opencode). Reinstalar dá o mesmo arquivo; `uninstall`
apaga só ele. O OpenCode carrega plugin na abertura: **reabra a sessão**. Uma diferença de rigor
vale nota: o `bash` do OpenCode não tem campo `description`, então comando ali **sempre** vira
programa + subcomando.

**Codex** ([`hooks/codex.js`](hooks/codex.js)): `install` escreve em `<projeto>/.codex/hooks.json`
(ou `$CODEX_HOME/hooks.json` com `--global`) — a configuração de hook do Codex é JSON, não TOML.
Depois de instalar, **o Codex pede para confiar no hook**: abra a sessão e rode `/hooks`, senão ele
sai calado. Duas particularidades do payload real (conferidas na 0.154.0): o shell chega como
ferramenta `Bash` com a linha inteira em `tool_input.command`, e a edição chega como `apply_patch`
com **o patch inteiro** em `tool_input.command` — dele sai só o *nome* dos arquivos. O `Bash` do
Codex devolve a saída crua, sem código de retorno, então ali `failed` fica indefinido em vez de ser
adivinhado no texto.

Harness novo: um módulo em [`hooks/`](hooks/) com `SOURCE`, `map(payload, projectDir)` e
`install({ global, remove, projectDir, scriptPath })`; o `activity.js` descobre pelo nome do
arquivo. O `map` devolve `{ kind, summary, files?, failed? }` ou `null` — e é onde mora a regra de
**não vazar**: nada de pedido do usuário, conteúdo, saída ou comando cru.

## Escrever um driver

Um driver é um módulo com três campos. O núcleo cuida do protocolo, da reconexão, da
deduplicação de `requestId` e do selo dos arquivos; o driver só sabe chamar um CLI.

```js
module.exports = {
  id: 'meu-harness',          // chave no estado e no adapterId
  label: 'Meu Harness',       // o que o canvas mostra
  async run({ cwd, prompt, resumeId, model, extraArgs, runProcess, parseJsonLines }) {
    const r = await runProcess('meu-cli', ['--json', ...extraArgs], { cwd, stdin: prompt });
    if (r.code !== 0) return { ok: false, error: r.stderr.slice(0, 500) };
    return { ok: true, resumeId: '<id da conversa>', text: '<fala final do agente>' };
  },
};
```

Mande o pedido por **stdin**, não como argumento: ele tem várias linhas, e no Windows os
CLIs instalados por npm são shims `.cmd` que passam por shell.

Registre o nome em `DRIVERS` no [`index.js`](index.js) e prove:

```
node scripts/verifica-adapter.mjs           # o núcleo, com driver falso (não gasta token)
node scripts/prova-adapter.mjs meu-harness  # o loop inteiro com o CLI de verdade
```

## Limites conhecidos

- **A sessão viva existe nos três harnesses, cada um do seu jeito.** No Claude Code, pelo hook `Stop` do
  plugin, que rearma a escuta a cada fim de turno; sem o plugin, pela ferramenta Monitor, que expira em
  no máximo 30 min — e aí o canvas avisa e o usuário pede a reconexão. No OpenCode, pelo servidor HTTP
  da TUI — e ali a ponte não sabe se a TUI está de fato aberta: `append-prompt` responde 200 mesmo num
  `opencode serve` sem TUI nenhuma, e o pedido se perde em silêncio. No Codex, por `codex queue`, com os
  limites descritos na seção dele (a ponte roda num terminal ao lado; sessão fechada deixa o pedido na
  fila). Para qualquer outro harness só há a execução à parte.
- **O adapter só trata `analyze`.** O caminho inverso existe para **tarefas** (acima), e é o
  agente quem publica, por comando. Ações do CLI narradas sozinhas no canvas (o que ele leu,
  editou, rodou) ainda não existem.
