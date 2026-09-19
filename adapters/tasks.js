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
//   link  <n> <sessao>/<no>                       liga a tarefa a um no do desenho
//   unlink <n>                                    desfaz o elo
//   clear                                         tira a lista do canvas
//   show                                          imprime a lista
//
//   <n> e a posicao (1, 2, 3...) ou o id da tarefa.
//   --list <id>  --label <nome>  --data-dir <dir>
//   --node <sessao>/<no>   em `add` e `start`: ja liga a tarefa ao no do desenho.
//                          O no apontado por uma tarefa `in_progress` aparece VIVO
//                          no canvas daquela sessao (travado, se ela estiver
//                          `blocked`). Ex: start 2 --node arquitetura/n7
//
// O `plan` NAO tem sintaxe de elo. Foi avaliado marcar o no no proprio titulo
// ("escrever o teste @sessao/n7") e recusado: titulo de tarefa tem "@" e "/" de
// verdade ("revisar o handler @auth/login"), e a regra comeria pedaco de texto do
// usuario. Ligar depois custa uma chamada e nao tem ambiguidade nenhuma.
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
    else if (a === '--node') opts.node = argv[++i];
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
  list.tasks.forEach((t, i) => console.log('  ' + (i + 1) + '. ' + ICON[t.status] + ' ' + t.title
    + (t.note ? '  · ' + t.note : '') + (t.node ? '  -> ' + t.node.session + '/' + t.node.id : '')));
}

/**
 * "<sessao>/<no>" -> { session, id }. Validacao LEVE de proposito: so o formato.
 * Nao exige que a sessao ou o no existam — o agente pode ligar a tarefa a uma
 * etapa que ele ainda vai desenhar, e um id que nao existe simplesmente nao
 * acende nada no canvas. A sessao que falta vira AVISO no stdout, nao erro.
 */
function elo(ref) {
  const s = String(ref == null ? '' : ref).trim();
  const corte = s.indexOf('/');
  const session = corte < 0 ? '' : s.slice(0, corte).trim();
  const id = corte < 0 ? '' : s.slice(corte + 1).trim();
  if (!session || !id || id.includes('/')) fail('elo invalido: "' + s + '" — use <sessao>/<no>, ex: arquitetura/n7');
  return { session, id };
}

function main() {
  const { opts, cmd, rest } = parse(process.argv.slice(2));
  const who = whoAmI();
  const listId = opts.list || who.id;
  const label = opts.label || (opts.list ? opts.list : who.label);
  const dataDir = opts.dataDir ? path.resolve(opts.dataDir) : findDataDir(process.cwd());
  const now = Date.now();

  if (!cmd || cmd === 'help' || cmd === '--help') {
    // o cabecalho deste arquivo E a ajuda: vai do primeiro ao segundo separador
    // (sem isso, o help arrastava junto comentarios do meio do codigo)
    const linhas = fs.readFileSync(__filename, 'utf8').split(/\r?\n/).filter((l) => l.startsWith('//'));
    const fim = linhas.findIndex((l, i) => i > 0 && /^\/\/ =+$/.test(l));
    console.log(linhas.slice(1, fim < 0 ? -1 : fim).map((l) => l.slice(3)).join('\n'));
    return;
  }
  if (cmd === 'show') { print(T.readTasks(dataDir).lists.find((l) => l.id === listId)); return; }

  // O elo e resolvido FORA da trava: erro de formato tem de sair antes de abrir o
  // arquivo, e o aviso da sessao que falta e so uma olhada no disco.
  if (opts.node != null && cmd !== 'add' && cmd !== 'start') {
    fail('--node so vale em `add` e `start`; para ligar uma tarefa que ja existe use: link <n> <sessao>/<no>');
  }
  if (cmd === 'link' && !rest[1]) fail('uso: link <n> <sessao>/<no>');
  const noOpt = opts.node != null ? elo(opts.node) : null;
  const noLink = cmd === 'link' ? elo(rest[1]) : null;
  const alvo = noLink || noOpt;
  if (alvo && !fs.existsSync(path.join(dataDir, alvo.session))) {
    console.log('aviso: a sessao "' + alvo.session + '" ainda nao existe neste projeto — o elo fica gravado e acende quando o desenho existir');
  }

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
      list.tasks.push({ id: 't' + k, title: rest[0], status: 'pending', updatedAt: now, ...(noOpt ? { node: noOpt } : {}) });
    } else if (STATUS_BY_CMD[cmd]) {
      if (!rest[0]) fail('uso: ' + cmd + ' <n> ["nota"]');
      if (cmd === 'block' && !rest[1]) fail('uso: block <n> "<motivo>" — travou por que?');
      const task = pick(rest[0]);
      task.status = STATUS_BY_CMD[cmd];
      task.updatedAt = now;
      if (rest[1]) task.note = rest[1];
      else if (cmd === 'done' || cmd === 'reset') delete task.note; // a nota era do andamento
      // pegar a tarefa e dizer onde ela mora no desenho e o mesmo gesto: `start 2 --node <sessao>/<no>`
      if (cmd === 'start' && noOpt) task.node = noOpt;
      ensure();
    } else if (cmd === 'link' || cmd === 'unlink') {
      if (!rest[0]) fail('uso: ' + (cmd === 'link' ? 'link <n> <sessao>/<no>' : 'unlink <n>'));
      const task = pick(rest[0]);
      // o elo NAO mexe no status: ligar uma tarefa a um no nao e comecar a faze-la
      if (noLink) task.node = noLink; else delete task.node;
      task.updatedAt = now;
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
