# FlowForge

Canvas colaborativo e **vivo** pra co-desenhar estrategias (fluxograma / BPM / mindmap) com o Claude, em tempo real. Voce descreve o problema, o Claude monta o diagrama e apresenta no navegador; voce ajusta, questiona, aprova ou reprova nos direto no browser; dispara **Analisar**; o Claude acorda, rebate e atualiza o diagrama — o canvas atualiza sozinho.

Reutilizavel em qualquer projeto. Lancado pelo skill global `flowforge`.

## Arquitetura (arquivos sao a fonte da verdade)

```
browser  --(WS patch)-->  servidor  --grava-->  sessions/<slug>/diagram.json
                                                       |
Claude   --edita arquivo-------------------------------+  (rev+1, updatedBy:"claude")
                                                       |
browser  <--(WS state)--  servidor  <--fs.watch--------+  (canvas atualiza sozinho)

clique "Analisar"  --(WS)-->  servidor  --(WS /claude)-->  Monitor do Claude  (acorda a sessao)
```

- **Servidor** (`server/`): Node + `ws`. Serve o editor, faz a ponte browser<->arquivo e empurra eventos de "Analisar" pro Claude.
- **Editor** (`web/`): single-page com **Cytoscape.js** (sem build; libs vendorizadas em `web/vendor/`).
- **Claude**: recebe cliques via a ferramenta `Monitor` (fonte WebSocket) e responde editando `sessions/<slug>/diagram.json` + `thread.json`.

## Rodar

```bash
npm install
node server/index.js --session meu-problema --port 4317
# abrir:  http://localhost:4317/?session=meu-problema
```

O Claude arma o loop com:
```
Monitor({ ws:{ url:"ws://localhost:4317/claude" }, description:"FlowForge", persistent:true })
```

## Estado

Uma pasta por problema em `sessions/<slug>/`:
- `diagram.json` — o diagrama (schema no `~/.claude/skills/flowforge/SKILL.md`).
- `thread.json` — a conversa user<->claude.
- `inbox.jsonl` — log append-only dos cliques "Analisar" (recuperacao).

## Status

**Fase 1 (MVP) — pronto:** loop vivo ponta a ponta, canvas (arrastar, status por no, comentarios, botao Analisar), fluxograma.
**Proximas fases:** desenhar setas na UI + adicionar/remover nos + formas por tipo (fase 2); thread global polido + export Mermaid/PNG + seletor de sessoes (fase 3); versionamento/undo + reconexao (fase 4).
