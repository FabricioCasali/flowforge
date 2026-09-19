#!/usr/bin/env node
// =============================================================================
// verifica-tasks.mjs — a prova das tarefas ao vivo (FF-034).
//
// O caminho inteiro, com as pecas de verdade: o comando que o agente chama
// (adapters/tasks.js) grava o <data-dir>/tasks.json, o servidor vigia a raiz e
// empurra `{type:'tasks'}` pra todo browser. Confere:
//
//   1. browser que conecta recebe as tarefas na hora (mesmo sem arquivo)
//   2. cada comando do agente chega ao browser, em QUALQUER sessao (e por projeto)
//   3. dois publicadores nao pisam um no outro, nem escrevendo ao mesmo tempo
//   4. as tarefas NAO tocam no workspace.json (rev do desenho intacto)
//   5. erro de uso nao deixa trava orfa, e arquivo torto escrito a mao nao derruba nada
//
// Uso: node scripts/verifica-tasks.mjs      (exit 1 se algo falhar)
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-tasks-'));
const projectPath = path.join(tempRoot, 'projeto');
const dataDir = path.join(projectPath, '.flowforge');
fs.mkdirSync(path.join(projectPath, 'src', 'fundo'), { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLI = path.join(ROOT, 'adapters', 'tasks.js');
// ambiente limpo: o palpite de "quem sou eu" nao pode depender de onde o teste roda
const envLimpo = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|OPENCODE|CODEX|FLOWFORGE_TASKS)/.test(k)));
const tasks = (args, { cwd = projectPath, env = {} } = {}) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...envLimpo, ...env }, encoding: 'utf8' });

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function openBrowser(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.tasks = null;
    ws.state = null;
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'tasks') ws.tasks = m.tasks;
      if (m.type === 'state') ws.state = m;
    });
    ws.until = async (pred, what, timeout = 5000) => {
      const t0 = Date.now();
      while (!(ws.tasks && pred(ws.tasks))) {
        if (Date.now() - t0 > timeout) throw new Error('timeout esperando ' + what + ' — ultimo: ' + JSON.stringify(ws.tasks));
        await sleep(40);
      }
      return ws.tasks;
    };
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

