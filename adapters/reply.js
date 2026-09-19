// =============================================================================
// adapters/reply.js — a resposta do agente num arquivo so.
//
// Medido em 18/09/2026: num mapa de 33 nos o agente gastou ~50 s de 113 s fazendo
// 13 `Edit` em sequencia no workspace.json (22 KB), um por no. O trabalho dele e
// DECIDIR o que muda; aplicar no JSON e mecanico — e e onde ele erra o `rev`,
// quebra uma virgula ou apaga um comentario do usuario.
//
// Entao o agente grava UM arquivo pequeno, <sessao>/reply.json, e o adapter
// aplica. Editar o workspace.json direto continua valendo para o que isto nao
// cobre (fields de ER, lanes, o modelo seq).
//
//   { "model": "mind",                       // process | state | er | mind
//     "message": "texto pro chat do canvas",
//     "update":      [{ "id": "m3", "status": "approved", "label": "…", "description": "…",
//                       "kind": "…", "comment": "…", "commentKind": "note|question|reject" }],
//     "addNodes":    [{ "id": "m40", "label": "…", "kind": "idea", "status": "proposed",
//                       "description": "…", "comment": "…", "lane": "…" }],
//     "addEdges":    [{ "source": "m3", "target": "m40", "label": "" }],
//     "updateEdges": [{ "id": "e7", "status": "rejected", "label": "…" }],
//     "removeNodes": ["m9"], "removeEdges": ["e12"] }
//
// Tudo e opcional menos `message`. So `message` = resposta sem mexer no desenho.
// =============================================================================

const fs = require('fs');
const path = require('path');

const MODELS = ['process', 'state', 'er', 'mind'];
const STATUSES = ['proposed', 'approved', 'questioned', 'rejected'];
const COMMENT_KINDS = ['note', 'question', 'reject'];

function replyPath(evt) { return path.join(path.dirname(evt.workspacePath), 'reply.json'); }

function freshId(prefix, used) {
  let k = used.size + 1;
  while (used.has(prefix + k)) k++;
  used.add(prefix + k);
  return prefix + k;
}

/** A seta tem status proprio: recalcula SO as setas do no que mudou (SCHEMA, regra 4). */
function propagateFrom(model, nodeId) {
  const statusOf = new Map(model.nodes.map((n) => [n.id, n.status]));
  for (const e of model.edges) {
    if (e.source !== nodeId && e.target !== nodeId) continue;
    const a = statusOf.get(e.source);
    const b = statusOf.get(e.target);
    e.status = a === b && a !== 'proposed' && STATUSES.includes(a) ? a : 'proposed';
  }
}

/**
 * Aplica a resposta no workspace (no lugar). Devolve { changed, message, problems }.
 * Item invalido e PULADO e relatado, nao derruba o resto: um id errado entre dez
 * operacoes nao pode jogar fora as outras nove.
 */
