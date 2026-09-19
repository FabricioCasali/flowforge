# Entrega do pedido na sessão aberta

`adapters/live.js` recebe o **Analisar** e precisa fazer o pedido chegar à sessão de CLI que já
está aberta. O padrão é imprimir uma linha no stdout — serve a um harness que transforma o stdout de
um processo em evento na conversa (a ferramenta Monitor do Claude Code).

Harness que entrega de outro jeito ganha um módulo aqui, usado com `live.js --deliver <nome>`:

```js
// adapters/deliver/<nome>.js
module.exports = {
  // line: "FLOWFORGE analisar <requestId> sessao=<slug> dir=<pasta> nota=\"…\""
  // evt:  o evento analyze inteiro (requestId, session, note, workspacePath, threadPath, projectPath)
  // opts: as opções da linha de comando do live.js
  async deliver({ line, evt, opts }) { /* entrega por API do harness */ },
};
```

O resto não muda: a ponte registra no `/agent`, manda `progress`, e a sessão fecha o pedido com
`live.js done <requestId>`.

Pronto aqui: [`opencode.js`](opencode.js) — escreve no prompt da TUI aberta pelo servidor HTTP do
próprio OpenCode. Serve de modelo para os dois problemas que todo módulo tem: **achar** o harness
(lá, por um bilhete que o plugin deixa com a URL do servidor) e **dizer o que fazer** (o pedido
por extenso, porque do outro lado pode não haver skill carregada).

Opção que o `live.js` não conhece sobra em `opts.args` — é por ali que `--opencode-url` e
`--opencode-session` chegam, sem que o núcleo precise saber que existem.
