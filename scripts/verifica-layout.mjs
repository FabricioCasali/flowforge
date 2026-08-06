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

async function transpilar(tmp, arquivo) {
  const esbuild = require(path.join(WEBNEXT, 'node_modules', 'esbuild'));
  const saida = path.join(tmp, arquivo.replace(/\.ts$/, '.bundle.mjs'));
  await esbuild.build({
    entryPoints: [path.join(WEBNEXT, 'src', 'editor', arquivo)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: saida,
    logLevel: 'silent',
    absWorkingDir: WEBNEXT,
  });
  return import(pathToFileURL(saida).href);
}

// =============================================================================
// LEI 8 — as formas por kind.
//
// Esta tabela e a lei escrita como teste. Se alguem mexer em shapes.ts e um kind
// escorregar para outra forma (ou cair no fallback 'rect' por omissao, que foi
// o estado do porte durante a fase 0), isto aqui acusa.
// =============================================================================
const FORMA_ESPERADA = {
  task: 'rect',
  state: 'rect',
  subprocess: 'subprocess',
  start: 'pill',
  end: 'pill',
  decision: 'diamond',
  'gateway-exclusive': 'gate',
  'gateway-parallel': 'gate',
  'event-start': 'event',
  'event-end': 'event',
  'event-intermediate': 'event',
  idea: 'idea',
  'data-object': 'data',
  annotation: 'annotation',
  entity: 'entity',
};

function verificaFormas(SH, L) {
  const problemas = [];
  for (const [kind, esperada] of Object.entries(FORMA_ESPERADA)) {
    const obtida = SH.shapeOf(kind);
    if (obtida !== esperada) problemas.push(`kind '${kind}': desenha como '${obtida}', deveria ser '${esperada}'`);
  }
  // o fallback e intencional: kind novo do Claude vira etapa comum, nao some
  if (SH.shapeOf('um-kind-que-nao-existe') !== 'rect') {
    problemas.push('kind desconhecido deixou de cair em rect (o fallback e proposital)');
  }
  // evento e gateway tem medida fixa: o rotulo fica FORA e nao pode empurrar a caixa
  const rotulao = 'um rotulo comprido o suficiente para esticar qualquer caixa';
  const ev = L.nodeSize({ id: 'x', label: rotulao, kind: 'event-start', status: 'proposed', comments: [] });
  if (ev.width !== 62 || ev.height !== 62) problemas.push(`event-* deveria ser 62x62 e veio ${ev.width}x${ev.height}`);
  const gt = L.nodeSize({ id: 'x', label: rotulao, kind: 'gateway-exclusive', status: 'proposed', comments: [] });
  if (gt.width !== 92 || gt.height !== 92) problemas.push(`gateway-* deveria ser 92x92 e veio ${gt.width}x${gt.height}`);
  // formas distintas nao podem colapsar no mesmo tamanho por acidente
  const dec = L.nodeSize({ id: 'x', label: 'curto', kind: 'decision', status: 'proposed', comments: [] });
  if (dec.width === gt.width && dec.height === gt.height) {
    problemas.push('decision e gateway ficaram do mesmo tamanho (o losango classico leva rotulo dentro)');
  }
  return problemas;
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
      // Sessao vale se tem QUALQUER um dos dois arquivos-verdade. Antes so o
      // diagram.json contava — e depois do FF-008 sessao nova nao tem mais esse
      // arquivo, entao ela nasceria INVISIVEL pro teste e a cobertura degradaria
      // sozinha a cada diagrama novo.
      const diag = path.join(origem, 'diagram.json');
      if (!fs.existsSync(diag) && !fs.existsSync(path.join(origem, 'workspace.json'))) continue;
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
  // sessao nascida depois do FF-008 nao tem diagram.json — e isso e o normal
  if (fs.existsSync(alvo.diagramaOrigem)) fs.copyFileSync(alvo.diagramaOrigem, path.join(destino, 'diagram.json'));
  const wsOrigem = path.join(alvo.origem, 'workspace.json');
  if (fs.existsSync(wsOrigem)) fs.copyFileSync(wsOrigem, path.join(destino, 'workspace.json'));
  S.setDataDir(raizCopia);
  S.ensureSession(alvo.slug);
  return JSON.parse(fs.readFileSync(path.join(destino, 'workspace.json'), 'utf8'));
}

// ---------------------------------------------------------------------------
// autoteste: um teste que so sabe dizer OK nao prova nada
// ---------------------------------------------------------------------------

/**
 * A REGRA DA PROPAGACAO (decisao de 06/08/2026): o veredito num no so pode
 * recalcular as arestas DAQUELE no. A seta tem status proprio, e recalcular o
 * diagrama inteiro apagaria a marcacao do outro lado do desenho.
 */
async function testaPropagacao(M) {
  const casos = [];
  const nodes = [
    { id: 'a', status: 'approved' }, { id: 'b', status: 'approved' },
    { id: 'x', status: 'proposed' }, { id: 'y', status: 'proposed' },
  ];
  const edges = [
    { id: 'e1', source: 'a', target: 'b', status: 'proposed' },   // pontas concordam
    { id: 'e9', source: 'x', target: 'y', status: 'rejected' },   // marcada a mao, longe
  ];

  const r = M.propagateFrom(nodes, edges, ['a']);
  casos.push(['veredito em `a` puxa o consenso pra aresta de `a`', r.find((e) => e.id === 'e1').status === 'approved']);
  casos.push(['veredito em `a` NAO toca na seta marcada do outro lado', r.find((e) => e.id === 'e9').status === 'rejected']);

  const r2 = M.propagateFrom(nodes, edges, []);
  casos.push(['sem no mudado, nenhuma aresta e recalculada', r2 === edges]);

  const r3 = M.propagateFrom(nodes, edges, ['x']);
  casos.push(['pontas neutras devolvem a aresta pra proposed', r3.find((e) => e.id === 'e9').status === 'proposed']);

  return casos;
}

/**
 * FF-007 — export, arranjos nomeados e o diff "o que o Claude mudou".
 * O que da pra provar sem browser: o texto do Mermaid, a boa formacao do SVG, o
 * fato de os arranjos posicionarem todo mundo IGNORANDO o desenho salvo, e a
 * regra do diff (conteudo conta, posicao nao).
 */
/**
 * FF-011 — desvio de obstaculo e quebras manuais.
 *
 * A checagem de cruzamento aqui e ESCRITA DE NOVO, de proposito: se ela usasse o
 * mesmo helper do layout.ts, um bug no helper faria o teste concordar com o bug.
 */
function segmentoDentro(a, b, r) {
  const EPS = 0.5;
  if (Math.abs(a.y - b.y) < EPS) { // horizontal
    if (a.y <= r.y1 + EPS || a.y >= r.y2 - EPS) return false;
    return Math.min(a.x, b.x) < r.x2 - EPS && Math.max(a.x, b.x) > r.x1 + EPS;
  }
  if (Math.abs(a.x - b.x) < EPS) { // vertical
    if (a.x <= r.x1 + EPS || a.x >= r.x2 - EPS) return false;
    return Math.min(a.y, b.y) < r.y2 - EPS && Math.max(a.y, b.y) > r.y1 + EPS;
  }
  return false;
}
function trajetoCruza(pts, r) {
  for (let i = 1; i < pts.length; i++) if (segmentoDentro(pts[i - 1], pts[i], r)) return true;
  return false;
}

/**
 * A LINHA VOLTA EM CIMA DE SI MESMA?
 *
 * Dois trechos consecutivos na mesma orientacao e em sentidos OPOSTOS: a linha
 * anda e desanda pelo mesmo eixo. Foi o que o Fabricio viu depois do FF-011, e
 * acontecia quando a dobra do meio ignorava a direcao dos lados ancorados.
 * Fica como teste permanente: e o tipo de feiura que so aparece na tela.
 */
export function voltaSobreSi(pts) {
  for (let i = 2; i < pts.length; i++) {
    const a = pts[i - 2], b = pts[i - 1], c = pts[i];
    const mesmoY = Math.abs(a.y - b.y) < 0.5 && Math.abs(b.y - c.y) < 0.5;
    const mesmoX = Math.abs(a.x - b.x) < 0.5 && Math.abs(b.x - c.x) < 0.5;
    if (mesmoY && Math.sign(b.x - a.x) * Math.sign(c.x - b.x) < 0) return true;
    if (mesmoX && Math.sign(b.y - a.y) * Math.sign(c.y - b.y) < 0) return true;
  }
  return false;
}

async function testaRoteamento(L) {
  const casos = [];
  // A em cima, B embaixo e C EXATAMENTE no meio: o L/Z reto passa por dentro de C
  const d = {
    type: 'flowchart', title: 'T', rev: 0, updatedBy: 'user', lanes: [],
    nodes: [
      { id: 'a', label: 'A', kind: 'task', status: 'proposed', comments: [], x: 400, y: 100 },
      { id: 'c', label: 'C no meio', kind: 'task', status: 'proposed', comments: [], x: 400, y: 300 },
      { id: 'b', label: 'B', kind: 'task', status: 'proposed', comments: [], x: 400, y: 500 },
    ],
    edges: [{ id: 'e1', source: 'a', target: 'b', label: '', status: 'proposed' }],
  };
  const r = await L.layoutDiagram(d, 'DOWN', 70);
  const pc = r.positions.c, sc = r.sizes.c;
  const rc = { x1: pc.x, y1: pc.y, x2: pc.x + sc.width, y2: pc.y + sc.height };
  casos.push(['aresta CONTORNA o no que estava no caminho', !trajetoCruza(r.edgePoints.e1, rc)]);
  casos.push(['o desvio ainda comeca e termina nas pontas certas', r.edgePoints.e1.length >= 2]);

  // sem obstaculo no meio, o traco continua simples (o A* nao pode virar padrao)
  const d2 = JSON.parse(JSON.stringify(d));
  d2.nodes = d2.nodes.filter((n) => n.id !== 'c');
  const r2 = await L.layoutDiagram(d2, 'DOWN', 70);
  casos.push(['sem obstaculo, o traco continua o L/Z simples', r2.edgePoints.e1.length <= 4]);

  // quebra MANUAL manda: o traco tem de passar pelo ponto pedido
  const d3 = JSON.parse(JSON.stringify(d));
  d3.edges[0].waypoints = [{ x: 900, y: 300 }];
  d3.edges[0].routing = 'segments';
  const r3 = await L.layoutDiagram(d3, 'DOWN', 70);
  const passou = r3.edgePoints.e1.some((p) => Math.abs(p.x - 900) < 0.5 && Math.abs(p.y - 300) < 0.5);
  casos.push(['quebra manual entra no traco', passou]);
  casos.push(['quebra manual vence o roteador automatico', JSON.stringify(r3.edgePoints.e1) !== JSON.stringify(r.edgePoints.e1)]);

  // A DOBRA respeita a direcao dos lados ancorados, em TODAS as combinacoes.
  // Sem isso a linha sai pra um lado e volta por cima de si — 12 combinacoes,
  // porque foram justamente as esquisitas (mesmo lado, alvo atras) que quebraram.
  {
    const lados = ['top', 'right', 'bottom', 'left'];
    const posicoes = [
      { nome: 'alvo a direita e abaixo', x: 900, y: 700 },
      { nome: 'alvo a esquerda e acima', x: 80, y: 90 },
      { nome: 'alvo logo atras', x: 250, y: 400 },
    ];
    let ruins = [];
    for (const sSide of lados) for (const tSide of lados) for (const pos of posicoes) {
      const d = {
        type: 'flowchart', title: 'T', rev: 0, updatedBy: 'user', lanes: [],
        nodes: [
          { id: 'a', label: 'A', kind: 'task', status: 'proposed', comments: [], x: 400, y: 400 },
          { id: 'b', label: 'B', kind: 'task', status: 'proposed', comments: [], x: pos.x, y: pos.y },
        ],
        edges: [{ id: 'e1', source: 'a', target: 'b', label: '', status: 'proposed', sourceSide: sSide, targetSide: tSide }],
      };
      const r = await L.layoutDiagram(d, 'DOWN', 70);
      if (voltaSobreSi(r.edgePoints.e1)) ruins.push(`${sSide}->${tSide} (${pos.nome})`);
    }
    casos.push([`nenhuma das 48 combinacoes de lado volta sobre si${ruins.length ? ' — falhou: ' + ruins.slice(0, 3).join(', ') : ''}`, ruins.length === 0]);
  }

  // e o detector sabe ACUSAR? um traco que anda e desanda tem de ser pego
  casos.push(['a checagem ACUSA uma linha que volta em cima de si',
    voltaSobreSi([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 90 }])]);
  casos.push(['a checagem NAO acusa um traco normal em Z',
    !voltaSobreSi([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 90 }, { x: 120, y: 90 }])]);

  // duas quebras, na ordem em que foram postas
  const d4 = JSON.parse(JSON.stringify(d));
  d4.edges[0].waypoints = [{ x: 900, y: 200 }, { x: 900, y: 420 }];
  const r4 = await L.layoutDiagram(d4, 'DOWN', 70);
  const idx1 = r4.edgePoints.e1.findIndex((p) => Math.abs(p.y - 200) < 0.5);
  const idx2 = r4.edgePoints.e1.findIndex((p) => Math.abs(p.y - 420) < 0.5);
  casos.push(['duas quebras saem na ordem gravada', idx1 > 0 && idx2 > idx1]);

  return casos;
}

