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
let claudeMsgCount = 0;       // pra saber quando o Claude respondeu
let waitingClaude = false;

const el = (id) => document.getElementById(id);
const connPill = el('conn');
const titleEl = el('title');

// ---- Cytoscape ------------------------------------------------------------
const cy = cytoscape({
  container: el('cy'),
  wheelSensitivity: 0.2,
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
    { selector: 'node[status="approved"]', style: { 'border-color': '#2fbf71' } },
    { selector: 'node[status="rejected"]', style: { 'border-color': '#e5484d' } },
    { selector: 'node[status="questioned"]', style: { 'border-color': '#f5a623' } },
    { selector: 'node:selected', style: { 'border-color': '#ffcc33', 'border-width': 4 } },
    { selector: 'edge', style: {
      'width': 2, 'line-color': '#3a4150', 'target-arrow-color': '#3a4150',
      'target-arrow-shape': 'triangle', 'curve-style': 'bezier',
      'label': 'data(label)', 'color': '#8b93a3', 'font-size': 11,
      'text-background-color': '#0f1115', 'text-background-opacity': 1, 'text-background-padding': 2,
    }},
    { selector: 'edge[status="approved"]', style: { 'line-color': '#2fbf71', 'target-arrow-color': '#2fbf71' } },
    { selector: 'edge[status="rejected"]', style: { 'line-color': '#e5484d', 'target-arrow-color': '#e5484d', 'line-style': 'dashed' } },
    { selector: 'edge:selected', style: { 'line-color': '#ffcc33', 'target-arrow-color': '#ffcc33', 'width': 3 } },
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
  el('btn-link').classList.remove('active');
}

// ---- helpers de dados -----------------------------------------------------
function disp(n) {
  const c = (n.comments && n.comments.length) ? '  💬' + n.comments.length : '';
  return (n.label || '') + c;
}
function uid(pfx) { return pfx + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3); }

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
    els.push({ group: 'edges', data: { id: ed.id || uid('e'), source: ed.source, target: ed.target, label: ed.label || '', status: ed.status || 'proposed' } });
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
        status: n.data('status') || 'proposed', comments: n.data('comments') || [],
        x: Number.isFinite(p.x) ? Math.round(p.x) : 0,
        y: Number.isFinite(p.y) ? Math.round(p.y) : 0,
      };
    }),
    edges: cy.edges().filter((e) => !e.hasClass('ghost-edge')).map((e) => ({
      id: e.id(), source: e.data('source'), target: e.data('target'),
      label: e.data('label') || '', status: e.data('status') || 'proposed',
    })),
  };
}

function sendPatch() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  outstandingPatches++;
  ws.send(JSON.stringify({ type: 'patch', diagram: cyToDiagram() }));
}

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
    const data = { id: n.id, label: n.label || '', kind: n.kind || 'task', status: n.status || 'proposed', comments: n.comments || [] };
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
      cy.add({ group: 'edges', data: { id: e.id, source: e.source, target: e.target, label: e.label || '', status: e.status || 'proposed' } });
    } else {
      cur.data({ label: e.label || '', status: e.status || 'proposed' });
    }
  });
  cy.endBatch();

  return nodes.some((n) => typeof n.x !== 'number' || typeof n.y !== 'number');
}

// ---- destaque do que o Claude mudou ---------------------------------------
let snapNodes = new Map();  // id -> chave comparavel (pra detectar mudanca)
let snapEdges = new Map();
let changedEles = cy.collection();
let changeTimer = null;

function nodeKey(n) { return (n.status || '') + '|' + (n.label || '') + '|' + ((n.comments || []).length) + '|' + (n.kind || ''); }
function edgeKey(e) { return e.source + '>' + e.target + '|' + (e.label || '') + '|' + (e.status || ''); }

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
function selectedNode() {
  const s = cy.$('node:selected');
  return s.length ? s[0] : null;
}

function refreshInspector() {
  const n = selectedNode();
  const empty = el('insp-empty'), body = el('insp-body');
  if (!n) { empty.hidden = false; body.hidden = true; return; }
  empty.hidden = true; body.hidden = false;
  el('insp-label').value = n.data('label') || '';
  el('insp-kind').value = n.data('kind') || 'task';
  document.querySelectorAll('.status-btns .st').forEach((b) => {
    b.classList.toggle('active', b.dataset.status === (n.data('status') || 'proposed'));
  });
  const box = el('insp-comments');
  box.innerHTML = '';
  (n.data('comments') || []).forEach((c) => {
    const d = document.createElement('div');
    d.className = 'cmt ' + (c.author || 'user');
    d.innerHTML = '<div class="who">' + (c.author === 'claude' ? 'Claude' : 'voce') + '</div>';
    const t = document.createElement('div'); t.textContent = c.text || '';
    d.appendChild(t); box.appendChild(d);
  });
}

