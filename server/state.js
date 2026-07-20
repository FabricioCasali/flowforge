'use strict';
// Estado da sessao em arquivos: diagram.json + thread.json + inbox.jsonl.
// Arquivos sao a fonte da verdade. O Claude edita esses arquivos diretamente;
// o servidor (index.js) apenas espelha arquivo <-> browser.

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
function threadPath(slug) { return path.join(sessionDir(slug), 'thread.json'); }
function inboxPath(slug) { return path.join(sessionDir(slug), 'inbox.jsonl'); }

function emptyDiagram(title) {
  return {
    type: 'flowchart',
    title: title || 'Novo diagrama',
    rev: 0,
    updatedBy: 'claude',
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

function ensureSession(slug, title) {
  fs.mkdirSync(sessionDir(slug), { recursive: true });
  if (!fs.existsSync(diagramPath(slug))) writeJson(diagramPath(slug), emptyDiagram(title));
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
function readState(slug) { return { diagram: readDiagram(slug), thread: readThread(slug) }; }

// Grava o diagrama vindo do browser. O servidor eh a autoridade do rev:
// incrementa a cada escrita de origem-usuario.
function writeDiagram(slug, diagram, by) {
  const prev = readDiagram(slug);
  diagram.rev = (Number(prev.rev) || 0) + 1;
  diagram.updatedBy = by || 'user';
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

// Registra um pedido de "Analisar" num log append-only, pra nada se perder
// mesmo se o Monitor do Claude nao estiver conectado no instante do clique.
function appendInbox(slug, entry) {
  fs.mkdirSync(sessionDir(slug), { recursive: true });
  fs.appendFileSync(inboxPath(slug), JSON.stringify(entry) + '\n');
}

module.exports = {
  setDataDir, getRoot, slugify, sessionDir, diagramPath, threadPath, inboxPath,
  emptyDiagram, ensureSession, listSessions,
  readDiagram, readThread, readState,
  writeDiagram, appendThread, appendInbox,
  readJson, writeJson,
};