function applyReply(workspace, reply, now = Date.now()) {
  const problems = [];
  const message = typeof reply.message === 'string' ? reply.message.trim() : '';
  const hasOps = ['update', 'addNodes', 'addEdges', 'updateEdges', 'removeNodes', 'removeEdges']
    .some((k) => Array.isArray(reply[k]) && reply[k].length);
  if (!hasOps) return { changed: false, message, problems };

  if (!MODELS.includes(reply.model)) {
    return { changed: false, message, problems: ['"model" precisa ser um de ' + MODELS.join(', ') + ' — nada foi aplicado'] };
  }
  const model = workspace[reply.model];
  model.nodes = Array.isArray(model.nodes) ? model.nodes : [];
  model.edges = Array.isArray(model.edges) ? model.edges : [];
  const nodeIds = new Set(model.nodes.map((n) => n.id));
  const edgeIds = new Set(model.edges.map((e) => e.id));
  const byId = () => new Map(model.nodes.map((n) => [n.id, n]));
  const comment = (node, text, kind) => {
    if (typeof text !== 'string' || !text.trim()) return;
    node.comments = Array.isArray(node.comments) ? node.comments : [];
    node.comments.push({ author: 'agent', kind: COMMENT_KINDS.includes(kind) ? kind : 'note', text: text.trim(), ts: now });
  };
  let changed = false;

  for (const id of reply.removeNodes || []) {
    if (!nodeIds.has(id)) { problems.push('removeNodes: no "' + id + '" nao existe'); continue; }
    model.nodes = model.nodes.filter((n) => n.id !== id);
    model.edges = model.edges.filter((e) => e.source !== id && e.target !== id); // seta pendurada some junto
    nodeIds.delete(id);
    changed = true;
  }
  for (const id of reply.removeEdges || []) {
    if (!model.edges.some((e) => e.id === id)) { problems.push('removeEdges: seta "' + id + '" nao existe'); continue; }
    model.edges = model.edges.filter((e) => e.id !== id);
    changed = true;
  }

  for (const n of reply.addNodes || []) {
    if (!n || typeof n.label !== 'string' || !n.label.trim()) { problems.push('addNodes: no sem label foi pulado'); continue; }
    let id = typeof n.id === 'string' && n.id.trim() ? n.id.trim() : null;
    if (id && nodeIds.has(id)) { problems.push('addNodes: id "' + id + '" ja existe; use update'); continue; }
    if (!id) id = freshId('a', nodeIds); else nodeIds.add(id);
    const node = {
      id, label: n.label.trim(),
      kind: typeof n.kind === 'string' && n.kind ? n.kind : (reply.model === 'mind' ? 'idea' : reply.model === 'er' ? 'entity' : 'task'),
      status: STATUSES.includes(n.status) ? n.status : 'proposed',
      ...(typeof n.description === 'string' && n.description.trim() ? { description: n.description.trim() } : {}),
      comments: [],
      ...(typeof n.lane === 'string' && n.lane ? { lane: n.lane } : {}),
      // sem x/y de proposito: o editor posiciona no referencial do desenho que ja existe
    };
    comment(node, n.comment, n.commentKind);
    model.nodes.push(node);
    changed = true;
  }

  const touched = new Set();
  const nodes = byId();
  for (const u of reply.update || []) {
    const node = u && nodes.get(u.id);
    if (!node) { problems.push('update: no "' + (u && u.id) + '" nao existe'); continue; }
    if (typeof u.label === 'string' && u.label.trim()) node.label = u.label.trim();
    if (typeof u.description === 'string') node.description = u.description;
    if (typeof u.kind === 'string' && u.kind) node.kind = u.kind;
    if (u.status !== undefined) {
      if (!STATUSES.includes(u.status)) problems.push('update ' + u.id + ': status "' + u.status + '" invalido, ignorado');
      else if (node.status !== u.status) { node.status = u.status; touched.add(node.id); }
    }
    comment(node, u.comment, u.commentKind);
    changed = true;
  }

  for (const e of reply.addEdges || []) {
    if (!e || !nodeIds.has(e.source) || !nodeIds.has(e.target)) { problems.push('addEdges: ' + JSON.stringify(e) + ' aponta pra no que nao existe'); continue; }
    if (model.edges.some((x) => x.source === e.source && x.target === e.target)) continue; // ja ligado
    model.edges.push({ id: freshId('ea', edgeIds), source: e.source, target: e.target, label: typeof e.label === 'string' ? e.label : '', status: 'proposed' });
    touched.add(e.source);
    changed = true;
  }

  for (const id of touched) propagateFrom(model, id);

  // depois da propagacao: o veredito explicito do agente sobre uma seta vence o derivado
  for (const u of reply.updateEdges || []) {
    const edge = u && model.edges.find((e) => e.id === u.id);
    if (!edge) { problems.push('updateEdges: seta "' + (u && u.id) + '" nao existe'); continue; }
    if (typeof u.label === 'string') edge.label = u.label;
    if (STATUSES.includes(u.status)) edge.status = u.status;
    changed = true;
  }

  return { changed, message, problems };
}

/**
 * Le e consome o reply.json. Devolve null se o agente nao usou o caminho rapido
 * (editou o workspace direto, ou so escreveu no thread).
 */
function consumeReply(evt) {
  const file = replyPath(evt);
  if (!fs.existsSync(file)) return null;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } finally { try { fs.unlinkSync(file); } catch (e) { /* ja foi */ } }
  try { return { reply: JSON.parse(raw) }; }
  catch (e) { return { error: 'reply.json invalido (' + e.message + ')' }; }
}

module.exports = { applyReply, consumeReply, replyPath, propagateFrom };
