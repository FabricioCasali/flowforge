'use strict';
/* FlowForge editor — Cytoscape + WebSocket ao vivo.
   Arquivos sao a fonte da verdade: o browser edita e manda 'patch' (o servidor grava);
   o Claude edita o arquivo e o servidor empurra o novo estado de volta pra ca. */

// ---- erro visivel (nunca falhar em silencio, e NUNCA no titulo) -----------
window.addEventListener('error', (e) => {
  const b = document.getElementById('errbar');
  if (b) { b.hidden = false; b.textContent = '⚠ ' + (e.message || (e.error && e.error.message) || 'erro JS') + '  (clique pra fechar)'; }
});
document.addEventListener('DOMContentLoaded', () => {
  const b = document.getElementById('errbar');
  if (b) b.addEventListener('click', () => { b.hidden = true; });
});

// ---- sessao / conexao -----------------------------------------------------
const params = new URLSearchParams(location.search);
const SESSION = params.get('session') || 'sessao';
const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?session=' + encodeURIComponent(SESSION);

let ws = null;
let localRev = -1;
let outstandingPatches = 0;   // patches que enviamos e ainda vao ecoar de volta
let currentType = 'flowchart';
let currentTitle = 'FlowForge'; // titulo em variavel (NAO ler do DOM, que pode ter erro)
let suppressTabSwitch = false;  // nao trocar de aba em selecao programatica (update do Claude)
let history = [];               // pilha de snapshots pro undo/redo
let histIndex = -1;
const HIST_MAX = 20;
let claudeMsgCount = 0;       // pra saber quando o Claude respondeu
let waitingClaude = false;
let readOnly = false;         // true enquanto o Claude "pensa": ver/navegar sim, editar nao

const el = (id) => document.getElementById(id);
// coords de tela -> coords de modelo do cy (usado por varios overlays)
function modelPos(clientX, clientY) {
  const rect = el('cy').getBoundingClientRect();
  const pan = cy.pan(), zoom = cy.zoom();
  return { x: (clientX - rect.left - pan.x) / zoom, y: (clientY - rect.top - pan.y) / zoom };
}
const connPill = el('conn');
const titleEl = el('title');

// ---- marcadores BPM (SVG data-URI, nitidos e escalaveis) ------------------
const svgURI = (s) => 'data:image/svg+xml,' + encodeURIComponent(s);
const MARK_X = svgURI('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M6 6 L18 18 M18 6 L6 18" stroke="#cbd2e0" stroke-width="3.2" stroke-linecap="round"/></svg>');
const MARK_PLUS = svgURI('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 5 L12 19 M5 12 L19 12" stroke="#cbd2e0" stroke-width="3.2" stroke-linecap="round"/></svg>');
const MARK_SUB = svgURI('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2" fill="none" stroke="#8b93a3" stroke-width="2"/><path d="M12 8 L12 16 M8 12 L16 12" stroke="#8b93a3" stroke-width="2" stroke-linecap="round"/></svg>');

// ---- Cytoscape ------------------------------------------------------------
const cy = cytoscape({
  container: el('cy'),
  wheelSensitivity: 0.6,
  style: [
    { selector: 'node', style: {
      'background-color': '#1e222b', 'border-width': 3, 'border-color': '#6b7280',
      'label': 'data(_disp)', 'color': '#e6e9ef',
      'text-wrap': 'wrap', 'text-max-width': 142, 'text-valign': 'center', 'text-halign': 'center',
      'width': 162, 'height': 54, 'font-size': 12, 'shape': 'round-rectangle',
    }},
    { selector: 'node[kind="decision"]', style: { 'shape': 'diamond', 'width': 150, 'height': 110, 'text-max-width': 108 } },
    { selector: 'node[kind="start"]', style: { 'shape': 'round-rectangle', 'background-color': '#14321f' } },
    { selector: 'node[kind="end"]', style: { 'shape': 'round-rectangle', 'background-color': '#33161a' } },
    { selector: 'node[kind="idea"]', style: { 'shape': 'ellipse' } },
    // --- vocabulario BPM ---
    { selector: 'node[kind="event-start"]', style: { 'shape': 'ellipse', 'width': 62, 'height': 62, 'background-color': '#14321f', 'border-width': 3, 'text-valign': 'bottom', 'text-margin-y': 5, 'text-max-width': 120 } },
    { selector: 'node[kind="event-end"]', style: { 'shape': 'ellipse', 'width': 62, 'height': 62, 'background-color': '#33161a', 'border-width': 7, 'text-valign': 'bottom', 'text-margin-y': 5, 'text-max-width': 120 } },
    { selector: 'node[kind="event-intermediate"]', style: { 'shape': 'ellipse', 'width': 62, 'height': 62, 'border-width': 3, 'border-style': 'double', 'text-valign': 'bottom', 'text-margin-y': 5, 'text-max-width': 120 } },
    { selector: 'node[kind="gateway-exclusive"]', style: { 'shape': 'diamond', 'width': 92, 'height': 92, 'background-image': MARK_X, 'background-fit': 'none', 'background-width': '42%', 'background-height': '42%', 'background-clip': 'none', 'text-valign': 'bottom', 'text-margin-y': 4, 'text-max-width': 120 } },
    { selector: 'node[kind="gateway-parallel"]', style: { 'shape': 'diamond', 'width': 92, 'height': 92, 'background-image': MARK_PLUS, 'background-fit': 'none', 'background-width': '46%', 'background-height': '46%', 'background-clip': 'none', 'text-valign': 'bottom', 'text-margin-y': 4, 'text-max-width': 120 } },
    { selector: 'node[kind="subprocess"]', style: { 'shape': 'round-rectangle', 'background-image': MARK_SUB, 'background-fit': 'none', 'background-width': 16, 'background-height': 16, 'background-position-x': '50%', 'background-position-y': '94%', 'background-clip': 'none' } },
    { selector: 'node[kind="data-object"]', style: { 'shape': 'cut-rectangle', 'width': 128, 'height': 72 } },
    { selector: 'node[kind="annotation"]', style: { 'shape': 'round-rectangle', 'background-opacity': 0.08, 'border-width': 2, 'border-style': 'dashed', 'border-color': '#6b7280', 'text-valign': 'center' } },
    { selector: 'node[status="approved"]', style: { 'border-color': '#2fbf71' } },
    { selector: 'node[status="rejected"]', style: { 'border-color': '#e5484d' } },
    { selector: 'node[status="questioned"]', style: { 'border-color': '#f5a623' } },
    { selector: 'node:selected', style: { 'outline-color': '#ffcc33', 'outline-width': 3, 'outline-offset': 2 } },
    { selector: 'edge', style: {
      'width': 2, 'line-color': '#3a4150', 'target-arrow-color': '#3a4150',
      'target-arrow-shape': 'triangle', 'curve-style': 'taxi',
      'taxi-direction': 'auto', 'taxi-turn': '50%', 'taxi-turn-min-distance': 10,
      'label': 'data(label)', 'color': '#8b93a3', 'font-size': 11,
      'text-background-color': '#0f1115', 'text-background-opacity': 1, 'text-background-padding': 2,
    }},
    { selector: 'edge[routing="bezier"]', style: { 'curve-style': 'bezier' } },
    { selector: 'edge[routing="segments"]', style: { 'curve-style': 'segments', 'segment-distances': 'data(_segDist)', 'segment-weights': 'data(_segWeight)', 'edge-distances': 'node-position' } },
    { selector: 'edge[status="approved"]', style: { 'line-color': '#2fbf71', 'target-arrow-color': '#2fbf71' } },
    { selector: 'edge[status="rejected"]', style: { 'line-color': '#e5484d', 'target-arrow-color': '#e5484d', 'line-style': 'dashed' } },
    { selector: 'edge[status="questioned"]', style: { 'line-color': '#f5a623', 'target-arrow-color': '#f5a623' } },
    { selector: 'edge:selected', style: { 'line-color': '#ffcc33', 'target-arrow-color': '#ffcc33', 'width': 3 } },
    { selector: 'edge[sourceSide]', style: { 'source-endpoint': 'data(_srcEP)' } },
    { selector: 'edge[targetSide]', style: { 'target-endpoint': 'data(_tgtEP)' } },
    { selector: 'node.link-src', style: { 'border-color': '#ffcc33', 'border-width': 5, 'border-style': 'dashed' } },
    { selector: 'node.conn-target', style: { 'border-color': '#ffcc33', 'border-width': 5 } },
    { selector: '.ghost', style: { 'width': 1, 'height': 1, 'opacity': 0, 'events': 'no' } },
    { selector: '.ghost-edge', style: { 'line-color': '#ffcc33', 'target-arrow-color': '#ffcc33', 'target-arrow-shape': 'triangle', 'line-style': 'dashed', 'width': 2, 'curve-style': 'bezier', 'events': 'no' } },
    { selector: '.changed', style: { 'overlay-color': '#ffcc33', 'overlay-opacity': 0.22, 'overlay-padding': 6 } },
  ],
});

// modo "ligar": dois cliques (origem -> destino) criam uma aresta. Sem plugin.
let linkMode = false;
let linkSource = null;
function exitLinkMode() {
  linkMode = false;
  if (linkSource) { linkSource.removeClass('link-src'); linkSource = null; }
}

// ---- helpers de dados -----------------------------------------------------
function disp(n) {
  const c = (n.comments && n.comments.length) ? '  💬' + n.comments.length : '';
  const d = n.description ? '  📄' : '';
  return (n.label || '') + c + d;
}
function uid(pfx) { return pfx + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3); }

