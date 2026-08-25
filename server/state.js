'use strict';
// Estado da sessao em arquivos: workspace.json + diagram.json + thread.json + inbox.jsonl.
// Arquivos sao a fonte da verdade. O agente edita esses arquivos diretamente;
// o servidor (index.js) apenas espelha arquivo <-> browser.
//
// workspace.json e o arquivo-verdade: os 5 modelos coexistem num arquivo so
// { process, state, er, mind, seq, rev, updatedBy } e o editor web-next escreve por lente.
// diagram.json e apenas legado: ensureSession faz a migracao LAZY e NAO DESTRUTIVA e
// preserva o arquivo antigo como backup (lei 5).

const fs = require('fs');
const path = require('path');

// Raiz das sessoes. Default central (flowforge/sessions); pode ser trocada por
// projeto via setDataDir (ex: <projeto>/.flowforge) — modo "por projeto".
let ROOT = path.join(__dirname, '..', 'sessions');
function setDataDir(dir) { if (dir) ROOT = path.resolve(dir); }
function getRoot() { return ROOT; }

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'sessao';
}

function sessionDir(slug) { return path.join(ROOT, slug); }
function diagramPath(slug) { return path.join(sessionDir(slug), 'diagram.json'); }
function workspacePath(slug) { return path.join(sessionDir(slug), 'workspace.json'); }
function threadPath(slug) { return path.join(sessionDir(slug), 'thread.json'); }
function inboxPath(slug) { return path.join(sessionDir(slug), 'inbox.jsonl'); }

function emptyDiagram(title) {
  return {
    type: 'flowchart',
    title: title || 'Novo diagrama',
    rev: 0,
    updatedBy: 'agent',
    lanes: [],
    nodes: [],
    edges: [],
  };
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return fallback; }
}

// Escrita atomica: grava .tmp e renomeia (evita leitura parcial pelo fs.watch).
function writeJson(p, obj) {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

// ===========================================================================
// WORKSPACE — o novo arquivo-verdade (lei 4)
// Os 5 modelos coexistem: { process, state, er, mind, seq, rev, updatedBy }.
// As 6 lentes leem esses 5 modelos: 'process' serve Fluxograma E Swimlane (mesmo
// grafo, layout diferente) — por isso o 'type' de dentro do Diagram continua vivo,
// e e ele que mantem as formas BPM e as raias.
// 'seq' NAO e um Diagram: e um modelo dedicado { participants, messages }.
// ===========================================================================

const MODEL_KEYS = ['process', 'state', 'er', 'mind', 'seq'];
function isModelKey(k) { return MODEL_KEYS.indexOf(String(k)) >= 0; }

// Mapa da migracao: o 'type' do diagram.json antigo -> em qual modelo ele vira.
// flowchart/bpm/swimlane sao o MESMO grafo visto de jeitos diferentes -> 'process'.
const TYPE_TO_MODEL = {
  flowchart: 'process',
  bpm: 'process',
  swimlane: 'process',
  er: 'er',
  mindmap: 'mind',
};

// Espelha o emptyDiagram() de web-next/src/types.ts (o contrato manda: updatedBy 'user').
// Nao confundir com o emptyDiagram() daqui de cima, que e do arquivo antigo e usa 'agent'.
function emptyModel(title, type) {
  return {
    type: type,
    title: title || 'Novo diagrama',
    rev: 0,
    updatedBy: 'user',
    lanes: [],
    nodes: [],
    edges: [],
  };
}

function emptySeq() { return { participants: [], messages: [] }; }

// Workspace zerado. Todo modelo nasce com o MESMO titulo: um workspace e UM assunto
// visto por 6 lentes — o titulo pertence a sessao, nao a lente.
function emptyWorkspace(title) {
  const t = title || 'Novo diagrama';
  return {
    process: emptyModel(t, 'flowchart'),
    state: emptyModel(t, 'flowchart'),
    er: emptyModel(t, 'er'),
    mind: emptyModel(t, 'mindmap'),
    seq: emptySeq(),
    rev: 0,
    updatedBy: 'user',
  };
}

function normalizeUpdatedBy(by) {
  // Compatibilidade de leitura/escrita com arquivos produzidos antes do protocolo de agente.
  return by === 'agent' || by === 'claude' ? 'agent' : 'user';
}

// Normaliza sem PODAR: espalha o objeto original e so preenche o que falta.
// Campo desconhecido (do agente, de uma versao futura) sobrevive intacto.
function normalizeModel(raw, title, type) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyModel(title, type);
  const d = Object.assign({}, raw);
  if (typeof d.type !== 'string' || !d.type) d.type = type || 'flowchart';
  if (typeof d.title !== 'string') d.title = title || 'Novo diagrama';
  if (typeof d.rev !== 'number') d.rev = 0;
  d.updatedBy = normalizeUpdatedBy(d.updatedBy);
  if (!Array.isArray(d.lanes)) d.lanes = [];
  if (!Array.isArray(d.nodes)) d.nodes = [];
  if (!Array.isArray(d.edges)) d.edges = [];
  return d;
}

