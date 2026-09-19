// =============================================================================
// adapters/core.js — o nucleo comum dos adapters de harness.
//
// O FlowForge (servidor + editor) nao sabe que harness existe: ele so abre o WS
// /agent e fala o protocolo do docs/SCHEMA.md. Este arquivo e o OUTRO lado desse
// protocolo, e e igual para todo harness:
//
//   hello -> register -> analyze -> accepted -> [progress...] -> completed|failed
//
// O que muda de harness para harness — como chamar o CLI em modo nao-interativo e
// como retomar a conversa — mora num DRIVER (adapters/drivers/*.js), que so
// precisa exportar { id, label, run(job) }.
//
// Garantias que o protocolo exige e que ficam aqui, nao no driver:
//   - entrega e "pelo menos uma vez": o mesmo requestId pode chegar de novo depois
//     de uma queda. Nunca inicia duas execucoes do mesmo pedido.
//   - resposta sempre com o MESMO requestId.
//   - ordem segura: workspace.json, thread.json, completed.
// =============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { buildPrompt } = require('./prompt.js');
const { applyReply, consumeReply, replyPath } = require('./reply.js');

const STATE_FILE = process.env.FLOWFORGE_ADAPTER_STATE || path.join(os.homedir(), '.flowforge', 'adapter-state.json');
const PROGRESS_MS = 30000; // batimento: o servidor rearma a trava a cada `progress`
const JOB_TIMEOUT_MS = Number(process.env.FLOWFORGE_ADAPTER_TIMEOUT_MS) || 15 * 60 * 1000;

// ---- estado local: o id da conversa do harness por sessao do FlowForge -------
// Fica no HOME, nao na pasta da sessao: id de conversa e da maquina, e a pasta
// .flowforge/ e versionada junto com o projeto.
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
}
function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
function getResumeId(workspacePath, driverId) {
  const entry = readState()[workspacePath];
  return entry && entry[driverId] ? entry[driverId].resumeId : null;
}
function setResumeId(workspacePath, driverId, resumeId) {
  const state = readState();
  state[workspacePath] = state[workspacePath] || {};
  if (resumeId) state[workspacePath][driverId] = { resumeId, at: new Date().toISOString() };
  else delete state[workspacePath][driverId];
  writeState(state);
}