// ancoragem por lado do no: side -> ponto de saida/entrada da aresta (relativo ao centro)
const SIDE_EP = { top: '0% -50%', right: '50% 0%', bottom: '0% 50%', left: '-50% 0%' };
// nos-losango: endpoint fixo cai "dentro" da forma -> deixa automatico
function isDiamondKind(k) { return k === 'decision' || k === 'gateway-exclusive' || k === 'gateway-parallel'; }
// preenche os campos transitorios _srcEP/_tgtEP a partir de sourceSide/targetSide
function edgeData(ed) {
  const data = { id: ed.id || uid('e'), source: ed.source, target: ed.target, label: ed.label || '', status: ed.status || 'proposed' };
  if (ed.sourceSide && SIDE_EP[ed.sourceSide]) { data.sourceSide = ed.sourceSide; data._srcEP = SIDE_EP[ed.sourceSide]; }
  if (ed.targetSide && SIDE_EP[ed.targetSide]) { data.targetSide = ed.targetSide; data._tgtEP = SIDE_EP[ed.targetSide]; }
  const hasWp = Array.isArray(ed.waypoints) && ed.waypoints.length;
  let routing = ed.routing;
  if (hasWp && routing !== 'bezier') routing = 'segments';
  if (routing && routing !== 'taxi') data.routing = routing;
  if (hasWp) data.waypoints = ed.waypoints.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
  if (ed.autoRouted) data.autoRouted = true;
  return data;
}

// converte waypoints ABSOLUTOS (coords de modelo) -> params do Cytoscape
// (segment-weights/distances, relativos a linha centro-source -> centro-target).
function computeSegments(edge) {
  const wps = edge.data('waypoints');
  if (!wps || !wps.length) { edge.removeData('_segWeight'); edge.removeData('_segDist'); return; }
  const s = edge.source().position(), t = edge.target().position();
  const Lx = t.x - s.x, Ly = t.y - s.y;
  const len2 = Lx * Lx + Ly * Ly || 1, len = Math.sqrt(len2);
  const nx = -Ly / len, ny = Lx / len;   // normal unitaria
  const arr = wps.map((p) => {
    const px = p.x - s.x, py = p.y - s.y;
    let w = (px * Lx + py * Ly) / len2;
    w = Math.max(0.02, Math.min(0.98, w));
    const d = px * nx + py * ny;          // distancia assinada ate a linha
    return { w, d };
  }).sort((a, b) => a.w - b.w);
  edge.data('_segWeight', arr.map((o) => +o.w.toFixed(4)).join(' '));
  edge.data('_segDist', arr.map((o) => Math.round(o.d)).join(' '));
}
function recomputeAllSegments() {
  cy.edges('[routing="segments"]').forEach((e) => { if (!e.hasClass('ghost-edge')) computeSegments(e); });
}

// ---- roteamento ortogonal com desvio de obstaculos -----------------------
// Uma linha nunca deve passar por baixo de um no. routeOrthogonal roda A* numa
// grade de visibilidade formada pelas bordas dos retangulos e desvia dos nos.
function routeOrthogonal(source, target, obstacles) {
  const EPS = 1e-6;
  // segmento (H ou V) atravessa o INTERIOR de algum obstaculo?
  function segmentBlocked(x1, y1, x2, y2) {
    for (const o of obstacles) {
      if (Math.abs(y1 - y2) < EPS) { // horizontal
        const y = y1; if (y > o.y1 + EPS && y < o.y2 - EPS) { const a = Math.min(x1, x2), b = Math.max(x1, x2); if (a < o.x2 - EPS && b > o.x1 + EPS) return true; }
      } else if (Math.abs(x1 - x2) < EPS) { // vertical
        const x = x1; if (x > o.x1 + EPS && x < o.x2 - EPS) { const a = Math.min(y1, y2), b = Math.max(y1, y2); if (a < o.y2 - EPS && b > o.y1 + EPS) return true; }
      }
    }
    return false;
  }
  function pointInObstacle(px, py) {
    for (const o of obstacles) if (px > o.x1 + EPS && px < o.x2 - EPS && py > o.y1 + EPS && py < o.y2 - EPS) return true;
    return false;
  }
  function dedup(arr) { arr.sort((a, b) => a - b); const r = []; for (const v of arr) if (!r.length || v - r[r.length - 1] > 1) r.push(v); return r; }
  function border(node, tcx, tcy) {
    const dx = tcx - node.cx, dy = tcy - node.cy;
    if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? { x: node.x2, y: node.cy } : { x: node.x1, y: node.cy };
    return dy > 0 ? { x: node.cx, y: node.y2 } : { x: node.cx, y: node.y1 };
  }
  try {
    const startPt = border(source, target.cx, target.cy);
    const endPt = border(target, source.cx, source.cy);
    // L simples ja resolve? entao sem quebras.
    const lA = { x: startPt.x, y: endPt.y }, lB = { x: endPt.x, y: startPt.y };
    const okA = !segmentBlocked(startPt.x, startPt.y, lA.x, lA.y) && !segmentBlocked(lA.x, lA.y, endPt.x, endPt.y);
    const okB = !segmentBlocked(startPt.x, startPt.y, lB.x, lB.y) && !segmentBlocked(lB.x, lB.y, endPt.x, endPt.y);
    if (okA || okB) return [];

    // grade de visibilidade
    let xs = [source.x1, source.x2, source.cx, target.x1, target.x2, target.cx, startPt.x, endPt.x];
    let ys = [source.y1, source.y2, source.cy, target.y1, target.y2, target.cy, startPt.y, endPt.y];
    for (const o of obstacles) { xs.push(o.x1, o.x2); ys.push(o.y1, o.y2); }
    xs = dedup(xs); ys = dedup(ys);
    // limite de tamanho
    if (xs.length * ys.length > 2600) { return fallback(); }

    const xi = new Map(xs.map((v, i) => [v, i])), yi = new Map(ys.map((v, i) => [v, i]));
    const blocked = xs.map((x) => ys.map((y) => pointInObstacle(x, y)));
    function snap(px, py) {
      let bd = Infinity, bx = 0, by = 0;
      for (let i = 0; i < xs.length; i++) for (let j = 0; j < ys.length; j++) {
        if (blocked[i][j]) continue;
        const d = Math.abs(xs[i] - px) + Math.abs(ys[j] - py);
        if (d < bd) { bd = d; bx = i; by = j; }
      }
      return { i: bx, j: by };
    }
    const S = snap(startPt.x, startPt.y), E = snap(endPt.x, endPt.y);
    const key = (i, j) => i + ',' + j;
    const open = new Set([key(S.i, S.j)]), came = new Map(), g = new Map(), f = new Map();
    g.set(key(S.i, S.j), 0); f.set(key(S.i, S.j), 0);
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let found = false;
    while (open.size) {
      let cur = null, bf = Infinity;
      for (const k of open) { const v = f.get(k); if (v < bf) { bf = v; cur = k; } }
      if (cur === key(E.i, E.j)) { found = true; break; }
      open.delete(cur);
      const [ci, cj] = cur.split(',').map(Number);
      const pv = came.get(cur);
      for (const [di, dj] of dirs) {
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= xs.length || nj >= ys.length || blocked[ni][nj]) continue;
        if (segmentBlocked(xs[ci], ys[cj], xs[ni], ys[nj])) continue;
        const nk = key(ni, nj);
        let turn = 0;
        if (pv) { const [pi, pj] = pv.split(',').map(Number); if ((ci - pi) !== di || (cj - pj) !== dj) turn = 12; }
        const ng = (g.get(cur) || 0) + Math.abs(xs[ni] - xs[ci]) + Math.abs(ys[nj] - ys[cj]) + turn;
        if (ng < (g.has(nk) ? g.get(nk) : Infinity)) {
          came.set(nk, cur); g.set(nk, ng);
          f.set(nk, ng + Math.abs(xs[ni] - xs[E.i]) + Math.abs(ys[nj] - ys[E.j]));
          open.add(nk);
        }
      }
    }
    if (!found) return fallback();
    const path = [];
    let k = key(E.i, E.j);
    while (k !== key(S.i, S.j)) { const [i, j] = k.split(',').map(Number); path.unshift({ x: xs[i], y: ys[j] }); k = came.get(k); if (k === undefined) return fallback(); }
    path.unshift({ x: xs[S.i], y: ys[S.j] });
    return simplify(path, startPt, endPt);
  } catch (e) { return []; }

  function simplify(path, startPt, endPt) {
    const s = [];
    for (let i = 0; i < path.length; i++) {
      if (i === 0 || i === path.length - 1) { s.push(path[i]); continue; }
      const a = path[i - 1], b = path[i], c = path[i + 1];
      const col = (a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y);
      if (!col) s.push(b);
    }
    return s.filter((p) => (Math.abs(p.x - startPt.x) + Math.abs(p.y - startPt.y) > 1) && (Math.abs(p.x - endPt.x) + Math.abs(p.y - endPt.y) > 1));
  }
  function fallback() {
    const startPt = border(source, target.cx, target.cy), endPt = border(target, source.cx, source.cy);
    let minX = Math.min(source.x1, target.x1), maxX = Math.max(source.x2, target.x2), minY = Math.min(source.y1, target.y1), maxY = Math.max(source.y2, target.y2);
    for (const o of obstacles) { minX = Math.min(minX, o.x1); maxX = Math.max(maxX, o.x2); minY = Math.min(minY, o.y1); maxY = Math.max(maxY, o.y2); }
    const g = 24;
    const cands = [
      [{ x: startPt.x, y: minY - g }, { x: endPt.x, y: minY - g }],
      [{ x: startPt.x, y: maxY + g }, { x: endPt.x, y: maxY + g }],
      [{ x: minX - g, y: startPt.y }, { x: minX - g, y: endPt.y }],
      [{ x: maxX + g, y: startPt.y }, { x: maxX + g, y: endPt.y }],
    ];
    for (const b of cands) {
      const segs = [[startPt, b[0]], [b[0], b[1]], [b[1], endPt]];
      if (!segs.some(([p, q]) => segmentBlocked(p.x, p.y, q.x, q.y))) {
        return b.filter((p) => (Math.abs(p.x - startPt.x) + Math.abs(p.y - startPt.y) > 1) && (Math.abs(p.x - endPt.x) + Math.abs(p.y - endPt.y) > 1));
      }
    }
    return [];
  }
}