function normalizeSeq(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptySeq();
  const s = Object.assign({}, raw);
  if (!Array.isArray(s.participants)) s.participants = [];
  if (!Array.isArray(s.messages)) s.messages = [];
  return s;
}

// Garante os 5 modelos + rev + updatedBy num objeto que veio do disco ou do browser.
// Nunca escreve: e so leitura defensiva (arquivo editado a mao nao derruba o canvas).
function normalizeWorkspace(raw, title) {
  const base = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const t = title || (base.process && typeof base.process.title === 'string' && base.process.title) || 'Novo diagrama';
  const ws = Object.assign({}, base);
  ws.process = normalizeModel(base.process, t, 'flowchart');
  ws.state = normalizeModel(base.state, t, 'flowchart');
  ws.er = normalizeModel(base.er, t, 'er');
  ws.mind = normalizeModel(base.mind, t, 'mindmap');
  ws.seq = normalizeSeq(base.seq);
  ws.rev = Number(base.rev) || 0;
  ws.updatedBy = normalizeUpdatedBy(base.updatedBy);
  return ws;
}

// Titulo da sessao vindo do workspace. O workspace nao tem campo 'title' proprio
// (o contrato sao os 5 modelos + rev + updatedBy); o titulo mora nos modelos.
function workspaceTitle(ws) {
  const order = ['process', 'state', 'er', 'mind'];
  for (let i = 0; i < order.length; i++) {
    const m = ws && ws[order[i]];
    if (m && typeof m.title === 'string' && m.title) return m.title;
  }
  return 'Novo diagrama';
}

// ---- migracao LAZY e NAO DESTRUTIVA (lei 5) -------------------------------
// Converte um diagram.json antigo num workspace. O diagram.json PERMANECE em
// disco, intocado — ele continua sendo o arquivo do editor antigo (lei 1) e o
// backup natural desta conversao.
//
// Preservacao por COPIA INTEGRAL, nao por field-mapping: o diagrama inteiro e
// copiado pra dentro do modelo de destino. Assim x, y, comments, description,
// fields, lanes, lane, sourceSide, targetSide, sourceCard, targetCard — e
// qualquer campo que eu nem saiba que existe — chegam do outro lado.
function workspaceFromDiagram(diagram) {
  const d = (diagram && typeof diagram === 'object' && !Array.isArray(diagram)) ? diagram : {};
  const title = (typeof d.title === 'string' && d.title) ? d.title : 'Novo diagrama';
  const ws = emptyWorkspace(title);

  const key = TYPE_TO_MODEL[String(d.type || 'flowchart')] || 'process';
  const copy = JSON.parse(JSON.stringify(d)); // copia profunda: nada compartilha referencia
  // o 'type' de dentro vai junto (swimlane continua swimlane, bpm continua bpm):
  // e ele que mantem as raias e as formas BPM depois da migracao.
  ws[key] = normalizeModel(copy, title, copy.type || 'flowchart');
  // A migracao preserva o diagrama legado byte a byte no arquivo antigo e campo
  // a campo dentro do workspace. A leitura normaliza `claude` para `agent`, mas
  // a copia gravada aqui conserva o valor historico original.
  if (typeof copy.updatedBy === 'string') ws[key].updatedBy = copy.updatedBy;

  // continuidade do rev: o workspace nasce no rev em que o diagrama parou, pra
  // nao voltar no tempo pra quem ja estava com a sessao aberta.
  ws.rev = Number(d.rev) || 0;
  ws.updatedBy = normalizeUpdatedBy(d.updatedBy);
  return ws;
}

