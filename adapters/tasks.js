#!/usr/bin/env node
// =============================================================================
// adapters/tasks.js — o agente publica as tarefas dele no canvas.
//
// Nem todo harness tem lista de tarefas propria (o Claude Code desta maquina nao
// tem), e as que existem nao se parecem. Entao o FlowForge nao espelha a lista
// de ninguem: oferece um ARQUIVO (<projeto>/.flowforge/tasks.json, contrato em
// docs/SCHEMA.md) e este comando, que qualquer agente com shell consegue chamar.
// O servidor vigia o arquivo e a lente "Tarefas" atualiza sozinha.
//
//   plan "<objetivo>" "<tarefa>" "<tarefa>" ...   comeca (ou troca) a lista
//   add "<tarefa>"                                acrescenta no fim
//   start <n> ["nota"]                            em andamento
//   done  <n> ["nota"]                            concluida
//   block <n> "<motivo>"                          travada
//   reset <n>                                     volta para pendente
//   note  <n> "<texto>"                           so a nota
//   clear                                         tira a lista do canvas
//   show                                          imprime a lista
//
//   <n> e a posicao (1, 2, 3...) ou o id da tarefa.
//   --list <id>  --label <nome>  --data-dir <dir>
// =============================================================================

const fs = require('fs');
const path = require('path');
const T = require('../server/tasks.js');
const { findDataDir, whoAmI } = require('./project.js');

function parse(argv) {
  const opts = {};
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') opts.list = argv[++i];
    else if (a === '--label') opts.label = argv[++i];
    else if (a === '--data-dir') opts.dataDir = argv[++i];
    else args.push(a);
  }
  return { opts, cmd: args[0], rest: args.slice(1) };
}

// Lanca em vez de sair: `fail` e chamada de DENTRO da trava do arquivo, e um
// process.exit ali pularia o `finally` que a solta.
class UsageError extends Error {}
function fail(msg) { throw new UsageError(msg); }

const ICON = { pending: '[ ]', in_progress: '[>]', completed: '[x]', blocked: '[!]' };
function print(list) {
  if (!list) { console.log('(sem lista publicada)'); return; }
  console.log(list.label + (list.title ? ' — ' + list.title : ''));
  list.tasks.forEach((t, i) => console.log('  ' + (i + 1) + '. ' + ICON[t.status] + ' ' + t.title + (t.note ? '  · ' + t.note : '')));
}

function main() {
  const { opts, cmd, rest } = parse(process.argv.slice(2));
  const who = whoAmI();
  const listId = opts.list || who.id;
  const label = opts.label || (opts.list ? opts.list : who.label);
  const dataDir = opts.dataDir ? path.resolve(opts.dataDir) : findDataDir(process.cwd());
  const now = Date.now();

  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').filter((l) => l.startsWith('//')).slice(1, -1).map((l) => l.slice(3)).join('\n'));
    return;
  }
  if (cmd === 'show') { print(T.readTasks(dataDir).lists.find((l) => l.id === listId)); return; }

  const STATUS_BY_CMD = { start: 'in_progress', done: 'completed', block: 'blocked', reset: 'pending' };
  let shown = null;
  T.updateTasks(dataDir, (file) => {
    let list = file.lists.find((l) => l.id === listId);
    const ensure = () => {
      if (!list) { list = { id: listId, label, updatedAt: now, tasks: [] }; file.lists.push(list); }
      list.label = label;
      list.updatedAt = now;
      return list;
    };
    const pick = (ref) => {
      if (!list) fail('nao ha lista "' + listId + '" — comece com: plan "<objetivo>" "<tarefa>" ...');
      const n = Number(ref);
      const task = Number.isInteger(n) && n >= 1 ? list.tasks[n - 1] : list.tasks.find((t) => t.id === ref);
      if (!task) fail('tarefa "' + ref + '" nao existe (a lista tem ' + list.tasks.length + ')');
      return task;
    };

    if (cmd === 'plan') {
      if (rest.length < 2) fail('uso: plan "<objetivo>" "<tarefa>" ["<tarefa>" ...]');
      ensure();
      list.title = rest[0];
      list.tasks = rest.slice(1).map((title, i) => ({ id: 't' + (i + 1), title, status: 'pending', updatedAt: now }));
    } else if (cmd === 'add') {
      if (!rest[0]) fail('uso: add "<tarefa>"');
      ensure();
      const used = new Set(list.tasks.map((t) => t.id));
      let k = list.tasks.length + 1;
      while (used.has('t' + k)) k++;
      list.tasks.push({ id: 't' + k, title: rest[0], status: 'pending', updatedAt: now });
    } else if (STATUS_BY_CMD[cmd]) {
      if (!rest[0]) fail('uso: ' + cmd + ' <n> ["nota"]');
      if (cmd === 'block' && !rest[1]) fail('uso: block <n> "<motivo>" — travou por que?');
      const task = pick(rest[0]);
      task.status = STATUS_BY_CMD[cmd];
      task.updatedAt = now;
      if (rest[1]) task.note = rest[1];
      else if (cmd === 'done' || cmd === 'reset') delete task.note; // a nota era do andamento
      ensure();
    } else if (cmd === 'note') {
      if (!rest[0] || rest[1] == null) fail('uso: note <n> "<texto>"');
      const task = pick(rest[0]);
      if (rest[1]) task.note = rest[1]; else delete task.note;
      task.updatedAt = now;
      ensure();
    } else if (cmd === 'clear') {
      file.lists = file.lists.filter((l) => l.id !== listId);
      list = null;
    } else {
      fail('comando desconhecido: ' + cmd + ' (veja: help)');
    }
    shown = list;
  });
  print(shown);
}

try {
  main();
} catch (e) {
  console.error('flowforge tasks: ' + e.message);
  process.exit(e instanceof UsageError ? 2 : 1);
}