// retangulo do no em coords de MODELO (opcionalmente inflado)
function nodeRect(n, inflate) {
  const p = n.position(), w = n.outerWidth() / 2 + inflate, h = n.outerHeight() / 2 + inflate;
  return { x1: p.x - w, y1: p.y - h, x2: p.x + w, y2: p.y + h, cx: p.x, cy: p.y };
}

// re-roteia todas as setas contornando os nos (respeita quebras manuais)
function organizeLines() {
  if (readOnly) return;
  const nodes = cy.nodes().filter((n) => !n.hasClass('ghost'));
  const plain = new Map(), obst = new Map();
  nodes.forEach((n) => { plain.set(n.id(), nodeRect(n, 0)); obst.set(n.id(), nodeRect(n, 16)); });
  cy.startBatch();
  cy.edges().forEach((e) => {
    if (e.hasClass('ghost-edge')) return;
    const hasManual = (e.data('waypoints') || []).length && !e.data('autoRouted');
    if (hasManual) return;                                  // nao mexe nas suas quebras
    const s = plain.get(e.data('source')), t = plain.get(e.data('target'));
    if (!s || !t) return;
    const obstacles = [];
    nodes.forEach((n) => { const id = n.id(); if (id !== e.data('source') && id !== e.data('target')) obstacles.push(obst.get(id)); });
    let pts = [];
    try { pts = routeOrthogonal(s, t, obstacles) || []; } catch (x) { pts = []; }
    if (pts.length) {
      e.data('waypoints', pts.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })));
      e.data('routing', 'segments'); e.data('autoRouted', true);
      computeSegments(e);
    } else if (e.data('autoRouted')) {                      // nao precisa mais desviar
      e.removeData('waypoints'); e.removeData('_segWeight'); e.removeData('_segDist'); e.removeData('routing'); e.removeData('autoRouted');
    }
  });
  cy.endBatch();
  refreshBends();
  sendPatch();
}
function fmtTs(ts) { try { return new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }

function diagramToElements(d) {
  const els = [];
  (d.nodes || []).forEach((n) => {
    const data = { id: n.id, label: n.label || '', kind: n.kind || 'task', status: n.status || 'proposed', comments: n.comments || [] };
    data._disp = disp(data);
    const e = { group: 'nodes', data };
    if (typeof n.x === 'number' && typeof n.y === 'number') e.position = { x: n.x, y: n.y };
    els.push(e);
  });
  (d.edges || []).forEach((ed) => {
    els.push({ group: 'edges', data: edgeData(ed) });
  });
  return els;
}

function cyToDiagram() {
  return {
    type: currentType,
    title: currentTitle || 'FlowForge',
    rev: localRev,
    updatedBy: 'user',
    nodes: cy.nodes().filter((n) => !n.hasClass('ghost')).map((n) => {
      const p = n.position();
      return {
        id: n.id(), label: n.data('label') || '', kind: n.data('kind') || 'task',
        status: n.data('status') || 'proposed', description: n.data('description') || '',
        comments: n.data('comments') || [],
        x: Number.isFinite(p.x) ? Math.round(p.x) : 0,
        y: Number.isFinite(p.y) ? Math.round(p.y) : 0,
      };
    }),
    edges: cy.edges().filter((e) => !e.hasClass('ghost-edge')).map((e) => {
      const o = {
        id: e.id(), source: e.data('source'), target: e.data('target'),
        label: e.data('label') || '', status: e.data('status') || 'proposed',
      };
      if (e.data('sourceSide')) o.sourceSide = e.data('sourceSide');
      if (e.data('targetSide')) o.targetSide = e.data('targetSide');
      const wps = e.data('waypoints');
      if (Array.isArray(wps) && wps.length) { o.routing = 'segments'; o.waypoints = wps.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })); }
      else if (e.data('routing') === 'bezier') o.routing = 'bezier';
      if (e.data('autoRouted')) o.autoRouted = true;
      return o;
    }),
  };
}

function sendPatch() {
  if (readOnly) return;   // Claude pensando: nao empurra edicoes (evita corrida)
  const d = cyToDiagram();
  recordHistory(d);
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  outstandingPatches++;
  ws.send(JSON.stringify({ type: 'patch', diagram: d }));
}

// ---- undo / redo (ultimas HIST_MAX edicoes) -------------------------------
function neJSON(d) { return JSON.stringify({ n: d.nodes, e: d.edges }); }
function recordHistory(d) {
  const snap = d || cyToDiagram();
  if (histIndex >= 0 && history[histIndex] && neJSON(history[histIndex]) === neJSON(snap)) return; // nada mudou
  history = history.slice(0, histIndex + 1);   // descarta o "redo" pendente
  history.push(snap);
  while (history.length > HIST_MAX + 1) history.shift();
  histIndex = history.length - 1;
}
function restoreSnapshot(snap) {
  try { reconcile(snap); } catch (e) {}
  updateSnapshot(snap);
  updateEmptyHint();
  refreshInspector();
  // envia sem gravar novo historico (o dedup do recordHistory pega, pois == topo atual)
  if (ws && ws.readyState === WebSocket.OPEN) { outstandingPatches++; ws.send(JSON.stringify({ type: 'patch', diagram: snap })); }
}
function undo() { if (histIndex > 0) { histIndex--; restoreSnapshot(history[histIndex]); } }
function redo() { if (histIndex < history.length - 1) { histIndex++; restoreSnapshot(history[histIndex]); } }

// ---- aplicar estado do servidor ------------------------------------------
// Reconciliacao incremental: upsert de nos/edges, sem derrubar o grafo.
// Robusto contra estado transitorio (aresta com no inexistente nunca lanca) e
// preserva viewport/selecao. Retorna true se algum no veio sem posicao.
function reconcile(d) {
  const nodes = d.nodes || [];
  const edges = d.edges || [];
  const nodeIds = new Set(nodes.map((n) => n.id));
  const validEdges = edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));
  const edgeIds = new Set(validEdges.map((e) => e.id));

  cy.startBatch();
  cy.nodes().forEach((n) => { if (!nodeIds.has(n.id())) n.remove(); });
  cy.edges().forEach((e) => { if (!edgeIds.has(e.id())) e.remove(); });

  nodes.forEach((n) => {
    const data = { id: n.id, label: n.label || '', kind: n.kind || 'task', status: n.status || 'proposed', description: n.description || '', comments: n.comments || [] };
    data._disp = disp(data);
    const cur = cy.getElementById(n.id);
    if (cur.empty()) {
      const add = { group: 'nodes', data };
      if (typeof n.x === 'number' && typeof n.y === 'number') add.position = { x: n.x, y: n.y };
      cy.add(add);
    } else {
      cur.data(data);
      if (typeof n.x === 'number' && typeof n.y === 'number' && !cur.grabbed()) {
        const p = cur.position();
        if (Math.round(p.x) !== n.x || Math.round(p.y) !== n.y) cur.position({ x: n.x, y: n.y });
      }
    }
  });

  validEdges.forEach((e) => {
    let cur = cy.getElementById(e.id);
    // arestas do Cytoscape NAO permitem trocar source/target depois de criadas.
    // Se as pontas mudaram, remove e recria (senao a seta antiga persiste errada).
    if (cur.nonempty() && (cur.data('source') !== e.source || cur.data('target') !== e.target)) {
      cur.remove();
      cur = cy.getElementById(e.id);
    }
    if (cur.empty()) {
      cy.add({ group: 'edges', data: edgeData(e) });
    } else {
      const upd = { label: e.label || '', status: e.status || 'proposed' };
      // lados podem sumir/mudar; reflete e recomputa os endpoints transitorios
      upd.sourceSide = e.sourceSide || undefined; upd._srcEP = e.sourceSide ? SIDE_EP[e.sourceSide] : undefined;
      upd.targetSide = e.targetSide || undefined; upd._tgtEP = e.targetSide ? SIDE_EP[e.targetSide] : undefined;
      const hasWp = Array.isArray(e.waypoints) && e.waypoints.length;
      let routing = e.routing; if (hasWp && routing !== 'bezier') routing = 'segments';
      upd.routing = (routing && routing !== 'taxi') ? routing : undefined;
      upd.waypoints = hasWp ? e.waypoints.map((p) => ({ x: p.x, y: p.y })) : undefined;
      upd.autoRouted = e.autoRouted || undefined;
      cur.data(upd);
    }
  });
  cy.endBatch();
  recomputeAllSegments();   // waypoints absolutos -> params do cytoscape (posicoes ja aplicadas)

  return nodes.some((n) => typeof n.x !== 'number' || typeof n.y !== 'number');
}

// ---- destaque do que o Claude mudou ---------------------------------------
let snapNodes = new Map();  // id -> chave comparavel (pra detectar mudanca)
let snapEdges = new Map();
let changedEles = cy.collection();
let changeTimer = null;

function nodeKey(n) { return (n.status || '') + '|' + (n.label || '') + '|' + ((n.comments || []).length) + '|' + (n.kind || '') + '|' + (n.description || ''); }
function edgeKey(e) { return e.source + '>' + e.target + '|' + (e.label || '') + '|' + (e.status || '') + '|' + (e.sourceSide || '') + '>' + (e.targetSide || ''); }

function updateSnapshot(d) {
  snapNodes = new Map((d.nodes || []).map((n) => [n.id, nodeKey(n)]));
  snapEdges = new Map((d.edges || []).map((e) => [e.id, edgeKey(e)]));
}

