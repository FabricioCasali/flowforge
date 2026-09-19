#!/usr/bin/env node
// Prova isolada do protocolo WS entre browser, servidor e adapter externo.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-agent-'));
const projectPath = path.join(tempRoot, 'projeto');
const dataDir = path.join(projectPath, '.flowforge');
fs.mkdirSync(dataDir, { recursive: true });
const sockets = new Set();

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    sockets.add(ws);
    ws._jsonQueue = [];
    ws._jsonWaiters = [];
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const index = ws._jsonWaiters.findIndex((waiter) => waiter.predicate(msg));
      if (index < 0) {
        ws._jsonQueue.push(msg);
        return;
      }
      const [waiter] = ws._jsonWaiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(msg);
    });
    ws.on('close', () => {
      sockets.delete(ws);
      for (const waiter of ws._jsonWaiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('WebSocket fechou antes da mensagem esperada'));
      }
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextJson(ws, predicate = () => true, timeout = 3000) {
  const queued = ws._jsonQueue.findIndex(predicate);
  if (queued >= 0) return Promise.resolve(ws._jsonQueue.splice(queued, 1)[0]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const index = ws._jsonWaiters.indexOf(waiter);
      if (index >= 0) ws._jsonWaiters.splice(index, 1);
      reject(new Error('Timeout esperando mensagem WebSocket'));
    }, timeout);
    const waiter = { predicate, resolve, reject, timer };
    ws._jsonWaiters.push(waiter);
  });
}

function send(ws, msg) { ws.send(JSON.stringify(msg)); }

async function assertNoJson(ws, predicate, timeout = 200) {
  try {
    const msg = await nextJson(ws, predicate, timeout);
    assert.fail('Mensagem inesperada: ' + JSON.stringify(msg));
  } catch (error) {
    if (error instanceof Error && error.message === 'Timeout esperando mensagem WebSocket') return;
    throw error;
  }
}

async function close(ws) {
  if (!ws || ws.readyState === WebSocket.CLOSED) return;
  const closed = new Promise((resolve) => ws.once('close', resolve));
  ws.close();
  await closed;
}