function updateNode(mutator) {
  const n = selectedNode();
  if (!n) return;
  mutator(n);
  n.data('_disp', disp({ label: n.data('label'), comments: n.data('comments') }));
  refreshInspector();
  sendPatch();
}

// wiring inspector
el('insp-label').addEventListener('input', (e) => { const n = selectedNode(); if (n) { n.data('label', e.target.value); n.data('_disp', disp({ label: e.target.value, comments: n.data('comments') })); } });
el('insp-label').addEventListener('change', () => sendPatch());
el('insp-kind').addEventListener('change', (e) => updateNode((n) => n.data('kind', e.target.value)));
document.querySelectorAll('.status-btns .st').forEach((b) => {
  b.addEventListener('click', () => updateNode((n) => n.data('status', b.dataset.status)));
});
el('insp-comment-btn').addEventListener('click', addComment);
el('insp-comment-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addComment(); });
function addComment() {
  const input = el('insp-comment-input');
  const text = input.value.trim();
  if (!text) return;
  updateNode((n) => {
    const arr = (n.data('comments') || []).slice();
    arr.push({ author: 'user', text, ts: Date.now() });
    n.data('comments', arr);
  });
  input.value = '';
}

// ---- toolbar --------------------------------------------------------------
// cria um no numa posicao (coords de modelo), seleciona e abre pra editar
function addNodeAt(pos, kind) {
  const id = uid('n');
  const label = kind === 'start' ? 'inicio' : kind === 'end' ? 'fim'
    : kind === 'decision' ? 'decisao?' : kind === 'idea' ? 'ideia' : 'nova tarefa';
  cy.add({ group: 'nodes', data: { id, label, kind: kind || 'task', status: 'proposed', comments: [], _disp: label }, position: pos });
  cy.$(':selected').unselect();
  cy.getElementById(id).select();
  updateEmptyHint();
  sendPatch();
  setTab('no');
  const inp = el('insp-label'); if (inp) { inp.focus(); inp.select(); }
  return id;
}

// paleta: arrastar item -> soltar no canvas
document.querySelectorAll('.pal-item').forEach((it) => {
  it.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/kind', it.dataset.kind); e.dataTransfer.effectAllowed = 'copy'; });
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

// ---- nozinho de conexao (hover handle) ------------------------------------
// Passe o mouse num no -> aparece a bolinha na borda direita. Arraste dela ate
// outro no pra criar a seta. Arrastar o CORPO do no continua movendo o no.
(function connHandle() {
  const handle = el('conn-handle');
  let hoverNode = null, hideTimer = null;
  let connecting = false, connSource = null, connTarget = null;

  function modelPos(clientX, clientY) {
    const rect = el('cy').getBoundingClientRect();
    const pan = cy.pan(), zoom = cy.zoom();
    return { x: (clientX - rect.left - pan.x) / zoom, y: (clientY - rect.top - pan.y) / zoom };
  }
  function place(node) {
    const bb = node.renderedBoundingBox();
    handle.style.left = bb.x2 + 'px';
    handle.style.top = ((bb.y1 + bb.y2) / 2) + 'px';
  }
  function show(node) {
    if (linkMode || connecting) return;
    hoverNode = node; place(node); handle.hidden = false;
  }

  cy.on('mouseover', 'node', (e) => {
    const n = e.target;
    if (n.hasClass('ghost')) return;
    if (connecting) {
      if (n.id() !== connSource.id()) { connTarget = n; n.addClass('conn-target'); }
      return;
    }
    clearTimeout(hideTimer); show(n);
  });
  cy.on('mouseout', 'node', (e) => {
    if (connecting) { if (connTarget) { connTarget.removeClass('conn-target'); connTarget = null; } return; }
    hideTimer = setTimeout(() => { handle.hidden = true; }, 140);
  });
  cy.on('pan zoom', () => { if (!connecting) handle.hidden = true; });
  cy.on('drag', 'node', (e) => { if (!connecting && hoverNode && e.target.id() === hoverNode.id()) place(hoverNode); });

  handle.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  handle.addEventListener('mouseleave', () => { if (!connecting) hideTimer = setTimeout(() => { handle.hidden = true; }, 140); });

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!hoverNode) return;
    connecting = true; connSource = hoverNode; connTarget = null;
    handle.hidden = true;
    const p = modelPos(e.clientX, e.clientY);
    cy.add({ group: 'nodes', data: { id: '__ghost' }, position: p, classes: 'ghost' });
    cy.add({ group: 'edges', data: { id: '__ghostE', source: connSource.id(), target: '__ghost' }, classes: 'ghost-edge' });
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  function onMove(e) {
    const g = cy.getElementById('__ghost');
    if (g.nonempty()) g.position(modelPos(e.clientX, e.clientY));
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
  function onUp(e) {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    cy.getElementById('__ghostE').remove();
    cy.getElementById('__ghost').remove();
    const target = connTarget || nodeAt(e.clientX, e.clientY); // fallback geometrico
    if (target && connSource && target.id() !== connSource.id() && !target.hasClass('ghost')) {
      cy.add({ group: 'edges', data: { id: uid('e'), source: connSource.id(), target: target.id(), label: '', status: 'proposed' } });
      sendPatch();
    }
    if (connTarget) connTarget.removeClass('conn-target');
    connecting = false; connSource = null; connTarget = null;
  }
})();

el('btn-link').addEventListener('click', () => {
  if (linkMode) { exitLinkMode(); return; }
  linkMode = true;
  linkSource = null;
  el('btn-link').classList.add('active');
});

// clique-a-clique pra ligar dois nos
cy.on('tap', 'node', (evt) => {
  if (!linkMode) return;
  const n = evt.target;
  if (!linkSource) { linkSource = n; n.addClass('link-src'); return; }
  if (n.id() !== linkSource.id()) {
    cy.add({ group: 'edges', data: { id: uid('e'), source: linkSource.id(), target: n.id(), label: '', status: 'proposed' } });
    sendPatch();
  }
  linkSource.removeClass('link-src');
  linkSource = null; // continua no modo ligar pra encadear; clique no botao pra sair
});

function deleteSelected() {
  const sel = cy.$(':selected');
  if (!sel.length) return;
  sel.remove();               // remover nos ja leva as arestas conectadas
  updateEmptyHint();
  sendPatch();
  refreshInspector();
}
el('btn-delete').addEventListener('click', deleteSelected);

el('btn-layout').addEventListener('click', () => runLayout(true, () => persistPositions()));

// selecao: ao escolher um no, abre a aba "No"
cy.on('select', 'node', () => { refreshInspector(); if (!suppressTabSwitch) setTab('no'); });
cy.on('unselect', 'node', refreshInspector);
cy.on('tap', (e) => { if (e.target === cy) { refreshInspector(); clearChanges(); } });
cy.on('dragfree', 'node', () => sendPatch());
cy.on('grab', 'node', clearChanges); // usuario comecou a mexer -> tira o realce

// toast "o que o Claude mudou"
el('change-see').addEventListener('click', () => {
  if (changedEles && changedEles.nonempty()) cy.animate({ fit: { eles: changedEles, padding: 80 } }, { duration: 350 });
});
el('change-x').addEventListener('click', clearChanges);

// teclado: Del apaga selecionado, Esc sai do modo ligar
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, [contenteditable]')) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
  if (e.key === 'Escape' && linkMode) exitLinkMode();
});

// ---- abas (No x Conversa) -------------------------------------------------
function setTab(name) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  el('tab-no').hidden = name !== 'no';
  el('tab-conversa').hidden = name !== 'conversa';
}
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

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
el('btn-analyze').addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const note = el('analyze-note').value.trim();
  ws.send(JSON.stringify({ type: 'analyze', note }));
  el('analyze-note').value = '';
  setWaiting(true);
});

// ---- websocket ------------------------------------------------------------
function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => { connPill.textContent = 'conectado'; connPill.className = 'pill on'; };
  ws.onclose = () => { connPill.textContent = 'desconectado'; connPill.className = 'pill off'; setTimeout(connect, 1000); };
  ws.onerror = () => { try { ws.close(); } catch (e) {} };
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === 'state') applyState(msg);
  };
}
connect();