// ---- processo filho ---------------------------------------------------------
// No Windows os CLIs instalados por npm sao shims .cmd, que so rodam por shell.
// Com shell a linha e montada aqui (o Node nao escapa args nesse modo); por isso
// os drivers mandam o pedido por STDIN ou arquivo, nunca como argumento.
function quote(arg) {
  return /[\s"&|<>^%()]/.test(arg) ? '"' + String(arg).replace(/"/g, '\\"') + '"' : String(arg);
}
function runProcess(cmd, args, { cwd, stdin, timeoutMs = JOB_TIMEOUT_MS, env } = {}) {
  return new Promise((resolve) => {
    const win = process.platform === 'win32';
    const child = win
      ? spawn([cmd, ...args].map(quote).join(' '), { cwd, shell: true, env: env || process.env, windowsHide: true })
      : spawn(cmd, args, { cwd, env: env || process.env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (win) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(err.message), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    if (stdin != null) child.stdin.write(stdin);
    child.stdin.end();
  });
}

/** Linhas JSON de um stdout (os tres harnesses emitem JSONL no modo --json). */
function parseJsonLines(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { out.push(JSON.parse(t)); } catch (e) { /* linha de log no meio do JSONL */ }
  }
  return out;
}

// ---- conferencia depois que o harness terminou -------------------------------
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function agentMessages(threadPath) {
  try {
    return (readJson(threadPath).messages || []).filter((m) => m.author === 'agent').length;
  } catch (e) { return 0; }
}

/**
 * O harness respondeu, mas o CONTRATO e do arquivo. Fecha as duas pontas que um
 * modelo esquece com mais frequencia — e que, esquecidas, fazem o canvas ignorar
 * a resposta em silencio:
 *   1. mexeu no workspace.json sem subir o `rev` -> sobe e marca `updatedBy`.
 *   2. nao escreveu no thread.json -> a fala final do harness vira a mensagem.
 * Devolve um erro (string) se o workspace ficou ilegivel.
 */
function sealFiles(evt, before, finalText) {
  let workspace;
  try { workspace = readJson(evt.workspacePath); } catch (e) {
    fs.writeFileSync(evt.workspacePath, before.workspaceRaw); // nao deixa o canvas sem arquivo
    return 'o harness deixou o workspace.json invalido (' + e.message + '); restaurei o anterior';
  }
  const changed = JSON.stringify(workspace) !== JSON.stringify(before.workspace);
  if (changed && !(Number(workspace.rev) > Number(evt.workspaceRev))) {
    workspace.rev = Number(evt.workspaceRev) + 1;
    workspace.updatedBy = 'agent';
    fs.writeFileSync(evt.workspacePath, JSON.stringify(workspace, null, 2));
  }
  if (agentMessages(evt.threadPath) <= before.agentMessages) {
    let thread = { messages: [] };
    try { thread = readJson(evt.threadPath); } catch (e) { /* thread novo */ }
    thread.messages = Array.isArray(thread.messages) ? thread.messages : [];
    const text = String(finalText || '').trim() || '(o agente terminou sem escrever uma resposta)';
    thread.messages.push({ author: 'agent', text: text.slice(0, 6000), ts: Date.now() });
    fs.writeFileSync(evt.threadPath, JSON.stringify(thread, null, 2));
  }
  return null;
}

/**
 * O caminho rapido: o agente gravou <sessao>/reply.json e o adapter aplica (ver
 * reply.js). Devolve um erro (string) ou null. Sem reply.json nao faz nada — o
 * agente editou o workspace direto, e o `sealFiles` cuida do resto.
 */
function applyReplyFile(evt, log) {
  const consumed = consumeReply(evt);
  if (!consumed) return null;
  if (consumed.error) return consumed.error;

  const workspace = readJson(evt.workspacePath);
  const res = applyReply(workspace, consumed.reply);
  if (res.changed) {
    workspace.rev = Math.max(Number(workspace.rev) || 0, Number(evt.workspaceRev)) + 1;
    workspace.updatedBy = 'agent';
    const model = workspace[consumed.reply.model];
    if (model && typeof model === 'object') { model.rev = workspace.rev; model.updatedBy = 'agent'; }
    const tmp = evt.workspacePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(workspace, null, 2));
    fs.renameSync(tmp, evt.workspacePath);
  }
  if (res.problems.length) log('reply.json com ' + res.problems.length + ' item(ns) pulado(s): ' + res.problems.join(' | '));
  const text = [res.message, res.problems.length ? '(o adapter pulou ' + res.problems.length + ' operacao(oes): ' + res.problems.join('; ') + ')' : '']
    .filter(Boolean).join('\n\n');
  if (text) {
    let thread = { messages: [] };
    try { thread = readJson(evt.threadPath); } catch (e) { /* thread novo */ }
    thread.messages = Array.isArray(thread.messages) ? thread.messages : [];
    thread.messages.push({ author: 'agent', text: text.slice(0, 6000), ts: Date.now() });
    fs.writeFileSync(evt.threadPath, JSON.stringify(thread, null, 2));
  }
  return null;
}

/** O retrato dos arquivos ANTES do agente mexer — e contra ele que o `sealFiles` compara. */
function snapshotBefore(evt) {
  const workspaceRaw = fs.readFileSync(evt.workspacePath, 'utf8');
  return { workspaceRaw, workspace: JSON.parse(workspaceRaw), agentMessages: agentMessages(evt.threadPath) };
}

// ---- um pedido ---------------------------------------------------------------
async function runJob(driver, evt, opts, log) {
  const cwd = evt.projectPath || path.resolve(path.dirname(evt.workspacePath), '..', '..');
  const before = snapshotBefore(evt);
  try { fs.unlinkSync(replyPath(evt)); } catch (e) { /* nao havia resposta velha */ }

  const prompt = buildPrompt(evt, { continuing: false });
  let resumeId = opts.fresh ? null : getResumeId(evt.workspacePath, driver.id);
  const job = { evt, cwd, model: opts.model, effort: opts.effort, extraArgs: opts.extraArgs || [], runProcess, parseJsonLines, log };

  let result = await driver.run({ ...job, resumeId, prompt: resumeId ? buildPrompt(evt, { continuing: true }) : prompt });
  if (!result.ok && resumeId) {
    // conversa antiga pode ter sido apagada ou ser de outra versao do harness
    log('retomada falhou (' + (result.error || 'sem detalhe') + '); tentando conversa nova');
    setResumeId(evt.workspacePath, driver.id, null);
    resumeId = null;
    result = await driver.run({ ...job, resumeId: null, prompt });
  }
  if (result.resumeId) setResumeId(evt.workspacePath, driver.id, result.resumeId);
  if (!result.ok) return { ok: false, message: result.error || 'o harness terminou com erro' };

  const replyError = applyReplyFile(evt, log);
  if (replyError) return { ok: false, message: replyError };
  const sealError = sealFiles(evt, before, result.text);
  if (sealError) return { ok: false, message: sealError };
  return { ok: true };
}

// ---- a conexao ---------------------------------------------------------------
function startAdapter(driver, opts = {}) {
  const url = opts.url || 'ws://localhost:4317/agent';
  const log = opts.log || ((...a) => console.log('[' + driver.id + ']', ...a));
  const jobs = new Map(); // requestId -> { final: msg|null }  (deduplicacao entre reconexoes)
  let ws = null;
  let stopped = false;
  let retryMs = 1000;

  const send = (msg) => {
    if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(msg)); return true; }
    return false;
  };

  async function onAnalyze(evt) {
    const known = jobs.get(evt.requestId);
    if (known) {
      // reenvio do mesmo pedido: confirma, e se ja terminou repete o desfecho
      send({ type: 'accepted', protocol: 1, requestId: evt.requestId });
      if (known.final) send(known.final);
      return;
    }
    const job = { final: null };
    jobs.set(evt.requestId, job);
    send({ type: 'accepted', protocol: 1, requestId: evt.requestId });
    log('analisar', evt.session, 'rev', evt.workspaceRev, '-', JSON.stringify(String(evt.note || '').slice(0, 80)));

    const beat = setInterval(() => send({ type: 'progress', protocol: 1, requestId: evt.requestId }), opts.progressMs || PROGRESS_MS);
    let outcome;
    try {
      outcome = await runJob(driver, evt, opts, log);
    } catch (e) {
      outcome = { ok: false, message: e.message };
    }
    clearInterval(beat);

    job.final = outcome.ok
      ? { type: 'completed', protocol: 1, requestId: evt.requestId }
      : { type: 'failed', protocol: 1, requestId: evt.requestId, message: outcome.message };
    log(outcome.ok ? 'concluido' : 'falhou: ' + outcome.message, evt.session);
    // se o socket caiu no meio, o servidor reenvia o pedido na reconexao e o
    // desfecho sai por `known.final`
    send(job.final);
  }

  function connect() {
    if (stopped) return;
    ws = new WebSocket(url);
    ws.on('open', () => { retryMs = 1000; });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      if (msg.type === 'hello') {
        send({ type: 'register', protocol: 1, adapterId: opts.adapterId || 'flowforge-' + driver.id, label: opts.label || driver.label });
        log('registrado em', url, 'como', JSON.stringify(opts.label || driver.label));
      } else if (msg.type === 'analyze') {
        onAnalyze(msg);
      } else if (msg.type === 'error') {
        log('servidor recusou:', msg.message);
        if (/adapter ativo/i.test(String(msg.message))) stopped = true; // so um por vez: nao disputa
      }
    });
    ws.on('close', () => {
      if (stopped) { if (opts.onStop) opts.onStop(); return; }
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 15000);
    });
    ws.on('error', () => { /* o 'close' que vem em seguida cuida da reconexao */ });
  }

  connect();
  return {
    stop() { stopped = true; if (ws) ws.close(); },
    /** Derruba o socket sem parar o adapter (ele reconecta). So para os testes. */
    drop() { if (ws) ws.terminate(); },
  };
}

module.exports = { startAdapter, runProcess, parseJsonLines, sealFiles, applyReplyFile, snapshotBefore };
