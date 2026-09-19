'use strict';
// =============================================================================
// server/tasks.js — <data-dir>/tasks.json: as tarefas ao vivo do CLI.
//
// O contrato e o de `web-next/src/types.ts` (TasksFile) — esta e a copia em JS,
// como o `state.js` e a copia do workspace. Nao e um modelo do workspace, e e
// POR PROJETO (raiz do data-dir): ver o comentario em types.ts.
//
// Dois leitores/escritores usam este modulo: o servidor (so LE, e empurra pro
// browser) e o comando `adapters/tasks.js` (que os agentes chamam pra escrever).
// A escrita e leitura-modificacao-gravacao sob trava de arquivo, porque dois CLIs
// abertos no mesmo projeto publicam no mesmo arquivo.
// =============================================================================

const fs = require('fs');
const path = require('path');

const STATUSES = ['pending', 'in_progress', 'completed', 'blocked'];

function tasksPath(dataDir) { return path.join(dataDir, 'tasks.json'); }

function normalizeTasks(raw) {
  if (!raw || typeof raw !== 'object') return { rev: 0, lists: [] };
  const lists = Array.isArray(raw.lists) ? raw.lists : [];
  return {
    rev: Number.isFinite(raw.rev) ? Number(raw.rev) : 0,
    lists: lists
      .filter((l) => l && typeof l === 'object' && typeof l.id === 'string')
      .map((l) => ({
        id: l.id,
        label: typeof l.label === 'string' && l.label.trim() ? l.label : l.id,
        ...(typeof l.title === 'string' && l.title.trim() ? { title: l.title } : {}),
        updatedAt: Number.isFinite(l.updatedAt) ? Number(l.updatedAt) : 0,
        tasks: (Array.isArray(l.tasks) ? l.tasks : [])
          .filter((t) => t && typeof t === 'object')
          .map((t, i) => ({
            id: typeof t.id === 'string' && t.id ? t.id : 't' + (i + 1),
            title: String(t.title == null ? '' : t.title),
            status: STATUSES.includes(t.status) ? t.status : 'pending',
            ...(typeof t.note === 'string' && t.note.trim() ? { note: t.note } : {}),
            ...(Number.isFinite(t.updatedAt) ? { updatedAt: Number(t.updatedAt) } : {}),
          })),
      })),
  };
}

function readTasks(dataDir) {
  try { return normalizeTasks(JSON.parse(fs.readFileSync(tasksPath(dataDir), 'utf8'))); }
  catch (e) { return { rev: 0, lists: [] }; }
}

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/**
 * Le, aplica `mutate(file)` e grava de forma atomica, tudo sob trava. `mutate`
 * altera o objeto no lugar. O `rev` sobe aqui — quem chama nao cuida disso.
 */
function updateTasks(dataDir, mutate) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = tasksPath(dataDir);
  const lock = file + '.lock';
  let fd = null;
  for (let i = 0; fd === null; i++) {
    try { fd = fs.openSync(lock, 'wx'); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // trava orfa (processo morreu segurando): depois de 5s ninguem mais a defende
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 5000) fs.unlinkSync(lock); } catch (e2) { /* sumiu sozinha */ }
      if (i > 200) throw new Error('nao consegui a trava de ' + file);
      sleepSync(25);
    }
  }
  try {
    const data = readTasks(dataDir);
    mutate(data);
    data.rev += 1;
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(normalizeTasks(data), null, 2));
    fs.renameSync(tmp, file);
    return data;
  } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(lock); } catch (e) { /* ja foi */ }
  }
}

module.exports = { STATUSES, tasksPath, normalizeTasks, readTasks, updateTasks };
