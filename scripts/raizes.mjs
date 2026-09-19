// Onde os verificadores procuram diagramas de verdade pra provar que nada se perde.
//
// Por padrao, so o que e do proprio repositorio: `sessions/` (dados quando o servidor roda sem
// --data-dir) e `.flowforge/` (as sessoes deste projeto). As duas pastas ficam fora do git, entao
// num clone limpo os verificadores rodam so os autotestes — o que ja e a prova do codigo.
//
// Pra provar contra os SEUS diagramas (e o uso que vale: quanto mais desenho real, melhor a prova),
// aponte as pastas `.flowforge/` dos seus projetos, separadas por `;` no Windows ou `:` no resto:
//
//   FLOWFORGE_VERIFY_DIRS="D:/proj-a/.flowforge;D:/proj-b/.flowforge" node scripts/verifica-layout.mjs
//
// Os verificadores trabalham sobre COPIA: nenhuma dessas pastas e alterada.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ_DO_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const extras = String(process.env.FLOWFORGE_VERIFY_DIRS || '')
  .split(path.delimiter)
  .map((d) => d.trim())
  .filter(Boolean)
  .map((dir) => ({ rotulo: path.basename(path.dirname(path.resolve(dir))) || dir, dir: path.resolve(dir) }));

export const RAIZES = [
  { rotulo: 'sessions', dir: path.join(RAIZ_DO_REPO, 'sessions') },
  { rotulo: 'este projeto', dir: path.join(RAIZ_DO_REPO, '.flowforge') },
  ...extras,
];