function readWorkspace(slug) {
  return normalizeWorkspace(readJson(workspacePath(slug), null));
}

// Grava o workspace inteiro. O servidor e a AUTORIDADE do rev (lei 6):
// incrementa a cada escrita que passa por aqui (origem-usuario, via browser).
// O agente escreve o arquivo direto, com rev+1 e updatedBy:'agent' — nao passa aqui.
function writeWorkspace(slug, ws, by) {
  const prev = readJson(workspacePath(slug), null);
  const next = normalizeWorkspace(ws, ws && ws.process && ws.process.title);
  next.rev = (Number(prev && prev.rev) || 0) + 1;
  next.updatedBy = normalizeUpdatedBy(by);
  writeJson(workspacePath(slug), next);
  return next;
}

// Grava UMA lente dentro do workspace (o patch lens-aware do editor novo).
// Le o workspace do disco, troca so aquele modelo e sobe o rev do WORKSPACE —
// as outras 4 lentes ficam exatamente como estavam.
// Para lens 'seq' o payload e um SeqModel { participants, messages }, nao um Diagram.
function writeWorkspaceLens(slug, lens, model, by) {
  if (!isModelKey(lens)) return null;
  const ws = readWorkspace(slug);
  const rev = (Number(ws.rev) || 0) + 1;
  const updatedBy = normalizeUpdatedBy(by);

  if (lens === 'seq') {
    ws.seq = normalizeSeq(model);
  } else {
    const prev = ws[lens];
    ws[lens] = normalizeModel(model, prev.title, prev.type);
    // espelha o rev do workspace no modelo tocado: quem olhar so a lente ve em
    // que rev ela mexeu pela ultima vez. A autoridade continua sendo ws.rev.
    ws[lens].rev = rev;
    ws[lens].updatedBy = updatedBy;
  }

  ws.rev = rev;
  ws.updatedBy = updatedBy;
  writeJson(workspacePath(slug), ws);
  return ws;
}

// ---------------------------------------------------------------------------

function ensureSession(slug, title) {
  fs.mkdirSync(sessionDir(slug), { recursive: true });

  // Migracao LAZY (lei 5): so acontece se ja existe diagram.json e ainda nao
  // existe workspace.json. Acontece UMA vez, na primeira abertura da sessao.
  // O diagram.json NAO e apagado, movido nem reescrito.
  if (!fs.existsSync(workspacePath(slug))) {
    if (fs.existsSync(diagramPath(slug))) {
      const legado = readJson(diagramPath(slug), null);
      if (legado) {
        writeJson(workspacePath(slug), workspaceFromDiagram(legado));
        console.log('[migracao] ' + slug + ': diagram.json (' + (legado.type || 'flowchart') + ') -> workspace.json (diagram.json preservado)');
      } else {
        // diagram.json existe mas nao parseia: ou esta corrompido, ou pegamos ele
        // no meio de um rename. NAO criar workspace vazio aqui — a migracao e
        // one-shot, entao um vazio agora congelaria a perda pra sempre. Adia:
        // a proxima abertura da sessao tenta de novo.
        console.error('[migracao] ' + slug + ': diagram.json ilegivel — migracao ADIADA (nada foi criado)');
      }
    } else {
      writeJson(workspacePath(slug), emptyWorkspace(title));
    }
  }

  // Sessao NOVA nao ganha mais diagram.json: ele existia pro editor antigo, que
  // saiu no FF-008. A MIGRACAO acima continua — sessao antiga tem o arquivo e
  // precisa dele pra virar workspace, e ele segue preservado como backup (lei 5).
  if (!fs.existsSync(threadPath(slug))) writeJson(threadPath(slug), { messages: [] });
}

