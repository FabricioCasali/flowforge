#!/usr/bin/env node
// =============================================================================
// adapters/activity.js — a linha do tempo do que o agente FEZ (FF-035).
//
// Grava em <projeto>/.flowforge/activity.jsonl (contrato em docs/SCHEMA.md); o
// servidor vigia o arquivo e a lente Tarefas mostra ao vivo. Cada acao e carimbada
// com a tarefa `in_progress` de quem publica — e dai que saem "arquivos tocados por
// etapa", sem o agente declarar nada.
//
//   hook <harness>              le o payload do hook no STDIN e narra a acao
//   note "<texto>"              o proprio agente narra uma linha (decisao, achado, duvida)
//   install <harness> [--global]   liga o hook no settings do harness (deste projeto, ou global)
//   uninstall <harness> [--global]
//   show [n]                    imprime as ultimas acoes
//
// O `hook` NUNCA atrapalha o harness: projeto sem .flowforge/ -> sai calado; qualquer
// erro -> sai 0. Narrar e cortesia; travar a ferramenta do usuario por causa disso, nao.
// =============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../server/activity.js');
const T = require('../server/tasks.js');
const { findExistingDataDir, findDataDir, whoAmI } = require('./project.js');

const HARNESSES = { 'claude-code': () => require('./hooks/claude-code.js') };

function currentTask(dataDir, sourceId) {
  const list = T.readTasks(dataDir).lists.find((l) => l.id === sourceId);
  const task = list && list.tasks.find((t) => t.status === 'in_progress');
  return task ? task.id : undefined;
}

function readStdin() {
  return new Promise((resolve) => {
    let s = '';
    process.stdin.on('data', (d) => { s += d; });
    process.stdin.on('end', () => resolve(s));
    setTimeout(() => resolve(s), 3000).unref(); // hook sem stdin nao pode pendurar o harness
  });
}

async function hook(harnessName) {
  try {
    const harness = HARNESSES[harnessName] && HARNESSES[harnessName]();
    if (!harness) return;
    const payload = JSON.parse(await readStdin());
    const dataDir = findExistingDataDir(payload.cwd || process.cwd());
    if (!dataDir) return; // este projeto nao usa FlowForge: nada a narrar
    const projectDir = path.dirname(dataDir);
    const action = harness.map(payload, projectDir);
    if (!action) return;
    A.appendEvent(dataDir, {
      ts: Date.now(), source: harness.SOURCE.id, label: harness.SOURCE.label,
      ...action, task: currentTask(dataDir, harness.SOURCE.id),
    });
  } catch (e) { /* calado de proposito: ver o cabecalho */ }
}

function settingsFile(harnessName, global) {
  if (harnessName !== 'claude-code') throw new Error('harness sem instalador: ' + harnessName + ' (so claude-code por enquanto)');
  return global ? path.join(os.homedir(), '.claude', 'settings.json') : path.join(path.dirname(findDataDir(process.cwd())), '.claude', 'settings.local.json');
}
const MARK = 'adapters/activity.js';
const isOurs = (group) => (group.hooks || []).some((h) => String(h.command || '').replace(/\\/g, '/').includes(MARK));

function install(harnessName, { global, remove }) {
  const harness = HARNESSES[harnessName] && HARNESSES[harnessName]();
  if (!harness) throw new Error('harness desconhecido: ' + harnessName);
  const file = settingsFile(harnessName, global);
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error(file + ' nao e JSON valido; nao vou mexer'); }
  settings.hooks = settings.hooks || {};
  const command = 'node "' + __filename.replace(/\\/g, '/') + '" hook ' + harnessName;
  const entries = harness.settingsEntries(command);
  for (const ev of harness.EVENTS) {
    const kept = (settings.hooks[ev] || []).filter((g) => !isOurs(g)); // reinstalar nao duplica
    settings.hooks[ev] = remove ? kept : [...kept, entries[ev]];
    if (!settings.hooks[ev].length) delete settings.hooks[ev];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  console.log((remove ? 'hook removido de ' : 'hook instalado em ') + file);
  if (!remove) console.log('vale a partir da PROXIMA sessao do harness aberta neste projeto.');
}

const ICON = { read: 'leu ', edit: 'edit', run: 'rod ', search: 'busc', web: 'web ', agent: 'agen', tool: 'tool', note: 'nota', prompt: '>>> ', stop: '--- ' };
function show(n) {
  const events = A.readTail(findDataDir(process.cwd()), n);
  if (!events.length) { console.log('(sem atividade registrada)'); return; }
  for (const e of events) {
    console.log(new Date(e.ts).toLocaleTimeString('pt-BR') + '  ' + (ICON[e.kind] || e.kind) + '  ' + e.summary + (e.task ? '  [' + e.task + ']' : '') + (e.failed ? '  FALHOU' : ''));
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const args = argv.filter((a) => !a.startsWith('--'));
  const cmd = args[0];

  if (cmd === 'hook') return hook(args[1]);
  if (cmd === 'install' || cmd === 'uninstall') return install(args[1], { global: flags.has('--global'), remove: cmd === 'uninstall' });
  if (cmd === 'show') return show(Number(args[1]) || 30);
  if (cmd === 'note') {
    if (!args[1]) throw new Error('uso: note "<texto>"');
    const who = whoAmI();
    const dataDir = findDataDir(process.cwd());
    const ev = A.appendEvent(dataDir, { ts: Date.now(), source: who.id, label: who.label, kind: 'note', summary: args[1], task: currentTask(dataDir, who.id) });
    console.log('nota: ' + ev.summary + (ev.task ? '  [' + ev.task + ']' : ''));
    return;
  }
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').filter((l) => l.startsWith('//')).slice(1, -1).map((l) => l.slice(3)).join('\n'));
}

main().catch((e) => { console.error('flowforge activity: ' + e.message); process.exit(process.argv[2] === 'hook' ? 0 : 1); });