async function main() {
  const port = await freePort();
  const child = spawn(process.execPath, ['server/index.js', '--port', String(port), '--data-dir', dataDir], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FLOWFORGE_BUSY_TIMEOUT_MS: '1500' },
  });
  let serverOutput = '';
  let restartedChild = null;
  child.stdout.on('data', (chunk) => { serverOutput += chunk; });
  child.stderr.on('data', (chunk) => { serverOutput += chunk; });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Servidor nao iniciou\n' + serverOutput)), 5000);
      child.stdout.on('data', () => {
        if (!serverOutput.includes('FlowForge server em')) return;
        clearTimeout(timer);
        resolve();
      });
      child.once('exit', (code) => reject(new Error(`Servidor encerrou com ${code}\n${serverOutput}`)));
    });

    const browser = await open(`ws://127.0.0.1:${port}/ws?session=protocolo`);
    const initial = await nextJson(browser, (m) => m.type === 'state');
    assert.equal(initial.agentOnline, false);
    assert.equal(initial.agentLabel, null);

    // Renomear a sessao e UMA escrita e UM rev: o titulo mora no topo do workspace,
    // e nao dentro de cada modelo (antes eram um patch e um rev por lente com conteudo).
    const workspaceFile = path.join(dataDir, 'protocolo', 'workspace.json');
    const antesRename = JSON.parse(fs.readFileSync(workspaceFile, 'utf8'));
    const renomeado = nextJson(browser, (m) => m.type === 'state' && m.workspace.title === 'Sessao renomeada');
    send(browser, { type: 'rename', title: 'Sessao renomeada' });
    const depoisRename = await renomeado;
    assert.equal(depoisRename.workspace.rev, (antesRename.rev || 0) + 1, 'renomear deve custar exatamente um rev');
    assert.equal(depoisRename.workspace.process.title, antesRename.process.title,
      'renomear nao pode mexer no title de dentro do modelo');
    const renameNoDisco = JSON.parse(fs.readFileSync(workspaceFile, 'utf8'));
    assert.equal(renameNoDisco.title, 'Sessao renomeada', 'o titulo tem de chegar ao topo do arquivo');
    send(browser, { type: 'rename', title: '   ' });
    await assertNoJson(browser, (m) => m.type === 'state' && m.workspace.title !== 'Sessao renomeada');

    const adapter = await open(`ws://127.0.0.1:${port}/agent`);
    assert.deepEqual(await nextJson(adapter), { type: 'hello', protocol: 1 });
    const presence = nextJson(browser, (m) => m.type === 'agent' && m.online);
    send(adapter, { type: 'register', protocol: 1, adapterId: 'teste', label: 'Adapter de teste' });
    assert.equal((await presence).label, 'Adapter de teste');

    const stateProbe = await open(`ws://127.0.0.1:${port}/ws?session=protocolo`);
    const registeredState = await nextJson(stateProbe, (m) => m.type === 'state');
    assert.equal(registeredState.agentOnline, true);
    assert.equal(registeredState.agentLabel, 'Adapter de teste');
    await close(stateProbe);

    const second = await open(`ws://127.0.0.1:${port}/agent`);
    assert.deepEqual(await nextJson(second), { type: 'hello', protocol: 1 });
    send(second, { type: 'register', protocol: 1, adapterId: 'segundo', label: 'Segundo' });
    assert.match((await nextJson(second, (m) => m.type === 'error')).message, /adapter ativo/i);
    await close(second);

    const analyzeOnline = nextJson(adapter, (m) => m.type === 'analyze');
    const busyOnline = nextJson(browser, (m) => m.type === 'busy' && m.busy);
    send(browser, { type: 'analyze', note: 'pedido online' });
    const first = await analyzeOnline;
    await busyOnline;
    assert.equal(first.protocol, 1);
    assert.match(first.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(first.projectPath, projectPath);
    for (const field of ['session', 'note', 'at', 'workspacePath', 'workspaceRev', 'workspaceTitle', 'threadPath']) {
      assert.notEqual(first[field], undefined, `campo ausente: ${field}`);
    }
    const beforeForbidden = JSON.parse(fs.readFileSync(first.workspacePath, 'utf8'));
    const rejectedPatch = nextJson(browser, (m) => m.type === 'state' && m.busy
      && m.workspace.process.title === beforeForbidden.process.title);
    send(browser, {
      type: 'patch', lens: 'process',
      diagram: { ...beforeForbidden.process, title: 'Patch proibido durante busy' },
    });
    await rejectedPatch;
    assert.equal(JSON.parse(fs.readFileSync(first.workspacePath, 'utf8')).process.title, beforeForbidden.process.title,
      'servidor nao pode aceitar patch durante busy');
    // renomear tem a mesma trava do patch (lei 7): tambem e escrita de origem-usuario
    const rejectedRename = nextJson(browser, (m) => m.type === 'state' && m.busy
      && m.workspace.title === beforeForbidden.title);
    send(browser, { type: 'rename', title: 'Renomeado durante busy' });
    await rejectedRename;
    const duranteBusy = JSON.parse(fs.readFileSync(first.workspacePath, 'utf8'));
    assert.equal(duranteBusy.title, beforeForbidden.title, 'servidor nao pode renomear durante busy');
    assert.equal(duranteBusy.rev, beforeForbidden.rev, 'renomear recusado nao pode gastar rev');
    send(adapter, { type: 'accepted', requestId: first.requestId });
    const workspace = JSON.parse(fs.readFileSync(first.workspacePath, 'utf8'));
    workspace.rev += 1;
    workspace.updatedBy = 'agent';
    workspace.process.title = 'Atualizado pelo adapter';
    fs.writeFileSync(first.workspacePath, JSON.stringify(workspace, null, 2));
    const completedState = nextJson(browser, (m) => m.type === 'state'
      && m.workspace.rev === workspace.rev && !m.busy);
    send(adapter, { type: 'completed', requestId: first.requestId, message: 'ok' });
    const stateAfterCompleted = await completedState;
    assert.equal(stateAfterCompleted.workspace.process.title, 'Atualizado pelo adapter',
      'browser so pode destravar junto do workspace novo');

    const analyzeInterrupted = nextJson(adapter, (m) => m.type === 'analyze' && m.note === 'pedido interrompido');
    const busyInterrupted = nextJson(browser, (m) => m.type === 'busy' && m.busy);
    send(browser, { type: 'analyze', note: 'pedido interrompido' });
    const interrupted = await analyzeInterrupted;
    await busyInterrupted;
    const offlinePresence = nextJson(browser, (m) => m.type === 'agent' && !m.online);
    await close(adapter);
    await offlinePresence;
    await nextJson(browser, (m) => m.type === 'state' && m.busy
      && m.thread.messages.some((entry) => entry.text.includes('desconectou')));
    await assertNoJson(browser, (m) => (m.type === 'busy' || m.type === 'state') && !m.busy);
    send(browser, { type: 'analyze', note: 'pedido offline' });
    await nextJson(browser, (m) => m.type === 'state'
      && m.thread.messages.some((entry) => entry.author === 'system' && entry.text.includes('enfileirado')));
    fs.appendFileSync(path.join(dataDir, 'protocolo', 'inbox.jsonl'), '{linha-invalida\n');

    const replayAdapter = await open(`ws://127.0.0.1:${port}/agent`);
    assert.deepEqual(await nextJson(replayAdapter), { type: 'hello', protocol: 1 });
    const replayInterrupted = nextJson(replayAdapter, (m) => m.type === 'analyze' && m.note === 'pedido interrompido');
    send(replayAdapter, { type: 'register', protocol: 1, adapterId: 'replay', label: 'Replay' });
    const replayedInterrupted = await replayInterrupted;
    assert.equal(replayedInterrupted.requestId, interrupted.requestId, 'queda deve preservar o requestId no replay');
    assert(!replayAdapter._jsonQueue.some((m) => m.type === 'analyze' && m.requestId === first.requestId),
      'pedido completed nao pode ser reenviado');
    await assertNoJson(replayAdapter, (m) => m.type === 'analyze' && m.note === 'pedido offline');
    const workspaceBeforePending = JSON.parse(fs.readFileSync(replayedInterrupted.workspacePath, 'utf8'));
    workspaceBeforePending.rev += 1;
    workspaceBeforePending.updatedBy = 'agent';
    workspaceBeforePending.process.title = 'Rev atual antes do proximo pedido';
    fs.writeFileSync(replayedInterrupted.workspacePath, JSON.stringify(workspaceBeforePending, null, 2));
    const replayOffline = nextJson(replayAdapter, (m) => m.type === 'analyze' && m.note === 'pedido offline');
    send(replayAdapter, { type: 'completed', requestId: replayedInterrupted.requestId });
    const pending = await replayOffline;
    assert.notEqual(pending.requestId, first.requestId);
    assert.equal(pending.workspaceRev, workspaceBeforePending.rev,
      'pedido enfileirado deve carregar o rev existente no despacho');
    await nextJson(browser, (m) => m.type === 'state' && m.busy);
    const failedState = nextJson(browser, (m) => m.type === 'state' && !m.busy
      && m.thread.messages.some((entry) => entry.author === 'system' && entry.text.includes('falha controlada')));
    send(replayAdapter, { type: 'failed', requestId: pending.requestId, message: 'falha controlada' });
    await failedState;

    const analyzeTimeout = nextJson(replayAdapter, (m) => m.type === 'analyze' && m.note === 'pedido com timeout');
    send(browser, { type: 'analyze', note: 'pedido com timeout' });
    const timedOut = await analyzeTimeout;
    const timeoutState = nextJson(browser, (m) => m.type === 'state' && m.busy
      && m.thread.messages.some((entry) => entry.text.includes('tempo limite')),
    4000);
    const timeoutPresence = nextJson(browser, (m) => m.type === 'agent' && !m.online, 4000);
    await timeoutState;
    await timeoutPresence;

    const timeoutAdapter = await open(`ws://127.0.0.1:${port}/agent`);
    assert.deepEqual(await nextJson(timeoutAdapter), { type: 'hello', protocol: 1 });
    const timeoutReplay = nextJson(timeoutAdapter, (m) => m.type === 'analyze' && m.requestId === timedOut.requestId);
    send(timeoutAdapter, { type: 'register', protocol: 1, adapterId: 'timeout-replay', label: 'Timeout replay' });
    assert.equal((await timeoutReplay).requestId, timedOut.requestId,
      'timeout deve manter requestId e trava para replay seguro');
    const timeoutDone = nextJson(browser, (m) => m.type === 'state' && !m.busy
      && m.thread.messages.some((entry) => entry.text.includes('timeout encerrado')));
    send(timeoutAdapter, { type: 'failed', requestId: timedOut.requestId, message: 'timeout encerrado' });
    await timeoutDone;

    await close(timeoutAdapter);

    const restartAdapter = await open(`ws://127.0.0.1:${port}/agent`);
    assert.deepEqual(await nextJson(restartAdapter), { type: 'hello', protocol: 1 });
    send(restartAdapter, { type: 'register', protocol: 1, adapterId: 'antes-restart', label: 'Antes restart' });
    await nextJson(browser, (m) => m.type === 'agent' && m.online && m.label === 'Antes restart');
    const analyzeRestart = nextJson(restartAdapter, (m) => m.type === 'analyze' && m.note === 'pedido durante restart');
    send(browser, { type: 'analyze', note: 'pedido durante restart' });
    const restartRequest = await analyzeRestart;

    const firstExit = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await firstExit;

    restartedChild = spawn(process.execPath, ['server/index.js', '--port', String(port), '--data-dir', dataDir], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FLOWFORGE_BUSY_TIMEOUT_MS: '1500' },
    });
    let restartOutput = '';
    restartedChild.stdout.on('data', (chunk) => { restartOutput += chunk; });
    restartedChild.stderr.on('data', (chunk) => { restartOutput += chunk; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Servidor nao reiniciou\n' + restartOutput)), 5000);
      restartedChild.stdout.on('data', () => {
        if (!restartOutput.includes('FlowForge server em')) return;
        clearTimeout(timer);
        resolve();
      });
      restartedChild.once('exit', (code) => reject(new Error(`Servidor reiniciado encerrou com ${code}\n${restartOutput}`)));
    });

    const browserAfterRestart = await open(`ws://127.0.0.1:${port}/ws?session=protocolo`);
    const restoredState = await nextJson(browserAfterRestart, (m) => m.type === 'state');
    assert.equal(restoredState.busy, true, 'reinicio deve reconstruir a trava de pedido despachado');
    const adapterAfterRestart = await open(`ws://127.0.0.1:${port}/agent`);
    assert.deepEqual(await nextJson(adapterAfterRestart), { type: 'hello', protocol: 1 });
    const restartReplay = nextJson(adapterAfterRestart, (m) => m.type === 'analyze' && m.requestId === restartRequest.requestId);
    send(adapterAfterRestart, { type: 'register', protocol: 1, adapterId: 'depois-restart', label: 'Depois restart' });
    assert.equal((await restartReplay).requestId, restartRequest.requestId);
    const restartDone = nextJson(browserAfterRestart, (m) => m.type === 'state' && !m.busy
      && m.thread.messages.some((entry) => entry.text.includes('restart encerrado')));
    send(adapterAfterRestart, { type: 'failed', requestId: restartRequest.requestId, message: 'restart encerrado' });
    await restartDone;
    await close(adapterAfterRestart);

    const alias = await open(`ws://127.0.0.1:${port}/claude`);
    assert.deepEqual(await nextJson(alias), { type: 'hello', protocol: 1 });
    await close(alias);
    await close(browser);
    await close(browserAfterRestart);

    const inbox = fs.readFileSync(path.join(dataDir, 'protocolo', 'inbox.jsonl'), 'utf8')
      .trim().split(/\r?\n/).flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
    assert(inbox.some((entry) => entry.type === 'accepted' && entry.requestId === first.requestId));
    assert(inbox.some((entry) => entry.type === 'completed' && entry.requestId === first.requestId));
    assert(inbox.some((entry) => entry.type === 'completed' && entry.requestId === interrupted.requestId));
    assert(inbox.some((entry) => entry.type === 'failed' && entry.requestId === pending.requestId));
    assert(inbox.some((entry) => entry.type === 'failed' && entry.requestId === timedOut.requestId));
    assert(inbox.some((entry) => entry.type === 'dispatched' && entry.requestId === restartRequest.requestId));
    assert(inbox.some((entry) => entry.type === 'failed' && entry.requestId === restartRequest.requestId));

    console.log('VEREDITO: OK - registro, unlock atomico, rename num rev so, patch e rename bloqueados no busy, fila/rev serial, queda, timeout, restart, replay e alias validados.');
  } finally {
    for (const ws of sockets) ws.terminate();
    sockets.clear();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    if (restartedChild && restartedChild.exitCode === null && restartedChild.signalCode === null) {
      const exited = new Promise((resolve) => restartedChild.once('exit', resolve));
      restartedChild.kill();
      await exited;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('VEREDITO: FALHA - ' + error.stack);
  process.exitCode = 1;
});