function listSessions() {
  try {
    return fs.readdirSync(ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (e) { return []; }
}

function readDiagram(slug) { return readJson(diagramPath(slug), emptyDiagram()); }
function readThread(slug) { return readJson(threadPath(slug), { messages: [] }); }
function readState(slug) {
  return { diagram: readDiagram(slug), workspace: readWorkspace(slug), thread: readThread(slug) };
}

// Grava o diagrama vindo do browser. O servidor eh a autoridade do rev:
// incrementa a cada escrita de origem-usuario.
function writeDiagram(slug, diagram, by) {
  const prev = readDiagram(slug);
  diagram.rev = (Number(prev.rev) || 0) + 1;
  diagram.updatedBy = normalizeUpdatedBy(by);
  if (!diagram.type) diagram.type = prev.type || 'flowchart';
  if (typeof diagram.title !== 'string') diagram.title = prev.title || 'Novo diagrama';
  writeJson(diagramPath(slug), diagram);
  return diagram;
}

function appendThread(slug, msg) {
  const t = readThread(slug);
  if (!Array.isArray(t.messages)) t.messages = [];
  t.messages.push(msg);
  writeJson(threadPath(slug), t);
  return t;
}

// Registra eventos do protocolo num log append-only, pra nada se perder mesmo
// se o adapter nao estiver conectado no instante do clique.
function appendInbox(slug, entry) {
  fs.mkdirSync(sessionDir(slug), { recursive: true });
  fs.appendFileSync(inboxPath(slug), JSON.stringify(entry) + '\n');
}

// Linhas incompletas ou invalidas sao ignoradas: append interrompido nao pode
// impedir o replay das demais entradas validas do inbox.
function readInbox(slug) {
  let text;
  try { text = fs.readFileSync(inboxPath(slug), 'utf8'); }
  catch (e) { return []; }

  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) entries.push(entry);
    } catch (e) {}
  }
  return entries;
}

function pendingAnalyze(slug) {
  const entries = readInbox(slug);
  const terminal = new Set(entries
    .filter((entry) => (entry.type === 'completed' || entry.type === 'failed') && typeof entry.requestId === 'string')
    .map((entry) => entry.requestId));
  return entries.filter((entry) => entry.type === 'analyze'
    && typeof entry.requestId === 'string'
    && !terminal.has(entry.requestId));
}

// Só pedido que chegou a ser entregue trava uma sessão após reinício. Um analyze
// criado offline continua pendente, mas não pode congelar o canvas antes de haver
// adapter. `accepted` cobre inboxes produzidos antes do evento `dispatched`.
function pendingDispatchedAnalyze(slug) {
  const entries = readInbox(slug);
  const terminal = new Set(entries
    .filter((entry) => (entry.type === 'completed' || entry.type === 'failed') && typeof entry.requestId === 'string')
    .map((entry) => entry.requestId));
  const dispatched = new Set(entries
    .filter((entry) => (entry.type === 'dispatched' || entry.type === 'accepted') && typeof entry.requestId === 'string')
    .map((entry) => entry.requestId));
  return entries.filter((entry) => entry.type === 'analyze'
    && typeof entry.requestId === 'string'
    && dispatched.has(entry.requestId)
    && !terminal.has(entry.requestId));
}

module.exports = {
  setDataDir, getRoot, slugify, sessionDir, inboxPath, listSessions,
  // arquivo-verdade antigo (editor web/, rota /) — lei 1: intocado
  diagramPath, emptyDiagram, readDiagram, writeDiagram,
  // arquivo-verdade novo (editor web-next/, rota /v2) — lei 4
  workspacePath, MODEL_KEYS, isModelKey, emptyWorkspace, emptySeq, emptyModel,
  normalizeWorkspace, normalizeSeq, normalizeModel, workspaceTitle,
  workspaceFromDiagram, readWorkspace, writeWorkspace, writeWorkspaceLens,
  // comuns
  ensureSession, readThread, readState, appendThread, appendInbox, readInbox, pendingAnalyze, pendingDispatchedAnalyze,
  threadPath, readJson, writeJson,
};