async function testaFerramentas(L, M, X, base) {
  const casos = [];

  // ---- Mermaid ----
  {
    const d = base();
    d.nodes[0].kind = 'decision';
    d.nodes[1].kind = 'start';
    d.edges[0].label = 'sim';
    const mmd = X.toMermaid(d);
    casos.push(['mermaid abre com flowchart TD', mmd.startsWith('flowchart TD')]);
    casos.push(['mermaid usa losango pra decision', /N0\{"A"\}/.test(mmd)]);
    casos.push(['mermaid usa pilula pra start', /N1\(\["B"\]\)/.test(mmd)]);
    casos.push(['mermaid leva o rotulo da aresta', /-->\|"sim"\|/.test(mmd)]);
  }
  // aspas no rotulo nao podem quebrar o arquivo
  {
    const d = base();
    d.nodes[0].label = 'diz "oi"';
    const mmd = X.toMermaid(d);
    casos.push(['mermaid escapa aspas do rotulo', mmd.includes("diz 'oi'") && !mmd.includes('"diz "oi""')]);
  }

  // ---- SVG ----
  {
    const d = base();
    const lay = await L.layoutDiagram(d, 'DOWN', 70);
    const svg = X.toSvg(d, lay);
    casos.push(['svg e um documento fechado', svg.startsWith('<svg') && svg.trim().endsWith('</svg>')]);
    casos.push(['svg declara o namespace (abre fora da pagina)', svg.includes('xmlns="http://www.w3.org/2000/svg"')]);
    casos.push(['svg tem largura e altura reais', /width="\d+"/.test(svg) && !/width="0"/.test(svg)]);
    casos.push(['svg leva o rotulo dos nos', svg.includes('>A<') || svg.includes('>B<')]);
    casos.push(['svg nao vaza var(--...) do CSS', !svg.includes('var(--')]);
  }
  // rotulo com < & " nao pode quebrar o XML
  {
    const d = base();
    d.nodes[0].label = 'a < b & c "d"';
    const lay = await L.layoutDiagram(d, 'DOWN', 70);
    const svg = X.toSvg(d, lay);
    casos.push(['svg escapa <, & e aspas do rotulo', svg.includes('&lt;') && svg.includes('&amp;') && !svg.includes('a < b')]);
  }

  // ---- arranjos nomeados ----
  for (const nome of ['vertical', 'horizontal', 'arvore', 'forca', 'radial']) {
    const d = base();
    const r = await L.namedLayout(d, nome);
    const todos = d.nodes.every((n) => r.positions[n.id] && Number.isFinite(r.positions[n.id].x));
    // o arranjo IGNORA o x/y salvo — senao nao arranjaria nada
    const ignorou = d.nodes.some((n) => {
      const volta = L.toSavedPoint(r.positions[n.id], r.sizes[n.id]);
      return volta.x !== n.x || volta.y !== n.y;
    });
    casos.push([`arranjo '${nome}' posiciona todos os nos`, todos]);
    casos.push([`arranjo '${nome}' ignora o desenho salvo`, ignorou]);
  }

  // ---- diff: o que o Claude mudou ----
  {
    const antes = base();
    const depois = base();
    depois.nodes[0].label = 'A editado';
    const d1 = M.diffNodes(antes, depois);
    casos.push(['diff pega o no que mudou de rotulo', d1.size === 1 && d1.has('a')]);

    const soMoveu = base();
    soMoveu.nodes[0].x = 9999;
    casos.push(['diff IGNORA quem so mudou de posicao', M.diffNodes(antes, soMoveu).size === 0]);

    const comNovo = base();
    comNovo.nodes.push({ id: 'c', label: 'C', kind: 'task', status: 'proposed', comments: [] });
    const d2 = M.diffNodes(antes, comNovo);
    casos.push(['diff pega o no que nasceu', d2.size === 1 && d2.has('c')]);

    const statusOutro = base();
    statusOutro.nodes[1].status = 'approved';
    casos.push(['diff pega mudanca de status', M.diffNodes(antes, statusOutro).has('b')]);

    casos.push(['diff de dois iguais e vazio', M.diffNodes(antes, base()).size === 0]);
  }

  return casos;
}

