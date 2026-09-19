'use strict';
// =============================================================================
// server/activity.js — <data-dir>/activity.jsonl: o que o agente FEZ, na ordem.
//
// Contrato em `web-next/src/types.ts` (ActivityEvent); esta e a copia em JS.
// Append-only, uma linha JSON por acao, por PROJETO — irmao do tasks.json.
// O servidor LE o fim do arquivo e empurra pro browser; quem escreve e o comando
// `adapters/activity.js` (chamado por hook do harness, ou pelo proprio agente).
// =============================================================================

const fs = require('fs');
const path = require('path');

const KINDS = ['read', 'edit', 'run', 'search', 'web', 'agent', 'tool', 'note', 'prompt', 'stop'];
const MAX_BYTES = 512 * 1024; // passou disso, fica so o fim: e linha do tempo, nao auditoria
const KEEP_LINES = 800;

function activityPath(dataDir) { return path.join(dataDir, 'activity.jsonl'); }

function normalizeEvent(e) {
  if (!e || typeof e !== 'object' || !Number.isFinite(e.ts)) return null;
  const files = Array.isArray(e.files) ? e.files.filter((f) => typeof f === 'string').slice(0, 20) : [];
  return {
    ts: Number(e.ts),
    source: typeof e.source === 'string' && e.source ? e.source : 'cli',
    label: typeof e.label === 'string' && e.label ? e.label : String(e.source || 'CLI'),
    kind: KINDS.includes(e.kind) ? e.kind : 'tool',
    summary: String(e.summary == null ? '' : e.summary).replace(/\s+/g, ' ').trim().slice(0, 200),
    ...(files.length ? { files } : {}),
    ...(typeof e.task === 'string' && e.task ? { task: e.task } : {}),
    ...(e.failed === true ? { failed: true } : {}),
  };
}

/** As ultimas `n` acoes, da mais antiga pra mais nova. Le so o FIM do arquivo. */
function readTail(dataDir, n = 200) {
  const file = activityPath(dataDir);
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) { return []; }
  try {
    const size = fs.fstatSync(fd).size;
    const want = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(want);
    fs.readSync(fd, buf, 0, want, size - want);
    const lines = buf.toString('utf8').split('\n');
    if (want < size) lines.shift(); // a primeira pode ter vindo cortada no meio
    const out = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try { const ev = normalizeEvent(JSON.parse(line)); if (ev) out.push(ev); } catch (e) { /* linha torta nao derruba a leitura */ }
    }
    return out.slice(-n);
  } finally { fs.closeSync(fd); }
}

function appendEvent(dataDir, event) {
  const ev = normalizeEvent(event);
  if (!ev || !ev.summary) return null;
  fs.mkdirSync(dataDir, { recursive: true });
  const file = activityPath(dataDir);
  fs.appendFileSync(file, JSON.stringify(ev) + '\n'); // O_APPEND: linha pequena entra inteira mesmo com dois escritores
  try {
    if (fs.statSync(file).size > MAX_BYTES) {
      const keep = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-KEEP_LINES).join('\n') + '\n';
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, keep);
      fs.renameSync(tmp, file);
    }
  } catch (e) { /* podar e cortesia: se falhar, a proxima escrita tenta de novo */ }
  return ev;
}

module.exports = { KINDS, activityPath, normalizeEvent, readTail, appendEvent };