function diffSnapshot(d) {
  const nodes = [], edges = [];
  let addN = 0, modN = 0, addE = 0, modE = 0;
  (d.nodes || []).forEach((n) => {
    if (!snapNodes.has(n.id)) { nodes.push(n.id); addN++; }
    else if (snapNodes.get(n.id) !== nodeKey(n)) { nodes.push(n.id); modN++; }
  });
  (d.edges || []).forEach((e) => {
    if (!snapEdges.has(e.id)) { edges.push(e.id); addE++; }
    else if (snapEdges.get(e.id) !== edgeKey(e)) { edges.push(e.id); modE++; }
  });
  return { nodes, edges, addN, modN, addE, modE };
}

function clearChanges() {
  clearTimeout(changeTimer);
  if (changedEles && changedEles.nonempty()) {
    changedEles.removeClass('changed');
    changedEles.forEach((e) => { try { e.removeStyle('overlay-opacity'); } catch (x) {} });
  }
  changedEles = cy.collection();
  const t = el('change-toast'); if (t) t.hidden = true;
}

function highlightChanges(ch) {
  clearChanges();
  let col = cy.collection();
  ch.nodes.forEach((id) => { col = col.union(cy.getElementById(id)); });
  ch.edges.forEach((id) => { col = col.union(cy.getElementById(id)); });
  col = col.filter((e) => !e.hasClass('ghost') && !e.hasClass('ghost-edge'));
  if (col.empty()) return;
  changedEles = col;
  col.addClass('changed');
  col.forEach((e) => {
    e.animate({ style: { 'overlay-opacity': 0.5 } }, { duration: 240 })
     .animate({ style: { 'overlay-opacity': 0.22 } }, { duration: 460 });
  });
  const parts = [];
  if (ch.addN) parts.push('+' + ch.addN + ' no' + (ch.addN > 1 ? 's' : ''));
  if (ch.modN) parts.push('~' + ch.modN + ' no' + (ch.modN > 1 ? 's' : ''));
  if (ch.addE) parts.push('+' + ch.addE + ' seta' + (ch.addE > 1 ? 's' : ''));
  if (ch.modE) parts.push('~' + ch.modE + ' seta' + (ch.modE > 1 ? 's' : ''));
  el('change-text').textContent = 'Claude mudou: ' + parts.join(', ');
  el('change-toast').hidden = false;
  changeTimer = setTimeout(clearChanges, 20000);
}

function applyState(state) {
  const d = state.diagram || {};
  const byUser = d.updatedBy === 'user';

  // eco do nosso proprio patch: ja refletimos, so atualiza thread/rev/baseline
  if (byUser && outstandingPatches > 0) {
    outstandingPatches--;
    localRev = typeof d.rev === 'number' ? d.rev : localRev;
    updateSnapshot(d);
    renderThread(state.thread);
    return;
  }
  if (typeof d.rev === 'number' && d.rev < localRev) { renderThread(state.thread); return; }

  const firstLoad = localRev < 0;
  const selId = cy.$(':selected').length ? cy.$(':selected')[0].id() : null;
  if (linkSource) linkSource = null;

  // diff contra a baseline ANTES de reconciliar (so destaca updates do Claude)
  const ch = (!firstLoad && d.updatedBy === 'claude') ? diffSnapshot(d) : null;

  let needsLayout = false;
  try { needsLayout = reconcile(d); }
  catch (err) { const b = el('errbar'); if (b) { b.hidden = false; b.textContent = '⚠ reconcile: ' + err.message; } }

  localRev = typeof d.rev === 'number' ? d.rev : localRev;
  currentType = d.type || 'flowchart';
  currentTitle = d.title || 'FlowForge';
  if (document.activeElement !== titleEl) titleEl.textContent = currentTitle; // nao atrapalha edicao
  updateSnapshot(d); // nova baseline

  if (needsLayout && cy.nodes().length) runLayout(firstLoad, persistPositions);
  else if (firstLoad && cy.nodes().length) cy.fit(cy.elements(), 40);

  updateEmptyHint();
  if (selId && cy.getElementById(selId).length) {
    suppressTabSwitch = true;
    cy.getElementById(selId).select();
    suppressTabSwitch = false;
  }
  refreshInspector();
  renderThread(state.thread);
  if (waitingClaude && d.updatedBy === 'claude') setWaiting(false);
  if (!needsLayout) recordHistory(); // se houve layout, o persistPositions grava depois
  if (ch && (ch.nodes.length || ch.edges.length)) highlightChanges(ch);
}

// dagre disponivel? testa uma vez.
const DAGRE_OK = (function () {
  try { cy.layout({ name: 'dagre' }); return true; } catch (e) { return false; }
})();

function runLayout(fit, done) {
  const opts = DAGRE_OK
    ? { name: 'dagre', rankDir: 'TB', nodeSep: 55, rankSep: 70, edgeSep: 15, fit: !!fit, padding: 50, animate: false }
    : { name: 'breadthfirst', directed: true, spacingFactor: 1.3, fit: !!fit, padding: 50, animate: false };
  const layout = cy.layout(opts);
  if (done) layout.one('layoutstop', done);
  layout.run();
}

// persiste posicoes calculadas por layout (pra o Claude e o reload manterem o desenho)
let persistTimer = null;
function persistPositions() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(sendPatch, 120);
}

// ---- thread ---------------------------------------------------------------
function renderThread(thread) {
  const list = el('thread-list');
  const msgs = (thread && thread.messages) || [];
  const nClaude = msgs.filter((m) => m.author === 'claude').length;
  if (waitingClaude && nClaude > claudeMsgCount) setWaiting(false);
  claudeMsgCount = nClaude;
  list.innerHTML = '';
  msgs.forEach((m) => {
    const div = document.createElement('div');
    div.className = 'msg ' + (m.author || 'user');
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = m.author === 'claude' ? 'Claude' : m.author === 'system' ? 'sistema' : 'voce';
    const body = document.createElement('div');
    body.textContent = m.text || '';
    div.appendChild(who); div.appendChild(body);
    list.appendChild(div);
  });
  list.scrollTop = list.scrollHeight;
}

// ---- inspector ------------------------------------------------------------
function selectedNode() { const s = cy.$('node:selected'); return s.length ? s[0] : null; }
function selectedEdge() { const s = cy.$('edge:selected'); return s.length ? s[0] : null; }

const KIND_LABEL = {
  start: 'inicio', task: 'tarefa', decision: 'decisao', end: 'fim', idea: 'ideia',
  'event-start': 'evento inicio', 'event-intermediate': 'evento interm.', 'event-end': 'evento fim',
  'gateway-exclusive': 'gateway ou', 'gateway-parallel': 'gateway e', subprocess: 'subprocesso',
  'data-object': 'dado', annotation: 'anotacao',
};

function refreshInspector() {
  const n = selectedNode();
  const e = n ? null : selectedEdge();

  if (n) {
    el('card-title').textContent = n.data('label') || '(sem rotulo)';
    el('card-kind-badge').textContent = KIND_LABEL[n.data('kind')] || n.data('kind') || '';
    el('insp-label').value = n.data('label') || '';
    el('insp-kind').value = n.data('kind') || 'task';
    el('insp-desc').value = n.data('description') || '';
    document.querySelectorAll('#node-card .status-btns .st').forEach((b) => {
      b.classList.toggle('active', b.dataset.status === (n.data('status') || 'proposed'));
    });
    const box = el('insp-comments');
    box.innerHTML = '';
    const entries = n.data('comments') || [];
    if (!entries.length) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = '(sem anexos ainda)'; box.appendChild(e); }
    entries.forEach((c) => {
      const kind = c.kind || 'note';
      const d = document.createElement('div');
      d.className = 'cmt k-' + kind + (c.author === 'claude' ? ' claude' : '');
      const who = c.author === 'claude' ? 'Claude' : 'voce';
      const tag = kind === 'reject' ? 'reprovou' : kind === 'question' ? 'questionou' : 'nota';
      const head = document.createElement('div'); head.className = 'who';
      head.textContent = who + ' · ' + tag + (c.ts ? ' · ' + fmtTs(c.ts) : '');
      const t = document.createElement('div'); t.textContent = c.text || '';
      d.appendChild(head); d.appendChild(t); box.appendChild(d);
    });
  }
  if (e) {
    el('edge-label').value = e.data('label') || '';
    const src = cy.getElementById(e.data('source')), tgt = cy.getElementById(e.data('target'));
    el('edge-ends').textContent = '(' + (src.data('label') || e.data('source')) + ' → ' + (tgt.data('label') || e.data('target')) + ')';
    document.querySelectorAll('#edge-status .st').forEach((b) => {
      b.classList.toggle('active', b.dataset.estatus === (e.data('status') || 'proposed'));
    });
  }
}

// ---- card flutuante da seta ----------------------------------------------
function openEdgeCard() { const c = el('edge-card'); if (c.hidden) { c.hidden = false; if (!edgeCardPinned) { c.style.left = '16px'; c.style.bottom = '16px'; c.style.top = 'auto'; } } }
function closeEdgeCard() { el('edge-card').hidden = true; }
let edgeCardPinned = false;
el('edge-card-close').addEventListener('click', () => { closeEdgeCard(); cy.$(':selected').unselect(); });
(function edgeCardDrag() {
  const card = el('edge-card'), head = el('edge-card-head');
  let drag = false, sx = 0, sy = 0, ox = 0, oy = 0;
  head.addEventListener('mousedown', (e) => {
    if (e.target.id === 'edge-card-close') return;
    drag = true; edgeCardPinned = true; sx = e.clientX; sy = e.clientY;
    const r = card.getBoundingClientRect(), w = el('cy-wrap').getBoundingClientRect();
    ox = r.left - w.left; oy = r.top - w.top; card.style.bottom = 'auto';
    e.preventDefault();
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  });
  function mv(e) { if (!drag) return; card.style.left = (ox + e.clientX - sx) + 'px'; card.style.top = (oy + e.clientY - sy) + 'px'; }
  function up() { drag = false; document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); }
})();

