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
