#!/usr/bin/env node
// =============================================================================
// verifica-layout.mjs — a PROVA do FF-001 (layout fiel ao arquivo).
//
// A lei 2 diz que o arquivo e a verdade. Isso vale tambem para a GEOMETRIA: se o
// no tem x/y no workspace.json, o editor tem de desenha-lo ali — e nao no lugar
// que o elkjs achou bonito. Este script pega os diagramas REAIS do Fabricio,
// roda o layout DE VERDADE (o layout.ts que o browser usa, transpilado na hora
// pelo esbuild) e confere quatro coisas:
//
//   1. no com x/y no arquivo cai EXATAMENTE em x/y             (fidelidade)
//   2. todo no recebe posicao                                  (ninguem some)
//   3. no SEM x/y nao nasce em cima de quem tem                (desempilhamento)
//   4. Swimlane sem `lanes` devolve noLanes                    (nao finge raia)
//
// Nao toca nos dados reais: trabalha sobre copia, como o verifica-migracao.mjs.
//
// Uso:
//   node scripts/verifica-layout.mjs
//   node scripts/verifica-layout.mjs --autoteste   # prova que sabe FALHAR
//
// Exit code 1 se qualquer diagrama sair do lugar.
// =============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, '..');
const WEBNEXT = path.join(RAIZ, 'web-next');
const S = require(path.join(RAIZ, 'server', 'state.js'));

// Mesmas raizes do verifica-migracao.mjs: onde moram os diagramas de verdade.
const RAIZES = [
  { rotulo: 'flowforge/sessions', dir: 'C:/desenv/particular/flowforge/sessions' },
  { rotulo: 'flowforge', dir: 'C:/desenv/particular/flowforge/.flowforge' },
  { rotulo: 'context_builder', dir: 'C:/desenv/particular/context_builder/.flowforge' },
  { rotulo: 'poe2', dir: 'C:/desenv/particular/poe2 - overlay + pob/.flowforge' },
  { rotulo: 'th_framework', dir: 'C:/desenv/thealth_projects/th_framework/.flowforge' },
];

// Quais lentes de grafo rodam sobre qual modelo, e se a lente e DONA da posicao.
// Espelha `web-next/src/editor/lenses.ts` — se divergir, o teste mente.
const LENTES = [
  { key: 'flow', modelo: 'process', layout: 'layered', honra: true },
  { key: 'swimlane', modelo: 'process', layout: 'swimlane', honra: false },
  { key: 'state', modelo: 'state', layout: 'layered', honra: true },
  { key: 'er', modelo: 'er', layout: 'er', honra: true },
  { key: 'mind', modelo: 'mind', layout: 'radial', honra: true },
];

// ---------------------------------------------------------------------------
// transpila o layout.ts real (nao reimplementa nada)
// ---------------------------------------------------------------------------