function updateNode(mutator) {
  const n = selectedNode();
  if (!n) return;
  mutator(n);
  n.data('_disp', disp({ label: n.data('label'), comments: n.data('comments'), description: n.data('description') }));
  refreshInspector();
  sendPatch();
}

// recalcula o status das setas do no a partir dos dois extremos:
// - os dois lados com o MESMO status marcado (aprovado/reprovado/questionado) -> a seta pega esse status
// - lados divergentes, ou algum neutro -> a seta volta pra neutro (path coerente)
function propagateFrom(node) {
  node.connectedEdges().forEach((e) => {
    if (e.hasClass('ghost-edge')) return;
    const a = e.source().data('status'), b = e.target().data('status');
    e.data('status', (a !== 'proposed' && a === b) ? a : 'proposed');
  });
}

// wiring inspector
el('insp-label').addEventListener('input', (e) => { const n = selectedNode(); if (n) { n.data('label', e.target.value); n.data('_disp', disp({ label: e.target.value, comments: n.data('comments'), description: n.data('description') })); } });
el('insp-label').addEventListener('change', () => sendPatch());
el('insp-kind').addEventListener('change', (e) => updateNode((n) => n.data('kind', e.target.value)));
el('insp-desc').addEventListener('input', (e) => { const n = selectedNode(); if (n) { n.data('description', e.target.value); n.data('_disp', disp({ label: n.data('label'), comments: n.data('comments'), description: e.target.value })); } });
el('insp-desc').addEventListener('change', () => sendPatch());
// anexa uma entrada ao historico do no (nota | reprovacao | questionamento)
function pushEntry(n, kind, text) {
  const arr = (n.data('comments') || []).slice();
  arr.push({ author: 'user', text, ts: Date.now(), kind });
  n.data('comments', arr);
}

// status: aprovar/nao-marcar sao diretos; reprovar/questionar pedem o motivo num modal
document.querySelectorAll('#node-card .status-btns .st').forEach((b) => {
  b.addEventListener('click', () => {
    const s = b.dataset.status;
    if (!selectedNode()) return;
    if (s === 'rejected') {
      openModal('Motivo da reprovacao', 'Por que voce esta reprovando este no?', (reason) => {
        updateNode((n) => { n.data('status', 'rejected'); pushEntry(n, 'reject', reason); propagateFrom(n); });
      });
    } else if (s === 'questioned') {
      openModal('O que voce esta questionando?', 'Descreva a duvida/objecao sobre este no', (q) => {
        updateNode((n) => { n.data('status', 'questioned'); pushEntry(n, 'question', q); propagateFrom(n); });
      });
    } else {
      updateNode((n) => { n.data('status', s); propagateFrom(n); });
    }
  });
});

// nota: anexo livre, NAO mexe no status
el('note-add-btn').addEventListener('click', () => {
  if (!selectedNode()) return;
  openModal('Nova nota', 'Anexe uma nota a este no (nao muda o status)', (text) => {
    updateNode((n) => pushEntry(n, 'note', text));
  });
});

// ---- card flutuante do no -------------------------------------------------
let cardPinned = false;   // usuario arrastou o card -> mantem a posicao dele
function setCardTab(name) {
  document.querySelectorAll('#card-tabs .ctab').forEach((b) => b.classList.toggle('active', b.dataset.ctab === name));
  el('card-desc').hidden = name !== 'desc';
  el('card-notas').hidden = name !== 'notas';
}
function openCard() {
  const card = el('node-card');
  const wasHidden = card.hidden;
  card.hidden = false;
  if (!cardPinned) { card.style.left = '16px'; card.style.top = '16px'; }
  if (wasHidden) setCardTab('desc');
}
function closeCard() { el('node-card').hidden = true; }
document.querySelectorAll('#card-tabs .ctab').forEach((b) => b.addEventListener('click', () => setCardTab(b.dataset.ctab)));
el('card-close').addEventListener('click', () => { closeCard(); cy.$(':selected').unselect(); });

// arrastar o card pela barra de titulo
(function cardDrag() {
  const card = el('node-card'), head = el('card-head');
  let drag = false, sx = 0, sy = 0, ox = 0, oy = 0;
  head.addEventListener('mousedown', (e) => {
    if (e.target.id === 'card-close') return;
    drag = true; cardPinned = true; sx = e.clientX; sy = e.clientY;
    const r = card.getBoundingClientRect(), w = el('cy-wrap').getBoundingClientRect();
    ox = r.left - w.left; oy = r.top - w.top;
    e.preventDefault();
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  });
  function mv(e) { if (!drag) return; card.style.left = (ox + e.clientX - sx) + 'px'; card.style.top = (oy + e.clientY - sy) + 'px'; }
  function up() { drag = false; document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); }
})();

// ---- tooltip de hover: preview da descricao -------------------------------
(function nodeTip() {
  const tip = el('node-tip');
  cy.on('mouseover', 'node', (e) => {
    const n = e.target;
    if (n.hasClass('ghost')) { tip.hidden = true; return; }
    const d = n.data('description');
    if (!d) { tip.hidden = true; return; }
    tip.textContent = d.length > 180 ? d.slice(0, 180) + '…' : d;
    const bb = n.renderedBoundingBox();
    tip.style.left = ((bb.x1 + bb.x2) / 2) + 'px';
    tip.style.top = (bb.y1 - 8) + 'px';
    tip.hidden = false;
  });
  cy.on('mouseout', 'node', () => { tip.hidden = true; });
  cy.on('pan zoom grab', () => { tip.hidden = true; });
})();

// ---- modal generico -------------------------------------------------------
let modalConfirm = null;
function openModal(title, placeholder, onConfirm) {
  el('modal-title').textContent = title;
  const ta = el('modal-text'); ta.value = ''; ta.placeholder = placeholder || '';
  modalConfirm = onConfirm;
  el('modal').hidden = false;
  setTimeout(() => ta.focus(), 0);
}
function closeModal() { el('modal').hidden = true; modalConfirm = null; }
el('modal-ok').addEventListener('click', () => {
  const t = el('modal-text').value.trim();
  if (!t) { el('modal-text').focus(); return; } // motivo/nota obrigatorio
  const cb = modalConfirm; closeModal(); if (cb) cb(t);
});
el('modal-cancel').addEventListener('click', closeModal);
el('modal').addEventListener('click', (e) => { if (e.target === el('modal')) closeModal(); });
el('modal-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); el('modal-ok').click(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeModal(); }
});

// ---- edicao de seta -------------------------------------------------------
function updateEdge(mutator) {
  const e = selectedEdge();
  if (!e) return;
  mutator(e);
  refreshInspector();
  sendPatch();
}
el('edge-label').addEventListener('input', (e) => { const ed = selectedEdge(); if (ed) ed.data('label', e.target.value); });
el('edge-label').addEventListener('change', () => sendPatch());
document.querySelectorAll('#edge-status .st').forEach((b) => {
  b.addEventListener('click', () => updateEdge((ed) => ed.data('status', b.dataset.estatus)));
});

// ---- toolbar --------------------------------------------------------------
// cria um no numa posicao (coords de modelo), seleciona e abre pra editar
function addNodeAt(pos, kind) {
  if (readOnly) return null;
  const id = uid('n');
  const LABELS = {
    start: 'inicio', end: 'fim', decision: 'decisao?', idea: 'ideia', task: 'nova tarefa',
    'event-start': 'inicio', 'event-end': 'fim', 'event-intermediate': 'evento',
    'gateway-exclusive': 'ou?', 'gateway-parallel': 'e', 'subprocess': 'subprocesso',
    'data-object': 'dado', 'annotation': 'anotacao',
  };
  const label = LABELS[kind] || 'nova tarefa';
  cy.add({ group: 'nodes', data: { id, label, kind: kind || 'task', status: 'proposed', comments: [], _disp: label }, position: pos });
  cy.$(':selected').unselect();
  cy.getElementById(id).select();
  updateEmptyHint();
  sendPatch();
  openCard(); setCardTab('desc');
  const inp = el('insp-label'); if (inp) { inp.focus(); inp.select(); }
  return id;
}

// paleta: arrastar item -> soltar no canvas
document.querySelectorAll('.pal-item').forEach((it) => {
  it.addEventListener('dragstart', (e) => {
    if (readOnly) { e.preventDefault(); return; }
    e.dataTransfer.setData('text/kind', it.dataset.kind); e.dataTransfer.effectAllowed = 'copy';
  });
});
(function () {
  const wrap = el('cy-wrap');
  wrap.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  wrap.addEventListener('drop', (e) => {
    e.preventDefault();
    const kind = e.dataTransfer.getData('text/kind') || 'task';
    const rect = el('cy').getBoundingClientRect();
    const pan = cy.pan(), zoom = cy.zoom();
    const pos = { x: (e.clientX - rect.left - pan.x) / zoom, y: (e.clientY - rect.top - pan.y) / zoom };
    addNodeAt(pos, kind);
  });
})();

// duplo-clique no vazio cria uma tarefa ali
cy.on('dbltap', (e) => { if (e.target === cy) addNodeAt(e.position, 'task'); });

