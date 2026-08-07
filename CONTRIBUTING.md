# Contribuir

O FlowForge é um projeto pessoal, aberto porque é útil para mais gente que só o autor. Na
prática isso significa: issues e PRs são bem-vindos, o rumo segue o uso diário de quem o
mantém, e uma mudança grande vale uma issue antes do código — não porque haja processo,
mas para você não gastar um fim de semana num caminho que já foi descartado.

O projeto é todo em PT-BR: documentação, comentários e mensagens de commit. Identificadores
de código ficam como estão.

## Rodar em desenvolvimento

```bash
npm install                          # o servidor: só a lib `ws`
cd web-next && npm install && cd ..

node server/index.js --data-dir "./.flowforge" --port 4317 --session teste
cd web-next && npm run dev           # front com hot reload (o servidor Node segue no ar)
```

O `npm run build` do `web-next` roda `tsc --noEmit` antes do Vite — erro de tipo derruba o
build de propósito. É esse bundle que o servidor Node passa a servir.

## Os verificadores

Em `scripts/` há três provas, e elas são o padrão de "pronto" aqui:

```bash
node scripts/verifica-migracao.mjs    # sessão antiga vira workspace.json sem perder campo
node scripts/verifica-layout.mjs      # quem tem x/y no arquivo é desenhado ali; formas por kind
node scripts/verifica-edicao.mjs      # o caminho de escrita: rev, autoria, e o que não pode se mexer
```

Os três rodam sobre **cópia** dos diagramas — nunca escrevem nos dados reais. Os três
aceitam `--autoteste`, que roda casos sintéticos e prova que o teste sabe **falhar**;
teste que só sabe dizer OK não vale nada, e é essa a forma que roda em qualquer máquina.

Duas coisas para saber antes de rodar:

- eles procuram diagramas reais em uma lista de diretórios fixa no topo de cada script
  (as pastas do autor). Numa máquina que não tem esses diretórios, a execução **sem**
  `--autoteste` sai com "nenhum diagram.json encontrado" e código 2. Aponte a lista para
  os seus próprios `.flowforge/` — ou rode com `--autoteste`, que é autossuficiente;
- o `verifica-layout.mjs` transpila o `layout.ts` real com o esbuild que veio junto do
  Vite, então ele precisa do `npm install` do `web-next` feito.

Rode os três antes de abrir o PR e diga no PR o que deu — inclusive se um deles não pôde
rodar na sua máquina. Resultado omitido custa mais caro que resultado ruim.

## Commits

Formato `tipo(escopo): assunto`, assunto em PT-BR, no que a mudança faz para quem usa.
`git log` mostra o padrão real melhor que qualquer regra aqui.

O corpo é a parte que importa: **explique o porquê**, não o quê. O diff já conta o quê. O
que se perde com o tempo é a razão — que sintoma apareceu, que alternativa foi descartada e
por quê, e como você provou que a correção funciona. Commit que diz "corrige o roteamento"
e nada mais obriga a próxima pessoa a reconstruir o raciocínio inteiro a partir do código.

Se um agente escreveu parte do código, credite com o trailer padrão:

```
Co-Authored-By: <nome do modelo> <noreply@anthropic.com>
```

## Onde ficam as coisas

- `docs/BOARD.md` — o quadro de tarefas do projeto, com o que está em andamento e o que
  está no backlog. Vale olhar antes de propor algo grande.
- `docs/SCHEMA.md` — o formato dos arquivos, para quem quer plugar outro agente no loop.
- `CLAUDE.md` — instruções para agentes que trabalham neste repositório. É um documento de
  trabalho interno, com decisões e datas; não é documentação de usuário.
- `web-next/src/types.ts` — o contrato do modelo. Campo novo entra ali **antes** de
  qualquer componente ou do servidor consumir.