/**
 * FF-015 — a ordem do modo guiado. Por POSICAO, nao topologica, porque 3 dos 11
 * diagramas reais tem ciclo e 4 tem mais de uma raiz. Anotacao vai pro fim: nao
 * e etapa de percurso.
 */
function testaGuia(M) {
  const casos = [];
  const no = (id, y, x, kind) => ({ id, label: id, kind: kind || 'task', status: 'proposed', comments: [], x, y });
  const ehNota = (n) => n.kind === 'annotation';

  const fora = [no('c', 300, 0), no('a', 100, 0), no('b', 200, 0)];
  casos.push(['ordena de cima pra baixo, como o desenho se le',
    M.ordenarParaGuia(fora, ehNota).map((n) => n.id).join('') === 'abc']);

  const mesmaAltura = [no('dir', 100, 900), no('esq', 100, 100)];
  casos.push(['na mesma altura, desempata pela esquerda',
    M.ordenarParaGuia(mesmaAltura, ehNota).map((n) => n.id).join('') === 'esqdir']);

  const comNota = [no('nota', 50, 0, 'annotation'), no('etapa', 400, 0)];
  casos.push(['anotacao vai pro FIM, mesmo estando no topo do desenho',
    M.ordenarParaGuia(comNota, ehNota).map((n) => n.id).join('') === 'etapanota']);

  const semPos = [{ id: 'novo', label: 'n', kind: 'task', status: 'proposed', comments: [] }, no('velho', 100, 0)];
  casos.push(['no sem posicao (recem-criado) cai no fim, nao no topo',
    M.ordenarParaGuia(semPos, ehNota).map((n) => n.id).join('') === 'velhonovo']);

  // um diagrama com CICLO nao pode fazer a ordenacao sumir com no nenhum
  const ciclo = [no('x', 300, 0), no('y', 100, 0), no('z', 200, 0)];
  casos.push(['diagrama com ciclo nao perde no na ordenacao',
    M.ordenarParaGuia(ciclo, ehNota).length === 3]);

  casos.push(['ordenar nao muda o array original', (() => {
    const orig = [no('b', 200, 0), no('a', 100, 0)];
    const antes = orig.map((n) => n.id).join('');
    M.ordenarParaGuia(orig, ehNota);
    return orig.map((n) => n.id).join('') === antes;
  })()]);

  return casos;
}

