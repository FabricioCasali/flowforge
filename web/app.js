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
    { selector: 'node:selected', style: { 'outline-color': '#ffcc33', 'outline-width': 3, 'outline-offset': 2 } },
    { selector: 'edge', style: {
      'width': 2, 'line-color': '#3a4150', 'target-arrow-color': '#3a4150',
      'target-arrow-shape': 'triangle', 'curve-style': 'bezier',
      'label': 'data(label)', 'color': '#8b93a3', 'font-size': 11,
      'text-background-color': '#0f1115', 'text-background-opacity': 1, 'text-background-padding': 2,
    }},
    { selector: 'edge[status="approved"]', style: { 'line-color': '#2fbf71', 'target-arrow-color': '#2fbf71' } },
    { selector: 'edge[status="rejected"]', style: { 'line-color': '#e5484d', 'target-arrow-color': '#e5484d', 'line-style': 'dashed' } },
    { selector: 'edge[status="questioned"]', style: { 'line-color': '#f5a623', 'target-arrow-color': '#f5a623' } },
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
  const d = n.description ? '  📄' : '';
  return (n.label || '') + c + d;
}
function uid(pfx) { return pfx + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3); }
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
        status: n.data('status') || 'proposed', description: n.data('description') || '',
        comments: n.data('comments') || [],
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

function nodeKey(n) { return (n.status || '') + '|' + (n.label || '') + '|' + ((n.comments || []).length) + '|' + (n.kind || '') + '|' + (n.description || ''); }
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

function refreshInspector() {
  const n = selectedNode();
  const e = n ? null : selectedEdge();
  el('insp-empty').hidden = !!(n || e);
  el('insp-body').hidden = !n;
  el('insp-edge').hidden = !e;

  if (n) {
    el('insp-label').value = n.data('label') || '';
    el('insp-kind').value = n.data('kind') || 'task';
    el('insp-desc').value = n.data('description') || '';
    document.querySelectorAll('#insp-body .status-btns .st').forEach((b) => {
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
document.querySelectorAll('#insp-body .status-btns .st').forEach((b) => {
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
cy.on('select', 'edge', () => { refreshInspector(); if (!suppressTabSwitch) setTab('no'); });
cy.on('unselect', 'edge', refreshInspector);
cy.on('tap', (e) => { if (e.target === cy) { refreshInspector(); clearChanges(); } });
cy.on('dragfree', 'node', () => sendPatch());
cy.on('grab', 'node', clearChanges); // usuario comecou a mexer -> tira o realce

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

// teclado: Del apaga selecionado, Esc sai do modo ligar
document.addEventListener('keydown', (e) => {
  const k = (e.key || '').toLowerCase();
  // undo/redo funcionam mesmo com foco fora do canvas, mas nao dentro de campos de texto
  const inField = e.target.matches('input, textarea, [contenteditable]');
  if (!inField && (e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
  if (!inField && (e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
  if (inField) return;
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