// ---- nozinhos de conexao (4 lados) ----------------------------------------
// Passe o mouse num no -> aparecem 4 bolinhas (topo/dir/baixo/esq). Arraste de
// uma delas ate outro no pra criar a seta, ancorada no lado escolhido. Arrastar
// o CORPO do no continua movendo o no.
let hideConnNubs = () => {};   // exposto pro modo read-only (item 5)
(function connHandles() {
  const nubs = ['top', 'right', 'bottom', 'left'].map((s) => ({ side: s, elm: el('conn-' + s) }));
  let hoverNode = null, hideTimer = null;
  let connecting = false, connSource = null, connSourceSide = null, connTarget = null;

  function placePos(elm, x, y) { elm.style.left = x + 'px'; elm.style.top = y + 'px'; }
  function place(node) {
    const bb = node.renderedBoundingBox();
    const midX = (bb.x1 + bb.x2) / 2, midY = (bb.y1 + bb.y2) / 2;
    const map = { top: [midX, bb.y1], right: [bb.x2, midY], bottom: [midX, bb.y2], left: [bb.x1, midY] };
    nubs.forEach(({ side, elm }) => { const c = map[side]; placePos(elm, c[0], c[1]); });
  }
  function showNubs(node) {
    if (linkMode || connecting || readOnly) return;
    hoverNode = node; place(node);
    nubs.forEach(({ elm }) => { elm.hidden = false; });
  }
  function hideNubs() { nubs.forEach(({ elm }) => { elm.hidden = true; }); }
  hideConnNubs = hideNubs;

  cy.on('mouseover', 'node', (e) => {
    const n = e.target;
    if (n.hasClass('ghost')) return;
    if (connecting) { if (n.id() !== connSource.id()) { connTarget = n; n.addClass('conn-target'); } return; }
    clearTimeout(hideTimer); showNubs(n);
  });
  cy.on('mouseout', 'node', () => {
    if (connecting) { if (connTarget) { connTarget.removeClass('conn-target'); connTarget = null; } return; }
    hideTimer = setTimeout(hideNubs, 160);
  });
  cy.on('pan zoom', () => { if (!connecting) hideNubs(); });
  cy.on('drag', 'node', (e) => { if (!connecting && hoverNode && e.target.id() === hoverNode.id()) place(hoverNode); });

  // qual lado do bbox do no o ponto (tela) esta mais perto
  function sideAt(node, clientX, clientY) {
    const rect = el('cy').getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    const bb = node.renderedBoundingBox();
    const cx = (bb.x1 + bb.x2) / 2, cyy = (bb.y1 + bb.y2) / 2;
    const dx = (x - cx) / Math.max(1, bb.w / 2), dy = (y - cyy) / Math.max(1, bb.h / 2);
    if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
    return dy >= 0 ? 'bottom' : 'top';
  }
  function nodeAt(clientX, clientY) {
    const rect = el('cy').getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    let found = null;
    cy.nodes().forEach((n) => {
      if (n.hasClass('ghost')) return;
      const bb = n.renderedBoundingBox();
      if (x >= bb.x1 && x <= bb.x2 && y >= bb.y1 && y <= bb.y2) found = n;
    });
    return found;
  }

  nubs.forEach(({ side, elm }) => {
    elm.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    elm.addEventListener('mouseleave', () => { if (!connecting) hideTimer = setTimeout(hideNubs, 160); });
    elm.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!hoverNode || readOnly) return;
      connecting = true; connSource = hoverNode; connSourceSide = side; connTarget = null;
      hideNubs();
      const p = modelPos(e.clientX, e.clientY);
      cy.add({ group: 'nodes', data: { id: '__ghost' }, position: p, classes: 'ghost' });
      cy.add({ group: 'edges', data: { id: '__ghostE', source: connSource.id(), target: '__ghost' }, classes: 'ghost-edge' });
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });

  function onMove(e) {
    const g = cy.getElementById('__ghost');
    if (g.nonempty()) g.position(modelPos(e.clientX, e.clientY));
  }
  function onUp(e) {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    cy.getElementById('__ghostE').remove();
    cy.getElementById('__ghost').remove();
    const target = connTarget || nodeAt(e.clientX, e.clientY); // fallback geometrico
    if (target && connSource && target.id() !== connSource.id() && !target.hasClass('ghost')) {
      const ed = { id: uid('e'), source: connSource.id(), target: target.id(), label: '', status: 'proposed' };
      if (!isDiamondKind(connSource.data('kind'))) ed.sourceSide = connSourceSide;
      if (!isDiamondKind(target.data('kind'))) ed.targetSide = sideAt(target, e.clientX, e.clientY);
      cy.add({ group: 'edges', data: edgeData(ed) });
      sendPatch();
    }
    if (connTarget) connTarget.removeClass('conn-target');
    connecting = false; connSource = null; connSourceSide = null; connTarget = null;
  }
})();

// ---- quebras editaveis (bend handles) -------------------------------------
// Selecione uma seta -> duplo-clique nela cria um ponto de quebra arrastavel.
// Arraste o ponto pra moldar a seta; duplo-clique no ponto remove. Sem quebras,
// a seta volta ao roteamento ortogonal (taxi).
let refreshBends = () => {};
(function bendHandles() {
  const wrap = el('cy-wrap');
  let dots = [];
  let dragging = false;

  function rendered(mx, my) { const pan = cy.pan(), z = cy.zoom(); return { x: mx * z + pan.x, y: my * z + pan.y }; }
  function selEdge() { const e = cy.$('edge:selected'); return e.length ? e[0] : null; }
  function clearDots() { dots.forEach((d) => d.remove()); dots = []; }

  function refresh() {
    if (dragging) return;
    clearDots();
    const e = selEdge();
    if (!e || readOnly || e.hasClass('ghost-edge')) return;
    const wps = e.data('waypoints');
    if (!wps || !wps.length) return;
    wps.forEach((p, i) => {
      const dot = document.createElement('div');
      dot.className = 'bend-dot';
      const r = rendered(p.x, p.y);
      dot.style.left = r.x + 'px'; dot.style.top = r.y + 'px';
      wireDot(dot, e, i);
      wrap.appendChild(dot);
      dots.push(dot);
    });
  }
  function reposition() {
    if (!dots.length || dragging) return;
    const e = selEdge(); if (!e) return;
    const wps = e.data('waypoints') || [];
    dots.forEach((dot, i) => { if (wps[i]) { const r = rendered(wps[i].x, wps[i].y); dot.style.left = r.x + 'px'; dot.style.top = r.y + 'px'; } });
  }
  refreshBends = refresh;

  function removeBend(edge, i) {
    if (readOnly) return;
    const wps = (edge.data('waypoints') || []).slice();
    wps.splice(i, 1);
    if (wps.length) { edge.data('waypoints', wps); computeSegments(edge); }
    else {
      // sem quebras -> volta pro taxi ortogonal. removeData de verdade (data(x,undefined)
      // nao limpa o seletor [routing="segments"], entao a linha ficava quebrada).
      edge.removeData('waypoints'); edge.removeData('_segWeight'); edge.removeData('_segDist'); edge.removeData('routing');
    }
    sendPatch(); refresh();
  }
  function wireDot(dot, edge, i) {
    dot.title = 'arraste pra moldar · duplo-clique ou botão-direito remove';
    let moved = false;
    dot.addEventListener('mousedown', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      if (readOnly || ev.button !== 0) return;   // so botao esquerdo arrasta
      dragging = true; moved = false;
      const sx = ev.clientX, sy = ev.clientY;
      function mv(e2) {
        if (Math.abs(e2.clientX - sx) + Math.abs(e2.clientY - sy) > 3) moved = true;
        const m = modelPos(e2.clientX, e2.clientY);
        const wps = (edge.data('waypoints') || []).slice();
        wps[i] = { x: Math.round(m.x), y: Math.round(m.y) };
        edge.data('waypoints', wps);
        edge.removeData('autoRouted');   // virou quebra manual
        computeSegments(edge);
        const r = rendered(wps[i].x, wps[i].y);
        dot.style.left = r.x + 'px'; dot.style.top = r.y + 'px';
      }
      function up() {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
        dragging = false;
        if (moved) { sendPatch(); refresh(); }   // clique sem mover nao gera patch
      }
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });
    dot.addEventListener('dblclick', (ev) => { ev.preventDefault(); ev.stopPropagation(); removeBend(edge, i); });
    dot.addEventListener('contextmenu', (ev) => { ev.preventDefault(); ev.stopPropagation(); removeBend(edge, i); });
  }

  // duplo-clique na seta cria uma quebra ali
  cy.on('dbltap', 'edge', (e) => {
    if (readOnly) return;
    const edge = e.target;
    if (edge.hasClass('ghost-edge')) return;
    const m = e.position;
    const wps = (edge.data('waypoints') || []).slice();
    wps.push({ x: Math.round(m.x), y: Math.round(m.y) });
    edge.data('waypoints', wps);
    edge.data('routing', 'segments');
    edge.removeData('autoRouted');       // quebra manual: organizeLines nao mexe
    computeSegments(edge);
    if (!edge.selected()) { cy.$(':selected').unselect(); edge.select(); }
    sendPatch(); refresh();
  });

  cy.on('select unselect', 'edge', refresh);
  cy.on('pan zoom render', reposition);
  cy.on('drag position', 'node', reposition);
})();

// mover um no recomputa os segmentos das setas com quebra conectadas a ele
// (waypoints sao absolutos; os params do cytoscape sao relativos aos centros)
cy.on('position', 'node', (e) => {
  e.target.connectedEdges().forEach((ed) => {
    if (!ed.hasClass('ghost-edge') && (ed.data('routing') === 'segments' || (ed.data('waypoints') || []).length)) computeSegments(ed);
  });
});

// entra no modo "ligar a partir deste no" (acionado pelo menu de contexto)
function startLinkFrom(node) {
  exitLinkMode();
  linkMode = true;
  linkSource = node;
  node.addClass('link-src');
}

// modo ligar (via menu de contexto): proximo clique num OUTRO no cria a seta
cy.on('tap', 'node', (evt) => {
  if (!linkMode || !linkSource || readOnly) return;
  const n = evt.target;
  if (n.id() !== linkSource.id()) {
    cy.add({ group: 'edges', data: { id: uid('e'), source: linkSource.id(), target: n.id(), label: '', status: 'proposed' } });
    sendPatch();
  }
  exitLinkMode();
});

function deleteSelected() {
  if (readOnly) return;
  const sel = cy.$(':selected');
  if (!sel.length) return;
  sel.remove();               // remover nos ja leva as arestas conectadas
  updateEmptyHint();
  sendPatch();
  refreshInspector();
}
el('btn-delete').addEventListener('click', deleteSelected);

