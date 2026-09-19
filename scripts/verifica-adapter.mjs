#!/usr/bin/env node
// =============================================================================
// verifica-adapter.mjs — a prova do nucleo dos adapters (adapters/core.js).
//
// O verifica-agent.mjs prova o SERVIDOR com um adapter escrito a mao. Este prova
// o OUTRO lado: sobe o servidor de verdade, liga o nucleo real com um driver
// FALSO (nenhum harness e chamado, nenhum token e gasto) e clica "Analisar" como
// o browser faz. Confere o que o protocolo exige do adapter:
//
//   1. registra e aparece na barra com o rotulo do driver
//   2. harness que esquece o rev e o thread -> o nucleo sela os dois arquivos
//   3. harness que falha -> `failed`, trava solta, aviso no thread
//   4. queda no meio do pedido -> reenvio do MESMO requestId nao roda duas vezes
//   5. pedido mais longo que o prazo da trava -> `progress` segura a conexao
//
// Uso: node scripts/verifica-adapter.mjs      (exit 1 se algo falhar)
// =============================================================================

import assert from 'node:assert/strict';
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
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-adapter-'));
const dataDir = path.join(tempRoot, 'projeto', '.flowforge');
fs.mkdirSync(dataDir, { recursive: true });
// o estado de retomada vai pro HOME; o teste nao pode sujar o do usuario
process.env.FLOWFORGE_ADAPTER_STATE = path.join(tempRoot, 'adapter-state.json');
const { startAdapter } = require('../adapters/core.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Browser de mentira: guarda tudo que chega e deixa esperar por um predicado. */
function openBrowser(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const seen = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      seen.push(msg);
      for (const w of waiters.slice()) {
        if (!w.predicate(msg)) continue;
        waiters.splice(waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    });
    ws.wait = (predicate, timeout = 8000, what = 'mensagem') => {
      const hit = seen.find(predicate);
      if (hit) return Promise.resolve(hit);
      return new Promise((res, rej) => {
        const w = { predicate, resolve: res };
        w.timer = setTimeout(() => rej(new Error('timeout esperando ' + what)), timeout);
        waiters.push(w);
      });
    };
    ws.forget = () => { seen.length = 0; };
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const inboxTypes = (slug) => fs.readFileSync(path.join(dataDir, slug, 'inbox.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l).type);

async function main() {
  const port = await freePort();
  const server = spawn(process.execPath, ['server/index.js', '--port', String(port), '--data-dir', dataDir], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FLOWFORGE_BUSY_TIMEOUT_MS: '1500' },
  });
  let out = '';
  server.stdout.on('data', (c) => { out += c; });
  server.stderr.on('data', (c) => { out += c; });
  const casos = [];
  const ok = (nome, cond) => { casos.push([nome, !!cond]); };
  let adapter = null;

  try {
    for (let i = 0; i < 50 && !out.includes('FlowForge server em'); i++) await sleep(100);
    assert.ok(out.includes('FlowForge server em'), 'servidor nao subiu:\n' + out);

    // o driver falso: o comportamento de cada caso e trocado por esta variavel
    let behavior = async () => ({ ok: true, text: '' });
    const runs = [];
    const driver = {
      id: 'falso', label: 'Harness falso',
      async run(job) { runs.push(job); return behavior(job); },
    };
    adapter = startAdapter(driver, { url: `ws://127.0.0.1:${port}/agent`, progressMs: 400, log: () => {} });

    // ---- 1. registro ----
    const b1 = await openBrowser(`ws://127.0.0.1:${port}/ws?session=selo`);
    const online = await b1.wait((m) => (m.type === 'agent' && m.online) || (m.type === 'state' && m.agentOnline), 5000, 'adapter online');
    ok('adapter registra e o canvas mostra o rotulo do driver', (online.label || online.agentLabel) === 'Harness falso');

    // ---- 2. harness desleixado: mexe no workspace, esquece rev e thread ----
    behavior = async (job) => {
      const w = readJson(job.evt.workspacePath);
      w.mind.nodes.push({ id: 'm1', label: 'ideia do agente', kind: 'idea', status: 'proposed', comments: [] });
      fs.writeFileSync(job.evt.workspacePath, JSON.stringify(w)); // SEM subir o rev
      return { ok: true, text: 'Acrescentei uma ideia.', resumeId: 'conversa-1' };
    };
    const revAntes = readJson(path.join(dataDir, 'selo', 'workspace.json')).rev;
    b1.forget();
    b1.send(JSON.stringify({ type: 'analyze', note: 'primeiro pedido' }));
    await b1.wait((m) => m.type === 'busy' && m.busy, 5000, 'trava');
    const solto = await b1.wait((m) => m.type === 'state' && !m.busy && m.workspace.rev > revAntes, 8000, 'estado final');
    ok('o pedido chega ao driver com o prompt e o cwd do projeto', runs[0].prompt.includes('primeiro pedido') && runs[0].cwd === path.join(tempRoot, 'projeto'));
    ok('primeiro pedido nao tenta retomar conversa', runs[0].resumeId === null);
    ok('rev esquecido pelo harness e selado em rev+1 com updatedBy agent', solto.workspace.rev === revAntes + 1 && solto.workspace.updatedBy === 'agent');
    ok('a mudanca do harness chega ao canvas', solto.workspace.mind.nodes.some((n) => n.id === 'm1'));
    ok('fala final do harness vira mensagem do agente no thread', solto.thread.messages.some((m) => m.author === 'agent' && m.text === 'Acrescentei uma ideia.'));
    ok('inbox registra accepted e completed', inboxTypes('selo').includes('accepted') && inboxTypes('selo').includes('completed'));

    // ---- 2b. segundo pedido retoma a conversa, e harness caprichoso nao e duplicado ----
    behavior = async (job) => {
      const w = readJson(job.evt.workspacePath);
      w.rev = job.evt.workspaceRev + 1; w.updatedBy = 'agent';
      fs.writeFileSync(job.evt.workspacePath, JSON.stringify(w));
      const t = readJson(job.evt.threadPath);
      t.messages.push({ author: 'agent', text: 'resposta escrita pelo harness', ts: Date.now() });
      fs.writeFileSync(job.evt.threadPath, JSON.stringify(t));
      return { ok: true, text: 'texto que NAO deve ir pro thread', resumeId: 'conversa-1' };
    };
    b1.forget();
    b1.send(JSON.stringify({ type: 'analyze', note: 'segundo pedido' }));
    const segundo = await b1.wait((m) => m.type === 'state' && !m.busy && m.workspace.rev === revAntes + 2, 8000, 'segundo estado');
    ok('segundo pedido retoma a conversa gravada', runs[1].resumeId === 'conversa-1');
    ok('harness que ja escreveu o thread nao ganha mensagem duplicada', segundo.thread.messages.filter((m) => m.author === 'agent').length === 2
      && !segundo.thread.messages.some((m) => /NAO deve ir/.test(m.text)));

    // ---- 2c. o caminho rapido: reply.json em vez de editar o workspace ----
    const dirSelo = path.join(dataDir, 'selo');
    behavior = async (job) => {
      // o no m1 existe (caso 2). Cria m2 ligado a ele, questiona m1 e erra um id de proposito.
      fs.writeFileSync(path.join(dirSelo, 'reply.json'), JSON.stringify({
        model: 'mind',
        message: 'Questionei a ideia e propus uma alternativa.',
        update: [{ id: 'm1', status: 'questioned', comment: 'e se a fila cair?', commentKind: 'question' }, { id: 'nao-existe', status: 'approved' }],
        addNodes: [{ id: 'm2', label: 'alternativa', comment: 'mais barata' }],
        addEdges: [{ source: 'm1', target: 'm2' }],
      }));
      return { ok: true, text: 'fala final que NAO deve duplicar a mensagem', resumeId: 'conversa-1' };
    };
    b1.forget();
    b1.send(JSON.stringify({ type: 'analyze', note: 'terceiro pedido' }));
    const rapido = await b1.wait((m) => m.type === 'state' && !m.busy && m.workspace.rev === revAntes + 3, 8000, 'estado do reply.json');
    const nm1 = rapido.workspace.mind.nodes.find((n) => n.id === 'm1');
    const nm2 = rapido.workspace.mind.nodes.find((n) => n.id === 'm2');
    ok('reply.json: update muda status e acrescenta comentario do agente', nm1.status === 'questioned'
      && nm1.comments.some((c) => c.author === 'agent' && c.kind === 'question' && c.text === 'e se a fila cair?'));
    ok('reply.json: addNodes cria no SEM x/y, com kind do modelo e comentario', nm2 && nm2.kind === 'idea' && nm2.x === undefined && nm2.comments[0].text === 'mais barata');
    ok('reply.json: addEdges liga os nos com id gerado', rapido.workspace.mind.edges.some((e) => e.source === 'm1' && e.target === 'm2' && e.id));
    ok('reply.json: rev do topo E do modelo sobem, autoria agent', rapido.workspace.mind.rev === revAntes + 3 && rapido.workspace.mind.updatedBy === 'agent' && rapido.workspace.updatedBy === 'agent');
    const falas = rapido.thread.messages.filter((m) => m.author === 'agent');
    ok('reply.json: message vira a fala do agente, com o item pulado relatado, sem duplicar', falas.length === 3
      && /Questionei a ideia/.test(falas[2].text) && /nao-existe/.test(falas[2].text) && !rapido.thread.messages.some((m) => /NAO deve duplicar/.test(m.text)));
    ok('reply.json e consumido (nao sobra na pasta da sessao)', !fs.existsSync(path.join(dirSelo, 'reply.json')));

    behavior = async () => {
      fs.writeFileSync(path.join(dirSelo, 'reply.json'), JSON.stringify({ message: 'So conversa, sem mexer no desenho.' }));
      return { ok: true, text: '', resumeId: 'conversa-1' };
    };
    b1.forget();
    b1.send(JSON.stringify({ type: 'analyze', note: 'so conversa' }));
    const conversa = await b1.wait((m) => m.type === 'state' && !m.busy && m.thread.messages.some((t) => /So conversa/.test(t.text)), 8000, 'resposta so com message');
    ok('reply.json so com message responde sem subir o rev do desenho', conversa.workspace.rev === revAntes + 3);

    // ---- 3. falha ----
    behavior = async () => ({ ok: false, error: 'harness sem login' });
    b1.forget();
    b1.send(JSON.stringify({ type: 'analyze', note: 'vai falhar' }));
    const falhou = await b1.wait((m) => m.type === 'state' && !m.busy && m.thread.messages.some((t) => t.author === 'system' && /harness sem login/.test(t.text)), 8000, 'falha no thread');
    ok('falha do harness vira failed: trava solta e motivo no thread', !falhou.busy);
    ok('retomada que falha e tentada de novo sem conversa', runs.length === 6 && runs[4].resumeId === 'conversa-1' && runs[5].resumeId === null);

    // ---- 4. queda no meio + 5. progress segura pedido longo ----
    const b2 = await openBrowser(`ws://127.0.0.1:${port}/ws?session=queda`);
    await b2.wait((m) => m.type === 'state');
    let longRuns = 0;
    behavior = async (job) => {
      longRuns++;
      await sleep(3200); // mais que o dobro do prazo da trava (1500ms)
      const w = readJson(job.evt.workspacePath);
      w.rev = job.evt.workspaceRev + 1; w.updatedBy = 'agent';
      fs.writeFileSync(job.evt.workspacePath, JSON.stringify(w));
      return { ok: true, text: 'terminei o pedido longo' };
    };
    b2.forget();
    b2.send(JSON.stringify({ type: 'analyze', note: 'pedido longo' }));
    const fimLongo = await b2.wait((m) => m.type === 'state' && !m.busy && m.thread.messages.some((t) => t.text === 'terminei o pedido longo'), 9000, 'fim do pedido longo');
    ok('progress segura o pedido alem do prazo da trava', !fimLongo.thread.messages.some((t) => /tempo limite|desconectou/.test(t.text)));
    ok('pedido longo roda uma vez so', longRuns === 1);

    longRuns = 0;
    b2.forget();
    b2.send(JSON.stringify({ type: 'analyze', note: 'vai cair no meio' }));
    await b2.wait((m) => m.type === 'busy' && m.busy, 5000, 'trava do pedido que cai');
    await sleep(600);
    adapter.drop(); // queda de rede no meio do trabalho
    const fimQueda = await b2.wait((m) => m.type === 'state' && !m.busy && m.thread.messages.filter((t) => t.text === 'terminei o pedido longo').length === 2, 12000, 'fim depois da queda');
    ok('queda no meio: o reenvio do mesmo requestId NAO inicia segunda execucao', longRuns === 1);
    ok('queda no meio: o desfecho chega depois da reconexao e solta a trava', !fimQueda.busy);

    b1.close(); b2.close();
  } finally {
    if (adapter) adapter.stop();
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