async function carregarLayout(tmp) {
  const esbuild = require(path.join(WEBNEXT, 'node_modules', 'esbuild'));
  const saida = path.join(tmp, 'layout.bundle.mjs');
  await esbuild.build({
    entryPoints: [path.join(WEBNEXT, 'src', 'editor', 'layout.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: saida,
    logLevel: 'silent',
    absWorkingDir: WEBNEXT,
  });
  return import(pathToFileURL(saida).href);
}

async function rodarLayout(L, diagrama, lente) {
  switch (lente.layout) {
    case 'swimlane': return L.swimlaneLayout(diagrama);
    case 'er': return L.layoutDiagram(diagrama, 'RIGHT', 110);
    case 'radial': return L.radialLayout(diagrama);
    default: return L.layoutDiagram(diagrama, 'DOWN', 70);
  }
}

// ---------------------------------------------------------------------------
// as quatro checagens
// ---------------------------------------------------------------------------

function sobrepoe(a, as_, b, bs, folga) {
  return a.x < b.x + bs.width + folga && a.x + as_.width + folga > b.x &&
         a.y < b.y + bs.height + folga && a.y + as_.height + folga > b.y;
}

function confere(diagrama, lente, res) {
  const problemas = [];
  const salvos = new Map();
  for (const n of diagrama.nodes || []) {
    if (Number.isFinite(n.x) && Number.isFinite(n.y)) salvos.set(n.id, { x: n.x, y: n.y });
  }

  // 4) Swimlane sem raias tem de AVISAR, nao inventar uma faixa
  if (lente.layout === 'swimlane') {
    const temRaias = (diagrama.lanes || []).length > 0;
    if (!temRaias && res.noLanes !== true) {
      problemas.push('swimlane sem `lanes` nao sinalizou noLanes (fingiu uma raia)');
    }
    if (temRaias && res.noLanes) {
      problemas.push(`swimlane com ${diagrama.lanes.length} raias sinalizou noLanes`);
    }
    // lente derivada: nao honra posicao, entao as checagens 1 e 3 nao se aplicam
    for (const n of diagrama.nodes || []) {
      if (!res.positions[n.id]) problemas.push(`no '${n.id}' ficou SEM posicao`);
    }
    return problemas;
  }

  // 2) ninguem some
  for (const n of diagrama.nodes || []) {
    if (!res.positions[n.id]) problemas.push(`no '${n.id}' ficou SEM posicao`);
  }

  // 1) fidelidade: quem tem x/y no arquivo manda.
  //    O arquivo guarda o CENTRO do no (heranca do Cytoscape) e o React Flow
  //    posiciona pelo canto — entao o esperado e o centro menos meio tamanho.
  //    Comparar sem converter foi o bug que este teste passou a pegar.
  if (lente.honra) {
    for (const [id, p] of salvos) {
      const got = res.positions[id];
      const s = res.sizes[id];
      if (!got || !s) continue;
      const esp = { x: p.x - s.width / 2, y: p.y - s.height / 2 };
      if (got.x !== esp.x || got.y !== esp.y) {
        problemas.push(`no '${id}': centro (${p.x},${p.y}) pede canto (${esp.x},${esp.y}) mas o layout pos em (${got.x},${got.y})`);
      }
    }
  }

  // 3) o no novo (sem x/y) nao pode nascer em cima de quem ja estava
  if (lente.honra && salvos.size && salvos.size < (diagrama.nodes || []).length) {
    for (const n of diagrama.nodes || []) {
      if (salvos.has(n.id)) continue;
      const p = res.positions[n.id];
      const s = res.sizes[n.id];
      if (!p || !s) continue;
      for (const [id2] of salvos) {
        const p2 = res.positions[id2];
        const s2 = res.sizes[id2];
        if (!p2 || !s2) continue;
        if (sobrepoe(p, s, p2, s2, 0)) {
          problemas.push(`no novo '${n.id}' nasceu SOBRE o no salvo '${id2}'`);
          break;
        }
      }
    }
  }

  return problemas;
}

// ---------------------------------------------------------------------------
// alvos
// ---------------------------------------------------------------------------

function listarDiagramas() {
  const achados = [];
  const usados = new Set();
  for (const { rotulo, dir } of RAIZES) {
    let entradas = [];
    try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entradas) {
      if (!e.isDirectory()) continue;
      const origem = path.join(dir, e.name);
      const diag = path.join(origem, 'diagram.json');
      if (!fs.existsSync(diag)) continue;
      let slug = e.name;
      while (usados.has(slug)) slug = `${rotulo.replace(/[^a-z0-9]+/gi, '-')}-${slug}`;
      usados.add(slug);
      achados.push({ rotulo, sessao: e.name, slug, origem, diagramaOrigem: diag });
    }
  }
  return achados;
}

/** Migra a copia e devolve o workspace resultante (mesmo caminho do servidor). */
function workspaceDe(alvo, raizCopia) {
  const destino = path.join(raizCopia, alvo.slug);
  fs.mkdirSync(destino, { recursive: true });
  fs.copyFileSync(alvo.diagramaOrigem, path.join(destino, 'diagram.json'));
  S.setDataDir(raizCopia);
  S.ensureSession(alvo.slug);
  return JSON.parse(fs.readFileSync(path.join(destino, 'workspace.json'), 'utf8'));
}

// ---------------------------------------------------------------------------
// autoteste: um teste que so sabe dizer OK nao prova nada
// ---------------------------------------------------------------------------

async function autoteste(L) {
  const casos = [];
  const base = () => ({
    type: 'flowchart', title: 'T', rev: 0, updatedBy: 'user', lanes: [],
    nodes: [
      { id: 'a', label: 'A', kind: 'task', status: 'proposed', comments: [], x: 100, y: 100 },
      { id: 'b', label: 'B', kind: 'task', status: 'proposed', comments: [], x: 100, y: 300 },
    ],
    edges: [{ id: 'e1', source: 'a', target: 'b', label: '', status: 'proposed' }],
  });

  // 1. tudo salvo -> tem de sair identico, ja convertido de centro para canto
  {
    const d = base();
    const r = await L.layoutDiagram(d, 'DOWN', 70);
    const sa = r.sizes.a;
    const ok = r.positions.a.x === 100 - sa.width / 2 && r.positions.a.y === 100 - sa.height / 2;
    casos.push(['posicao salva e respeitada ao pe da letra', ok]);
  }
  // 1b. o x/y do arquivo e o CENTRO: dois nos de larguras diferentes com o mesmo
  //     x tem de sair CENTRADOS no mesmo eixo (foi assim que o `web/` gravou)
  {
    const d = base();
    d.nodes[0].label = 'A';
    d.nodes[1].label = 'B com um rotulo bem mais comprido que o outro';
    const r = await L.layoutDiagram(d, 'DOWN', 70);
    const ca = r.positions.a.x + r.sizes.a.width / 2;
    const cb = r.positions.b.x + r.sizes.b.width / 2;
    const larguraDiferente = r.sizes.a.width !== r.sizes.b.width;
    casos.push(['nos de larguras diferentes com mesmo x saem centrados', larguraDiferente && ca === cb]);
  }
  // 1c. ida e volta: canto -> centro tem de devolver o x/y original
  {
    const d = base();
    const r = await L.layoutDiagram(d, 'DOWN', 70);
    const volta = L.toSavedPoint(r.positions.a, r.sizes.a);
    casos.push(['converter de volta devolve o x/y do arquivo', volta.x === 100 && volta.y === 100]);
  }
  // 2. nada salvo -> o elk manda (e ninguem fica sem posicao)
  {
    const d = base();
    for (const n of d.nodes) { delete n.x; delete n.y; }
    const r = await L.layoutDiagram(d, 'DOWN', 70);
    casos.push(['sem x/y no arquivo o elk posiciona todo mundo', !!r.positions.a && !!r.positions.b]);
  }
  // 3. misto -> o salvo fica, o novo entra sem sobrepor
  {
    const d = base();
    d.nodes.push({ id: 'c', label: 'C novo', kind: 'task', status: 'proposed', comments: [] });
    d.edges.push({ id: 'e2', source: 'b', target: 'c', label: '', status: 'proposed' });
    const r = await L.layoutDiagram(d, 'DOWN', 70);
    const fiel = L.toSavedPoint(r.positions.a, r.sizes.a).x === 100 && L.toSavedPoint(r.positions.a, r.sizes.a).y === 100;
    const c = r.positions.c, sc = r.sizes.c;
    const limpo = !sobrepoe(c, sc, r.positions.a, r.sizes.a, 0) && !sobrepoe(c, sc, r.positions.b, r.sizes.b, 0);
    casos.push(['diagrama misto: salvo fica, novo entra sem sobrepor', fiel && limpo]);
  }
  // 4. o detector sabe ACUSAR: forjo um layout errado e a checagem tem de pegar
  {
    const d = base();
    const falso = { positions: { a: { x: 999, y: 999 }, b: { x: 0, y: 0 } }, sizes: { a: { width: 10, height: 10 }, b: { width: 10, height: 10 } }, edgePoints: {} };
    const p = confere(d, { key: 'flow', layout: 'layered', honra: true }, falso);
    casos.push(['a checagem ACUSA layout que ignora o arquivo', p.length === 2]);
  }
  // 5. swimlane sem lanes avisa
  {
    const d = base();
    const r = await L.swimlaneLayout(d);
    casos.push(['swimlane sem `lanes` devolve noLanes', r.noLanes === true]);
  }
  // 6. swimlane COM lanes nao avisa e monta as bandas
  {
    const d = base();
    d.lanes = [{ id: 'l1', label: 'Ator', order: 0 }];
    d.nodes.forEach((n) => { n.lane = 'l1'; });
    const r = await L.swimlaneLayout(d);
    casos.push(['swimlane com `lanes` monta banda e nao avisa', !r.noLanes && (r.lanes || []).length === 1]);
  }
  // 7. swimlane IGNORA o x/y salvo (lente derivada — decisao de 06/08/2026)
  {
    const d = base();
    const r = await L.swimlaneLayout(d);
    const herdou = r.positions.a.x === 100 && r.positions.a.y === 100;
    casos.push(['swimlane NAO herda o desenho do fluxograma', !herdou]);
  }

  let falhas = 0;
  for (const [nome, ok] of casos) {
    console.log(`   ${ok ? 'ok   ' : 'FALHA'} ${nome}`);
    if (!ok) falhas++;
  }
  console.log(falhas === 0
    ? '\nAUTOTESTE: OK — o verificador acusa desvio e nao inventa falha.'
    : `\nAUTOTESTE: FALHA — ${falhas} caso(s).`);
  process.exit(falhas === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-verifica-layout-'));
  const L = await carregarLayout(tmp);

  if (process.argv.includes('--autoteste')) return autoteste(L);

  const alvos = listarDiagramas();
  if (!alvos.length) {
    console.error('Nenhum diagram.json encontrado nas raizes configuradas.');
    process.exit(2);
  }
  console.log(`Diagramas reais encontrados: ${alvos.length}\n`);

  const linhas = [];
  const falhas = [];
  for (const alvo of alvos) {
    const ws = workspaceDe(alvo, tmp);
    for (const lente of LENTES) {
      const d = ws[lente.modelo];
      if (!d || !(d.nodes || []).length) continue;
      const salvos = (d.nodes || []).filter((n) => Number.isFinite(n.x) && Number.isFinite(n.y)).length;
      const res = await rodarLayout(L, d, lente);
      const problemas = confere(d, lente, res);
      linhas.push([
        alvo.sessao, lente.key, String(d.nodes.length),
        `${salvos}/${d.nodes.length}`,
        lente.honra ? 'sim' : 'derivada',
        problemas.length ? `FALHA(${problemas.length})` : 'OK',
      ]);
      if (problemas.length) falhas.push({ alvo, lente, problemas });
    }
  }

  const cab = ['sessao', 'lente', 'nos', 'com x/y', 'honra arquivo', 'veredito'];
  const larg = cab.map((c, i) => Math.max(c.length, ...linhas.map((l) => String(l[i]).length)));
  const fmt = (l) => l.map((v, i) => String(v).padEnd(larg[i])).join(' | ');
  console.log(fmt(cab));
  console.log(larg.map((w) => '-'.repeat(w)).join('-+-'));
  for (const l of linhas) console.log(fmt(l));
  console.log('');

  for (const f of falhas) {
    console.log(`FALHA em ${f.alvo.rotulo}/${f.alvo.sessao} [lente ${f.lente.key}]:`);
    for (const p of f.problemas.slice(0, 20)) console.log('   - ' + p);
    if (f.problemas.length > 20) console.log(`   ... e mais ${f.problemas.length - 20}`);
    console.log('');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  const ok = falhas.length === 0;
  console.log(ok
    ? `VEREDITO: OK — ${linhas.length} combinacoes diagrama x lente, todas fieis ao arquivo.`
    : `VEREDITO: FALHA — ${falhas.length} de ${linhas.length} combinacoes sairam do lugar.`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
