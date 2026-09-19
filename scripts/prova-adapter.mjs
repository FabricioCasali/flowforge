#!/usr/bin/env node
// =============================================================================
// prova-adapter.mjs — o loop vivo ponta a ponta com um harness DE VERDADE.
//
// O verifica-adapter.mjs usa driver falso e roda em CI. Este chama o CLI real
// (gasta token, exige login) e e a prova do Definition of Done: clicar Analisar,
// o harness editar o arquivo, o requestId concluir e o canvas receber o estado.
//
// Isolado: servidor em porta livre e projeto temporario — nao toca no .flowforge/
// de ninguem. Faz DOIS pedidos, pra provar tambem a retomada da conversa.
//
// Uso: node scripts/prova-adapter.mjs <claude-code|opencode|codex> [--model m]
// =============================================================================

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const driverName = process.argv[2];
const modelIdx = process.argv.indexOf('--model');
const model = modelIdx > 0 ? process.argv[modelIdx + 1] : undefined;
if (!['claude-code', 'opencode', 'codex'].includes(driverName)) {
  console.error('uso: node scripts/prova-adapter.mjs <claude-code|opencode|codex> [--model m]');
  process.exit(2);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-prova-'));
const projectPath = path.join(tempRoot, 'projeto');
const sessionDir = path.join(projectPath, '.flowforge', 'prova');
fs.mkdirSync(sessionDir, { recursive: true });
fs.writeFileSync(path.join(projectPath, 'README.md'), '# Projeto de prova\n\nUma padaria que quer vender pela internet.\n');

const vazio = (type) => ({ type, title: 'Padaria online', rev: 0, updatedBy: 'user', lanes: [], nodes: [], edges: [] });
const idea = (id, label, extra = {}) => ({ id, label, kind: 'idea', status: 'proposed', comments: [], ...extra });
fs.writeFileSync(path.join(sessionDir, 'workspace.json'), JSON.stringify({
  process: vazio('flowchart'), state: vazio('flowchart'), er: vazio('er'),
  mind: {
    ...vazio('mindmap'), rev: 1,
    nodes: [
      idea('m1', 'Padaria online'),
      idea('m2', 'Entrega propria de moto'),
      idea('m3', 'So retirada na loja', {
        status: 'questioned',
        comments: [{ author: 'user', kind: 'question', text: 'isso nao mata a ideia de vender online?', ts: Date.now() }],
      }),
    ],
    edges: [
      { id: 'e1', source: 'm1', target: 'm2', label: '', status: 'proposed' },
      { id: 'e2', source: 'm1', target: 'm3', label: '', status: 'proposed' },
    ],
  },
  seq: { participants: [], messages: [] }, rev: 1, updatedBy: 'user',
}, null, 2));
fs.writeFileSync(path.join(sessionDir, 'thread.json'), JSON.stringify({ messages: [] }));
// PROVA_WORKSPACE=<workspace.json> + PROVA_NOTE='...': mede com um desenho real (copia; o original nao e tocado)
if (process.env.PROVA_WORKSPACE) fs.copyFileSync(process.env.PROVA_WORKSPACE, path.join(sessionDir, 'workspace.json'));

// o id de conversa desta prova nao pode ir pro estado real do usuario
process.env.FLOWFORGE_ADAPTER_STATE = path.join(tempRoot, 'adapter-state.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function main() {
  const port = await freePort();
  const server = spawn(process.execPath, ['server/index.js', '--port', String(port), '--data-dir', path.join(projectPath, '.flowforge')], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  server.stdout.on('data', (c) => { out += c; });
  for (let i = 0; i < 50 && !out.includes('FlowForge server em'); i++) await sleep(100);

  const { startAdapter } = require('../adapters/core.js');
  const adapter = startAdapter(require(`../adapters/drivers/${driverName}.js`), {
    url: `ws://127.0.0.1:${port}/agent`, model,
  });

  const browser = new WebSocket(`ws://127.0.0.1:${port}/ws?session=prova`);
  let last = null;
  let agente = null; // a presenca chega em `state` (ao abrir) OU em `agent` (registro depois)
  browser.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'state') { last = m; if (m.agentOnline) agente = m.agentLabel; }
    if (m.type === 'agent' && m.online) agente = m.label;
  });
  await new Promise((r) => browser.once('open', r));
  for (let i = 0; i < 50 && !(last && agente); i++) await sleep(100);
  if (!last || !agente) throw new Error('adapter nao registrou');
  console.log('canvas ve o agente:', agente);

  let falhas = 0;
  const pedidos = process.env.PROVA_NOTE ? [process.env.PROVA_NOTE] : [
    'Responda a pergunta que deixei no no questionado e proponha no mapa uma alternativa.',
    'Qual foi a alternativa que voce propos no pedido anterior? Responda so no thread, sem mexer no mapa.',
  ];
  for (const [i, note] of pedidos.entries()) {
    const revAntes = last.workspace.rev;
    const msgsAntes = last.thread.messages.length;
    const t0 = Date.now();
    browser.send(JSON.stringify({ type: 'analyze', note }));
    await sleep(500);
    while (last.busy || last.thread.messages.length === msgsAntes) {
      if (Date.now() - t0 > 12 * 60 * 1000) throw new Error('pedido nao terminou em 12 min');
      await sleep(500);
    }
    const resposta = last.thread.messages[last.thread.messages.length - 1];
    const falhou = resposta.author !== 'agent';
    if (falhou) falhas++;
    console.log(`\n--- pedido ${i + 1} (${Math.round((Date.now() - t0) / 1000)}s) ${falhou ? 'FALHOU' : 'ok'} ---`);
    console.log('rev:', revAntes, '->', last.workspace.rev, '| nos no mapa:', last.workspace.mind.nodes.length, '| aprovados:', last.workspace.mind.nodes.filter((n) => n.status === 'approved').length, '| busy:', last.busy);
    console.log(resposta.author + ':', resposta.text.slice(0, 700));
  }
  const comentarios = last.workspace.mind.nodes.flatMap((n) => n.comments.filter((c) => c.author === 'agent').map((c) => n.id + ': ' + c.text.slice(0, 160)));
  console.log('\ncomentarios do agente nos nos:\n' + (comentarios.join('\n') || '(nenhum)'));

  browser.close(); adapter.stop(); server.kill();
  await sleep(300);
  fs.rmSync(tempRoot, { recursive: true, force: true });
  console.log(falhas ? `\nPROVA: FALHA (${falhas})` : '\nPROVA: OK');
  process.exit(falhas ? 1 : 0);
}

main().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