async function autoteste(L, M, X) {
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
  // 6b. FF-005: a aresta ancorada num LADO tem de SAIR por aquele lado. Sem isto
  //     gravar sourceSide/targetSide seria enfeite, e os 54 lados ancorados dos
  //     diagramas reais desenhariam diferente do editor antigo.
  {
    const s = { x: 0, y: 0 }, ss = { width: 100, height: 40 };
    const t = { x: 300, y: 300 }, ts = { width: 100, height: 40 };
    const auto = L.orthRoute(s, ss, t, ts);
    const preso = L.orthRoute(s, ss, t, ts, 'right', 'top');
    const p0 = preso[0], pf = preso[preso.length - 1];
    const saiDireita = Math.abs(p0.x - (s.x + ss.width)) < 0.5 && Math.abs(p0.y - (s.y + ss.height / 2)) < 0.5;
    const entraTopo = Math.abs(pf.x - (t.x + ts.width / 2)) < 0.5 && Math.abs(pf.y - t.y) < 0.5;
    casos.push(['aresta ancorada sai pelo lado pedido (right)', saiDireita]);
    casos.push(['aresta ancorada entra pelo lado pedido (top)', entraTopo]);
    casos.push(['sem lado, o roteamento continua sendo o automatico', JSON.stringify(auto) !== JSON.stringify(preso)]);
  }
  // 6c. lado ancorado nas arestas de um diagrama inteiro (o caminho do routeAll)
  {
    const d = base();
    d.edges[0].sourceSide = 'left';
    d.edges[0].targetSide = 'right';
    const r = await L.layoutDiagram(d, 'DOWN', 70);
    const pts = r.edgePoints.e1;
    const sa = pts[0];
    const ok = Math.abs(sa.x - r.positions.a.x) < 0.5; // saiu pela ESQUERDA do nó a
    casos.push(['routeAll respeita o lado gravado no arquivo', ok]);
  }
  // 7. swimlane IGNORA o x/y salvo (lente derivada — decisao de 06/08/2026)
  {
    const d = base();
    const r = await L.swimlaneLayout(d);
    const herdou = r.positions.a.x === 100 && r.positions.a.y === 100;
    casos.push(['swimlane NAO herda o desenho do fluxograma', !herdou]);
  }

  // FF-006: a regra do RAIO da propagacao (a seta tem status proprio)
  casos.push(...(await testaPropagacao(M)));
  // FF-007: ferramentas
  casos.push(...(await testaFerramentas(L, M, X, base)));
  // FF-011: desvio de obstaculo e quebras manuais
  casos.push(...(await testaRoteamento(L)));
  // FF-015: a ordem do modo guiado
  casos.push(...testaGuia(M));

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
  const L = await transpilar(tmp, 'layout.ts');
  const SH = await transpilar(tmp, 'shapes.ts');
  const M = await transpilar(tmp, 'model.ts');
  const X = await transpilar(tmp, 'export.ts');

  if (process.argv.includes("--autoteste")) return autoteste(L, M, X);

  // ---- lei 8: as formas por kind ----
  const probFormas = verificaFormas(SH, L);
  console.log('Formas por kind (lei 8):');
  for (const [kind, esperada] of Object.entries(FORMA_ESPERADA)) {
    console.log(`   ${SH.shapeOf(kind) === esperada ? 'ok   ' : 'FALHA'} ${kind.padEnd(20)} -> ${SH.shapeOf(kind)}`);
  }
  for (const p of probFormas) console.log('   - ' + p);
  console.log('');

  const alvos = listarDiagramas();
  if (!alvos.length) {
    console.error('Nenhum diagram.json encontrado nas raizes configuradas.');
    process.exit(2);
  }
  console.log(`Diagramas reais encontrados: ${alvos.length}\n`);

  const linhas = [];
  const falhas = [];
  const kindsReais = {};
  for (const alvo of alvos) {
    const ws = workspaceDe(alvo, tmp);
    for (const lente of LENTES) {
      const d = ws[lente.modelo];
      if (!d || !(d.nodes || []).length) continue;
      if (lente.key !== 'swimlane') {
        for (const n of d.nodes) kindsReais[n.kind || '(sem kind)'] = (kindsReais[n.kind || '(sem kind)'] || 0) + 1;
      }
      const salvos = (d.nodes || []).filter((n) => Number.isFinite(n.x) && Number.isFinite(n.y)).length;
      const res = await rodarLayout(L, d, lente);
      const problemas = confere(d, lente, res);

      // A PONTA DA SETA sai do angulo do ultimo trecho do traco. Se esse trecho
      // for degenerado (dois pontos iguais), a seta aponta pra qualquer lado —
      // num diagrama de fluxo isso e mentira sobre a direcao.
      for (const [eid, pts] of Object.entries(res.edgePoints)) {
        if (!pts || pts.length < 2) { problemas.push(`aresta '${eid}': traco com menos de 2 pontos`); continue; }
        const fim = pts[pts.length - 1];
        const temDirecao = pts.some((p) => Math.abs(p.x - fim.x) + Math.abs(p.y - fim.y) > 0.5);
        if (!temDirecao) problemas.push(`aresta '${eid}': traco sem direcao — a ponta da seta nao teria pra onde apontar`);
        if (voltaSobreSi(pts)) problemas.push(`aresta '${eid}': a linha volta em cima do proprio eixo`);
      }

      // FF-007: o export tem de aguentar dado REAL (acento, aspas, rotulo longo).
      // So na lente dona do modelo, pra nao exportar o mesmo diagrama 2x.
      if (lente.honra) {
        try {
          const svg = X.toSvg(d, res);
          if (!svg.startsWith('<svg') || !svg.trim().endsWith('</svg>')) problemas.push('SVG exportado veio malformado');
          if (/ (width|height)="0"/.test(svg)) problemas.push('SVG exportado veio com dimensao zero');
          const mmd = X.toMermaid(d);
          const linhas = mmd.split('\n').length;
          if (linhas < d.nodes.length + 1) problemas.push(`mermaid perdeu no: ${linhas} linhas pra ${d.nodes.length} nos`);
        } catch (e) {
          problemas.push('export explodiu: ' + (e && e.message));
        }
      }
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

  // Que kinds os diagramas de verdade usam, e como cada um vai ser desenhado.
  // Serve pra ver de relance se algum kind real esta caindo no fallback.
  console.log('Kinds em uso nos diagramas reais:');
  for (const [kind, n] of Object.entries(kindsReais).sort((a, b) => b[1] - a[1])) {
    const forma = SH.shapeOf(kind);
    const generico = !(kind in FORMA_ESPERADA);
    console.log(`   ${String(n).padStart(3)}  ${kind.padEnd(20)} -> ${forma}${generico ? '   (kind desconhecido: cai no retangulo)' : ''}`);
  }
  console.log('');

  fs.rmSync(tmp, { recursive: true, force: true });
  const ok = falhas.length === 0 && probFormas.length === 0;
  if (probFormas.length) console.log(`FALHA na lei 8: ${probFormas.length} problema(s) de forma listados acima.\n`);
  console.log(ok
    ? `VEREDITO: OK — ${linhas.length} combinacoes diagrama x lente fieis ao arquivo, e as ${Object.keys(FORMA_ESPERADA).length} formas por kind conferem.`
    : `VEREDITO: FALHA — ${falhas.length} de ${linhas.length} combinacoes sairam do lugar; ${probFormas.length} desvio(s) de forma.`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
