#!/usr/bin/env node
// =============================================================================
// verifica-live.mjs — a prova da ponte viva (adapters/live.js).
//
// A ponte nao chama harness: ela IMPRIME o pedido (e o harness que vigia o stdout
// acorda a sessao aberta) e espera o `live.js done`. Aqui o teste faz o papel da
// sessao: le a linha, grava o reply.json, roda o `done`. Confere:
//
//   1. registra, e avisa "pronto" no stdout
//   2. o Analisar vira UMA linha curta, com o requestId logo no comeco
//   3. `done` aplica o reply.json, poe a fala no chat e solta a trava
//   4. `done --message` responde sem reply.json; `done --failed` vira failed
//   5. `done` de requestId desconhecido falha sem derrubar a ponte
//   6. nota comprida nao estoura a linha
//
// Uso: node scripts/verifica-live.mjs      (exit 1 se algo falhar)
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
const LIVE = path.join(ROOT, 'adapters', 'live.js');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-live-'));
const dataDir = path.join(tempRoot, 'projeto', '.flowforge');
fs.mkdirSync(dataDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function until(pred, what, timeout = 6000) {
  const t0 = Date.now();
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('timeout esperando ' + what);
    await sleep(40);
  }
}

async function main() {
  const port = await freePort();
  const url = `ws://127.0.0.1:${port}/agent`;
  const server = spawn(process.execPath, ['server/index.js', '--port', String(port), '--data-dir', dataDir], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  server.stdout.on('data', (c) => { out += c; });
  const casos = [];
  const ok = (nome, cond) => casos.push([nome, !!cond]);
  let bridge = null;

  try {
    await until(() => out.includes('FlowForge server em'), 'servidor');

    bridge = spawn(process.execPath, [LIVE, '--url', url, '--label', 'Sessao de teste'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = [];
    let buf = '';
    bridge.stdout.on('data', (c) => { buf += c; const parts = buf.split('\n'); buf = parts.pop(); lines.push(...parts.filter(Boolean)); });
    const done = (args) => spawnSync(process.execPath, [LIVE, 'done', ...args, '--url', url], { encoding: 'utf8' });

    // ---- 1. registro ----
    await until(() => lines.some((l) => l.startsWith('FLOWFORGE pronto')), 'linha "pronto"');
    const browser = new WebSocket(`ws://127.0.0.1:${port}/ws?session=viva`);
    let last = null;
    let agente = null;
    browser.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'state') { last = m; if (m.agentOnline) agente = m.agentLabel; }
      if (m.type === 'agent' && m.online) agente = m.label;
    });
    await until(() => last && agente, 'browser ver o agente');
    ok('a ponte registra com o rotulo pedido e avisa "pronto" no stdout', agente === 'Sessao de teste');

    // ---- 2 e 3. analisar -> linha -> reply.json -> done ----
    const sessDir = path.join(dataDir, 'viva');
    const pedir = async (note) => {
      const n = lines.length;
      browser.send(JSON.stringify({ type: 'analyze', note }));
      const line = await until(() => lines.slice(n).find((l) => l.startsWith('FLOWFORGE analisar ')), 'linha do pedido');
      await until(() => last.busy, 'trava');
      return line;
    };
    const rev0 = last.workspace.rev;
    const line = await pedir('primeiro pedido');
    const m = line.match(/^FLOWFORGE analisar ([0-9a-f-]{36}) sessao=(\S+) dir=(\S+) nota=(".*")$/);
    ok('o pedido vira UMA linha: requestId primeiro, depois sessao, dir e nota', m && m[2] === 'viva' && JSON.parse(m[4]) === 'primeiro pedido'
      && path.resolve(m[3]) === path.resolve(sessDir));
    ok('a linha e curta (o harness corta evento comprido)', line.length < 400);

    fs.writeFileSync(path.join(m[3], 'reply.json'), JSON.stringify({
      model: 'mind', message: 'Respondi da sessao viva.',
      addNodes: [{ id: 'v1', label: 'ideia da sessao viva' }],
    }));
    const r1 = done([m[1]]);
    ok('done responde "concluido" e sai 0', r1.status === 0 && /concluido/.test(r1.stdout));
    await until(() => !last.busy && last.workspace.rev === rev0 + 1, 'canvas destravado');
    ok('done aplica o reply.json: no novo no canvas, rev+1, trava solta', last.workspace.mind.nodes.some((n) => n.id === 'v1') && last.workspace.updatedBy === 'agent');
    ok('a message vira a fala do agente no chat', last.thread.messages.at(-1).author === 'agent' && last.thread.messages.at(-1).text === 'Respondi da sessao viva.');
    ok('o reply.json e consumido', !fs.existsSync(path.join(sessDir, 'reply.json')));

    // ---- 4. sem reply.json ----
    const l2 = await pedir('so conversa');
    const id2 = l2.split(' ')[2];
    done([id2, '--message', 'Resposta so de texto.']);
    await until(() => !last.busy && last.thread.messages.at(-1).text === 'Resposta so de texto.', 'resposta por --message');
    ok('done --message responde sem reply.json e sem mexer no desenho', last.workspace.rev === rev0 + 1);

    const l3 = await pedir('vai falhar');
    const r3 = done([l3.split(' ')[2], '--failed', 'nao consegui ler o repositorio']);
    await until(() => !last.busy && last.thread.messages.some((t) => t.author === 'system' && /nao consegui ler/.test(t.text)), 'falha no chat');
    ok('done --failed vira failed: motivo no chat, trava solta, exit 1', r3.status === 1);

    // ---- 5. requestId desconhecido ----
    const r4 = done(['00000000-0000-4000-8000-000000000000']);
    ok('done de requestId desconhecido falha com mensagem clara', r4.status === 1 && /desconhecido/.test(r4.stdout + r4.stderr));
    ok('e a ponte continua viva depois disso', bridge.exitCode === null);

    // ---- 6. nota comprida ----
    const l5 = await pedir('palavra '.repeat(200));
    ok('nota comprida e cortada na linha (a inteira fica no thread.json)', l5.length < 500 && /inteira no thread\.json/.test(l5)
      && last.thread.messages.some((t) => t.author === 'user' && t.text.length > 1000));
    done([l5.split(' ')[2], '--message', 'ok']);
    await until(() => !last.busy, 'ultima trava');

    browser.close();
  } finally {
    if (bridge) bridge.kill();
    server.kill();
    await sleep(300);
    try { fs.unlinkSync(path.join(os.homedir(), '.flowforge', 'live-' + port + '.json')); } catch (e) { /* a ponte ja limpou */ }
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