// menu de layouts (Vertical/Horizontal/Arvore/Radial/Forca) no botao ⤢ layout
(function layoutMenu() {
  const menu = document.createElement('div');
  menu.id = 'layout-menu';
  menu.style.cssText = 'position:fixed;z-index:9999;background:#171a21;border:1px solid #2a2f3a;border-radius:8px;padding:4px 0;display:none;font-size:13px;min-width:130px;box-shadow:0 10px 30px rgba(0,0,0,.5);';
  document.body.appendChild(menu);

  const items = [
    { label: 'Vertical ↓', kind: 'vertical' },
    { label: 'Horizontal →', kind: 'horizontal' },
    { label: 'Árvore', kind: 'tree' },
    { label: 'Radial', kind: 'radial' },
    { label: 'Força', kind: 'force' },
  ];
  items.forEach((item) => {
    const div = document.createElement('div');
    div.textContent = item.label;
    div.style.cssText = 'padding:6px 16px;cursor:pointer;color:#c8d0e0;';
    div.addEventListener('mouseenter', () => { div.style.background = '#2a2f3a'; });
    div.addEventListener('mouseleave', () => { div.style.background = 'transparent'; });
    div.addEventListener('click', (e) => { e.stopPropagation(); menu.style.display = 'none'; runNamedLayout(item.kind); });
    menu.appendChild(div);
  });

  el('btn-layout').addEventListener('click', function (e) {
    e.stopPropagation();
    if (menu.style.display === 'block') { menu.style.display = 'none'; return; }
    const rect = this.getBoundingClientRect();
    menu.style.left = Math.min(rect.left, window.innerWidth - 150) + 'px';
    menu.style.top = (rect.bottom + 4) + 'px';
    menu.style.display = 'block';
  });
  document.addEventListener('click', (e) => { if (!menu.contains(e.target) && e.target.id !== 'btn-layout') menu.style.display = 'none'; });
})();

function runNamedLayout(kind) {
  let opts;
  const base = { fit: true, padding: 50, animate: false };
  if (kind === 'horizontal') opts = DAGRE_OK ? { name: 'dagre', rankDir: 'LR', nodeSep: 55, rankSep: 70, edgeSep: 15, ...base } : { name: 'breadthfirst', directed: true, spacingFactor: 1.3, ...base };
  else if (kind === 'tree') opts = { name: 'breadthfirst', directed: true, spacingFactor: 1.3, ...base };
  else if (kind === 'radial') opts = { name: 'concentric', minNodeSpacing: 40, concentric: (n) => n.degree(), levelWidth: () => 1, ...base };
  else if (kind === 'force') opts = { name: 'cose', idealEdgeLength: 120, nodeRepulsion: 8000, ...base };
  else opts = DAGRE_OK ? { name: 'dagre', rankDir: 'TB', nodeSep: 55, rankSep: 70, edgeSep: 15, ...base } : { name: 'breadthfirst', directed: true, spacingFactor: 1.3, ...base };
  const layout = cy.layout(opts);
  layout.one('layoutstop', () => { organizeLines(); });  // apos reposicionar, contorna os nos
  layout.run();
}
el('btn-routes').addEventListener('click', () => organizeLines());

// ---- export (PNG + Mermaid) -----------------------------------------------
function download(href, filename) {
  const a = document.createElement('a');
  a.href = href; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
}
function safeName() { return (currentTitle || 'flowforge').replace(/[^a-z0-9\-_]+/gi, '_').slice(0, 60) || 'flowforge'; }
el('btn-export-png').addEventListener('click', () => {
  if (cy.nodes().empty()) return;
  const png = cy.png({ full: true, scale: 2, bg: '#0f1115' });
  download(png, safeName() + '.png');
});
function toMermaid() {
  const d = cyToDiagram();
  const lines = ['flowchart TD'];
  const idmap = {};
  d.nodes.forEach((n, i) => {
    const nid = 'N' + i; idmap[n.id] = nid;
    const lbl = (n.label || '').replace(/"/g, "'");
    let o = '[', c = ']';
    const k = n.kind;
    if (k === 'decision' || k === 'gateway-exclusive' || k === 'gateway-parallel') { o = '{'; c = '}'; }
    else if (k === 'idea') { o = '(('; c = '))'; }
    else if (k === 'data-object') { o = '[('; c = ')]'; }
    else if (k === 'start' || k === 'end' || k === 'event-start' || k === 'event-end' || k === 'event-intermediate') { o = '(['; c = '])'; }
    lines.push('  ' + nid + o + '"' + lbl + '"' + c);
  });
  d.edges.forEach((e) => {
    const s = idmap[e.source], t = idmap[e.target];
    if (!s || !t) return;
    const lbl = (e.label || '').replace(/"/g, "'");
    lines.push('  ' + s + (lbl ? (' -->|"' + lbl + '"| ') : ' --> ') + t);
  });
  return lines.join('\n');
}
el('btn-export-mmd').addEventListener('click', () => {
  const txt = toMermaid();
  download('data:text/plain;charset=utf-8,' + encodeURIComponent(txt), safeName() + '.mmd');
});

// ---- busca de no ----------------------------------------------------------
function jumpToNode(q) {
  q = (q || '').trim().toLowerCase();
  if (!q) return;
  const hit = cy.nodes().filter((n) => !n.hasClass('ghost') && (n.data('label') || '').toLowerCase().includes(q))[0];
  if (!hit) return;
  cy.$(':selected').unselect();
  hit.select();
  cy.animate({ fit: { eles: hit, padding: 160 } }, { duration: 300 });
}
el('node-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); jumpToNode(e.target.value); } });

// ---- seletor de sessoes ---------------------------------------------------
(function sessionPicker() {
  const sel = el('session-sel');
  if (!sel) return;
  fetch('/api/sessions').then((r) => r.json()).then((d) => {
    const list = (d && d.sessions) || [];
    if (!list.includes(SESSION)) list.unshift(SESSION);
    sel.innerHTML = '';
    list.forEach((s) => { const o = document.createElement('option'); o.value = s; o.textContent = s; if (s === SESSION) o.selected = true; sel.appendChild(o); });
  }).catch(() => {});
  sel.addEventListener('change', () => {
    const s = sel.value;
    if (s && s !== SESSION) location.search = '?session=' + encodeURIComponent(s);
  });
})();

// selecao: no -> card do no; seta -> card da seta (ambos flutuantes)
cy.on('select', 'node', () => { refreshInspector(); openCard(); });
cy.on('unselect', 'node', () => { closeCard(); refreshInspector(); });
cy.on('select', 'edge', () => { refreshInspector(); openEdgeCard(); });
cy.on('unselect', 'edge', () => { closeEdgeCard(); refreshInspector(); });
cy.on('tap', (e) => { if (e.target === cy) { refreshInspector(); clearChanges(); } });
cy.on('dragfree', 'node', () => sendPatch());
cy.on('grab', 'node', clearChanges); // usuario comecou a mexer -> tira o realce

// ---- menu de contexto (clique-direito no no) ------------------------------
(function contextMenu() {
  const wrap = el('cy-wrap'), menu = el('ctx-menu');
  wrap.addEventListener('contextmenu', (e) => e.preventDefault());
  function hideMenu() { menu.hidden = true; }
  function addItem(label, action) {
    const div = document.createElement('div');
    div.textContent = label;
    div.style.cssText = 'padding:6px 14px;cursor:pointer;color:#c8d0e0;font-size:13px;';
    div.addEventListener('mouseenter', () => { div.style.background = '#2a2f3a'; });
    div.addEventListener('mouseleave', () => { div.style.background = 'transparent'; });
    div.addEventListener('click', (e) => { e.stopPropagation(); hideMenu(); action(); });
    menu.appendChild(div);
  }
  cy.on('cxttap', 'node', (evt) => {
    if (readOnly) return;
    const node = evt.target;
    node.select();
    menu.innerHTML = '';
    menu.style.left = evt.renderedPosition.x + 'px';
    menu.style.top = evt.renderedPosition.y + 'px';
    menu.hidden = false;
    addItem('🔗 Ligar a partir daqui', () => startLinkFrom(node));
    addItem('⧉ Duplicar', () => {
      const pos = node.position(), data = node.data();
      const d = { id: uid('n'), label: data.label, kind: data.kind, status: data.status, description: data.description, comments: [] };
      d._disp = disp(d);
      const nn = cy.add({ group: 'nodes', data: d, position: { x: pos.x + 30, y: pos.y + 30 } });
      cy.nodes().unselect(); nn.select();
      updateEmptyHint(); sendPatch();
    });
    addItem('🗑 Excluir', () => { node.remove(); updateEmptyHint(); sendPatch(); refreshInspector(); });
  });
  document.addEventListener('click', (e) => { if (!menu.contains(e.target)) hideMenu(); });
  cy.on('pan zoom', hideMenu);
  cy.on('tap', (evt) => { if (evt.target === cy) hideMenu(); });
})();

// toast "o que o Claude mudou"
el('change-see').addEventListener('click', () => {
  if (changedEles && changedEles.nonempty()) cy.animate({ fit: { eles: changedEles, padding: 80 } }, { duration: 350 });
});
el('change-x').addEventListener('click', clearChanges);

// ---- zoom + minimapa ------------------------------------------------------
function zoomBy(f) { cy.zoom({ level: cy.zoom() * f, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } }); }
el('zoom-in').addEventListener('click', () => zoomBy(1.2));
el('zoom-out').addEventListener('click', () => zoomBy(1 / 1.2));
el('zoom-fit').addEventListener('click', () => { if (cy.nodes().nonempty()) cy.animate({ fit: { eles: cy.nodes(), padding: 50 } }, { duration: 250 }); });
el('zoom-reset').addEventListener('click', () => cy.zoom({ level: 1, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } }));

(function minimap() {
  const mm = el('minimap');
  if (!mm || !mm.getContext) return;
  const ctx = mm.getContext('2d');
  const W = mm.width, H = mm.height, PAD = 12;
  let tf = null, raf = null;
  const color = (s) => s === 'approved' ? '#2fbf71' : s === 'rejected' ? '#e5484d' : s === 'questioned' ? '#f5a623' : '#8b93a3';

  function draw() {
    raf = null;
    ctx.clearRect(0, 0, W, H);
    const ns = cy.nodes().filter((n) => !n.hasClass('ghost'));
    if (ns.empty()) { tf = null; return; }
    const bb = ns.boundingBox();
    const s = Math.min((W - 2 * PAD) / Math.max(1, bb.w), (H - 2 * PAD) / Math.max(1, bb.h));
    const ox = PAD + (W - 2 * PAD - bb.w * s) / 2 - bb.x1 * s;
    const oy = PAD + (H - 2 * PAD - bb.h * s) / 2 - bb.y1 * s;
    tf = { s, ox, oy };
    ns.forEach((n) => {
      const p = n.position();
      ctx.fillStyle = color(n.data('status'));
      ctx.fillRect(p.x * s + ox - 2, p.y * s + oy - 2, 4, 4);
    });
    const ext = cy.extent();
    ctx.strokeStyle = '#ffcc33'; ctx.lineWidth = 1;
    ctx.strokeRect(ext.x1 * s + ox, ext.y1 * s + oy, (ext.x2 - ext.x1) * s, (ext.y2 - ext.y1) * s);
  }
  function schedule() { if (!raf) raf = requestAnimationFrame(draw); }
  cy.on('pan zoom position add remove', schedule);
  schedule();

  mm.addEventListener('mousedown', (e) => {
    if (!tf) return;
    const rect = mm.getBoundingClientRect();
    const modelX = (e.clientX - rect.left - tf.ox) / tf.s;
    const modelY = (e.clientY - rect.top - tf.oy) / tf.s;
    const z = cy.zoom();
    cy.pan({ x: cy.width() / 2 - modelX * z, y: cy.height() / 2 - modelY * z });
  });
})();

// ---- efeito de "pulo" nos cruzamentos (SEMPRE LIGADO) ---------------------
// Overlay proprio (nao desenha na canvas do cytoscape). So arestas ortogonais.
// Estilo Bizagi: a HORIZONTAL e o "chao" (passa reta) e a VERTICAL pula com um
// semicirculo por cima. Coordenadas RENDERIZADAS (rendered*).
(function hopLayer() {
  const cv = el('hoplayer');
  if (!cv || !cv.getContext) return;
  const ctx = cv.getContext('2d');
  let scheduled = false;

  function ecolor(status) {
    if (status === 'approved') return '#2fbf71';
    if (status === 'rejected') return '#e5484d';
    if (status === 'questioned') return '#f5a623';
    return '#3a4150';
  }
  function schedule() { if (!scheduled) { scheduled = true; requestAnimationFrame(draw); } }

  function draw() {
    scheduled = false;
    const container = el('cy');
    const w = container.clientWidth, h = container.clientHeight, dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      cv.style.width = w + 'px'; cv.style.height = h + 'px';
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const edges = cy.edges().filter((e) => !e.hasClass('ghost-edge') && e.data('routing') !== 'bezier');
    if (edges.length < 2 || edges.length > 200) return;

    const items = [];
    edges.forEach((e) => {
      const pts = [];
      const src = e.renderedSourceEndpoint(), tgt = e.renderedTargetEndpoint();
      pts.push({ x: src.x, y: src.y });
      try { const sp = e.renderedSegmentPoints(); if (sp && sp.length) sp.forEach((s) => pts.push({ x: s.x, y: s.y })); } catch (_) {}
      pts.push({ x: tgt.x, y: tgt.y });
      const color = ecolor(e.data('status'));
      const segs = [];
      for (let i = 0; i < pts.length - 1; i++) segs.push({ x1: pts[i].x, y1: pts[i].y, x2: pts[i + 1].x, y2: pts[i + 1].y, color });
      items.push(segs);
    });

    // a linha do cytoscape engrossa com o zoom (largura*zoom); o overlay tem que
    // acompanhar, senao no zoom in as linhas ficam mais grossas que o desenho.
    const z = cy.zoom();
    const lw = 2 * z;                 // largura renderizada da aresta (width 2 no modelo)
    const R = 6 + 3 * z, BG = '#0f1115';
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        items[i].forEach((s1) => items[j].forEach((s2) => {
          let hSeg, vSeg;
          if (Math.abs(s1.y1 - s1.y2) < 0.5 && Math.abs(s2.x1 - s2.x2) < 0.5) { hSeg = s1; vSeg = s2; }
          else if (Math.abs(s1.x1 - s1.x2) < 0.5 && Math.abs(s2.y1 - s2.y2) < 0.5) { hSeg = s2; vSeg = s1; }
          else return;
          const cx = vSeg.x1, cy2 = hSeg.y1;
          // so PULA em cruzamento REAL (X): o ponto tem que estar no INTERIOR dos dois
          // segmentos (margem m). Perto de uma ponta = juncao em T/canto -> sem pulo.
          const m = 4 + lw;
          if (cx < Math.min(hSeg.x1, hSeg.x2) + m || cx > Math.max(hSeg.x1, hSeg.x2) - m) return;
          if (cy2 < Math.min(vSeg.y1, vSeg.y2) + m || cy2 > Math.max(vSeg.y1, vSeg.y2) - m) return;
          // 1) apaga so o trecho da vertical no cruzamento (faixa estreita)
          ctx.lineCap = 'butt'; ctx.strokeStyle = BG; ctx.lineWidth = lw + 2.5;
          ctx.beginPath(); ctx.moveTo(cx, cy2 - R); ctx.lineTo(cx, cy2 + R); ctx.stroke();
          // 2) redesenha o "chao" horizontal continuo, cobrindo folgado o vao
          ctx.lineCap = 'round'; ctx.strokeStyle = hSeg.color; ctx.lineWidth = lw + 1;
          ctx.beginPath(); ctx.moveTo(cx - R - 5, cy2); ctx.lineTo(cx + R + 5, cy2); ctx.stroke();
          // 3) semicirculo da vertical por cima (bojo pra esquerda)
          ctx.lineCap = 'round'; ctx.strokeStyle = vSeg.color; ctx.lineWidth = lw;
          ctx.beginPath(); ctx.arc(cx, cy2, R, Math.PI * 0.5, Math.PI * 1.5); ctx.stroke();
        }));
      }
    }
  }
  cy.on('render pan zoom position add remove', schedule);
  schedule();
})();