async function main() {
  const port = await freePort();
  const server = spawn(process.execPath, ['server/index.js', '--port', String(port), '--data-dir', dataDir], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  server.stdout.on('data', (c) => { out += c; });
  server.stderr.on('data', (c) => { out += c; });
  const casos = [];
  const ok = (nome, cond) => casos.push([nome, !!cond]);

  try {
    for (let i = 0; i < 50 && !out.includes('FlowForge server em'); i++) await sleep(100);
    assert.ok(out.includes('FlowForge server em'), 'servidor nao subiu:\n' + out);

    // ---- 1. conexao ----
    const a = await openBrowser(`ws://127.0.0.1:${port}/ws?session=desenho-a`);
    const b = await openBrowser(`ws://127.0.0.1:${port}/ws?session=desenho-b`);
    await a.until(() => true, 'tarefas iniciais');
    ok('browser recebe as tarefas ao conectar, mesmo sem arquivo', a.tasks.rev === 0 && a.tasks.lists.length === 0);
    for (let i = 0; i < 50 && !a.state; i++) await sleep(40);
    const revDesenho = a.state.workspace.rev;

    // ---- 2. o agente publica, de uma SUBPASTA do projeto ----
    const plan = tasks(['plan', 'Migrar o login', 'ler o codigo', 'escrever o teste', 'trocar a lib'], { cwd: path.join(projectPath, 'src', 'fundo'), env: { CLAUDECODE: '1' } });
    ok('plan roda e acha o .flowforge subindo da subpasta', plan.status === 0 && fs.existsSync(path.join(dataDir, 'tasks.json')));
    const t1 = await a.until((t) => t.lists.length === 1, 'plano no browser A');
    ok('plano chega ao browser com publicador, objetivo e 3 pendentes', t1.lists[0].id === 'claude-code' && t1.lists[0].label === 'Claude Code'
      && t1.lists[0].title === 'Migrar o login' && t1.lists[0].tasks.every((t) => t.status === 'pending') && t1.lists[0].tasks.length === 3);
    await b.until((t) => t.lists.length === 1, 'plano no browser B');
    ok('tarefas sao do PROJETO: chegam tambem a outra sessao de desenho', b.tasks.lists[0].title === 'Migrar o login');

    tasks(['start', '1', 'lendo auth.ts'], { env: { CLAUDECODE: '1' } });
    const t2 = await a.until((t) => t.lists[0]?.tasks[0].status === 'in_progress', 'start');
    ok('start marca em andamento com a nota', t2.lists[0].tasks[0].note === 'lendo auth.ts');

    tasks(['done', '1'], { env: { CLAUDECODE: '1' } });
    tasks(['block', 't2', 'falta decidir o framework'], { env: { CLAUDECODE: '1' } });
    const t3 = await a.until((t) => t.lists[0]?.tasks[1].status === 'blocked', 'done + block');
    ok('done conclui e limpa a nota de andamento', t3.lists[0].tasks[0].status === 'completed' && t3.lists[0].tasks[0].note === undefined);
    ok('block aceita o id da tarefa e guarda o motivo', t3.lists[0].tasks[1].note === 'falta decidir o framework');

    tasks(['add', 'avisar o time'], { env: { CLAUDECODE: '1' } });
    const t4 = await a.until((t) => t.lists[0]?.tasks.length === 4, 'add');
    ok('add acrescenta no fim com id novo', t4.lists[0].tasks[3].id === 't4' && t4.lists[0].tasks[3].status === 'pending');
    ok('o rev do tasks.json sobe a cada escrita', t4.rev === 5);

    // ---- 3. segundo publicador, e escrita simultanea ----
    tasks(['plan', 'Revisar o PR', 'ler o diff'], { env: { CODEX_THREAD_ID: 'x' } });
    const t5 = await a.until((t) => t.lists.length === 2, 'segunda lista');
    ok('segundo harness ganha lista propria; a primeira fica intacta', t5.lists[1].id === 'codex' && t5.lists[0].tasks.length === 4);

    const N = 12;
    await Promise.all(Array.from({ length: N }, (_, i) => new Promise((res) => {
      const p = spawn(process.execPath, [CLI, 'add', 'paralela ' + i, '--list', i % 2 ? 'par-a' : 'par-b'], { cwd: projectPath, env: envLimpo });
      p.on('close', res);
    })));
    const t6 = await a.until((t) => t.lists.filter((l) => l.id.startsWith('par-')).reduce((s, l) => s + l.tasks.length, 0) === N, N + ' escritas simultaneas', 8000);
    ok(N + ' escritas simultaneas: nenhuma se perde (trava do arquivo)', t6.lists.length === 4);
    ok('nenhuma trava ou temporario sobra na raiz', !fs.readdirSync(dataDir).some((f) => /\.(lock|tmp)$/.test(f)));

    // ---- 4. nao toca no desenho ----
    const ws = JSON.parse(fs.readFileSync(path.join(dataDir, 'desenho-a', 'workspace.json'), 'utf8'));
    ok('as tarefas NAO sobem o rev do workspace', ws.rev === revDesenho && !('tasks' in ws));
    const sessions = await (await fetch(`http://127.0.0.1:${port}/api/sessions`)).json();
    ok('tasks.json na raiz nao vira sessao', !sessions.sessions.some((s) => /tasks/.test(s)));

    // ---- 5. erros ----
    const ruim = tasks(['start', '99'], { env: { CLAUDECODE: '1' } });
    ok('tarefa inexistente: exit 2, mensagem clara e SEM trava orfa', ruim.status === 2 && /nao existe/.test(ruim.stderr) && !fs.existsSync(path.join(dataDir, 'tasks.json.lock')));
    ok('block sem motivo e recusado', tasks(['block', '1'], { env: { CLAUDECODE: '1' } }).status === 2);

    fs.writeFileSync(path.join(dataDir, 'tasks.json'), JSON.stringify({ rev: 'x', lists: [{ id: 'mao', tasks: [{ title: 'so titulo', status: 'inventado' }, 7] }, { semId: true }] }));
    const t7 = await a.until((t) => t.lists.length === 1 && t.lists[0].id === 'mao', 'arquivo escrito a mao');
    ok('arquivo torto escrito a mao e normalizado, nao derruba o canvas', t7.rev === 0 && t7.lists[0].label === 'mao'
      && t7.lists[0].tasks.length === 1 && t7.lists[0].tasks[0].status === 'pending' && t7.lists[0].tasks[0].id === 't1');

    tasks(['clear', '--list', 'mao']);
    const t8 = await a.until((t) => t.lists.length === 0, 'clear');
    ok('clear tira a lista do canvas', t8.lists.length === 0);

    a.close(); b.close();
  } finally {
    server.kill();
    await sleep(200);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  let falhas = 0;
  for (const [nome, passou] of casos) {
    console.log((passou ? '   ok    ' : '   FALHA ') + nome);
    if (!passou) falhas++;
  }
  console.log(falhas ? `\nVEREDITO: FALHA — ${falhas} de ${casos.length}` : `\nVEREDITO: OK — ${casos.length} casos`);
  process.exit(falhas ? 1 : 0);
}

main().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