// teclado: Del apaga selecionado, Esc sai do modo ligar
document.addEventListener('keydown', (e) => {
  const k = (e.key || '').toLowerCase();
  // undo/redo funcionam mesmo com foco fora do canvas, mas nao dentro de campos de texto
  const inField = e.target.matches('input, textarea, [contenteditable]');
  if (!inField && (e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
  if (!inField && (e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
  if (inField) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
  if (e.key === 'Escape') {
    if (linkMode) exitLinkMode();
    else if (!el('node-card').hidden || !el('edge-card').hidden) { closeCard(); closeEdgeCard(); cy.$(':selected').unselect(); }
  }
});

// ---- titulo editavel ------------------------------------------------------
titleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); } });
titleEl.addEventListener('blur', () => {
  const t = (titleEl.textContent || '').trim() || 'Sem titulo';
  titleEl.textContent = t;
  if (t !== currentTitle) { currentTitle = t; sendPatch(); }
});

// ---- estado vazio ---------------------------------------------------------
function updateEmptyHint() { const h = el('empty-hint'); if (h) h.hidden = cy.nodes().length > 0; }

// ---- analisar -------------------------------------------------------------
function setWaiting(on) {
  waitingClaude = on;
  const b = el('btn-analyze');
  b.classList.toggle('waiting', on);
  b.textContent = on ? '⏳ Claude analisando…' : '▶ Analisar com o Claude';
}

// modo leitura enquanto o Claude "pensa": ver/navegar sim, editar nao.
function setReadOnly(on) {
  if (readOnly === on) return;
  readOnly = on;
  cy.autolock(on);                                  // trava arrastar nos (deixa selecionar/pan)
  document.body.classList.toggle('ro', on);
  ['insp-label', 'insp-kind', 'insp-desc', 'edge-label'].forEach((id) => { const x = el(id); if (x) x.disabled = on; });
  document.querySelectorAll('#node-card .status-btns .st, #edge-status .st').forEach((b) => { b.disabled = on; });
  ['note-add-btn', 'btn-delete', 'btn-layout'].forEach((id) => { const x = el(id); if (x) x.disabled = on; });
  titleEl.contentEditable = on ? 'false' : 'true';
  if (on) { if (linkMode) exitLinkMode(); hideConnNubs(); }
  refreshBends();                                   // some com os pontos de quebra
  const t = el('thinking'); if (t) t.hidden = !on;
}
function askClaude(note) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'analyze', note: note || '' }));
  setWaiting(true);
}
el('btn-analyze').addEventListener('click', () => {
  const note = el('analyze-note').value.trim();
  askClaude(note);
  el('analyze-note').value = '';
});

// ---- websocket ------------------------------------------------------------
let reconnectDelay = 800;
function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => { connPill.textContent = 'conectado'; connPill.className = 'pill on'; reconnectDelay = 800; };
  ws.onclose = () => {
    connPill.textContent = 'reconectando…'; connPill.className = 'pill off';
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(Math.round(reconnectDelay * 1.6), 10000);   // backoff ate 10s
  };
  ws.onerror = () => { try { ws.close(); } catch (e) {} };
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === 'state') { applyState(msg); if (typeof msg.busy === 'boolean') setReadOnly(msg.busy); }
    else if (msg.type === 'busy') setReadOnly(!!msg.busy);
  };
}
connect();
