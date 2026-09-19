#!/usr/bin/env node
// =============================================================================
// adapters/live.js — o "Analisar" respondido pela SESSAO QUE JA ESTA ABERTA.
//
// O adapters/index.js responde com uma execucao a parte do harness: uma conversa
// nova, que precisa reler o projeto pra entender o que a sessao do usuario ja
// sabe. Decisao de projeto (18/09/2026): quem responde e o proprio CLI que abriu
// o FlowForge — ele ja tem o contexto da task; qualquer outra forma e gastar
// token a toa.
//
// Esta ponte NAO chama harness nenhum. Ela:
//   1. conecta no /agent e se registra;
//   2. a cada "Analisar", IMPRIME UMA LINHA no stdout — e o harness, que esta
//      vigiando este processo, acorda a sessao com essa linha (no Claude Code:
//      a ferramenta Monitor; cada linha do stdout vira um evento na conversa);
//   3. segura o socket e manda `progress` enquanto a sessao trabalha;
//   4. quando a sessao roda `live.js done <requestId>`, aplica o reply.json, sela
//      os arquivos e manda `completed`.
//
//   node adapters/live.js [--url ws://localhost:4317/agent] [--label "Claude Code"]
//   node adapters/live.js done <requestId> [--message "texto"] [--failed "motivo"]
//
// Saida: uma linha curta por evento, prefixo FLOWFORGE:
//   FLOWFORGE analisar <requestId> sessao=<slug> dir=<pasta da sessao> nota="<pedido>"
// Ao receber: leia <dir>/workspace.json e <dir>/thread.json, grave a resposta em
// <dir>/reply.json (formato em reply.js) e rode `live.js done <requestId>`.
// =============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const { applyReplyFile, sealFiles, snapshotBefore } = require('./core.js');
const { replyPath } = require('./reply.js');

const PROGRESS_MS = 30000;

function parse(argv) {
  const out = { args: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--label') out.label = argv[++i];
    else if (a === '--message') out.message = argv[++i];
    else if (a === '--failed') out.failed = argv[++i];
    else out.args.push(a);
  }
  return out;
}

/** Onde a ponte viva anuncia a porta de controle — um arquivo por servidor. */
function controlFile(url) {
  const port = (String(url).match(/:(\d+)/) || [])[1] || '4317';
  return path.join(os.homedir(), '.flowforge', 'live-' + port + '.json');
}

const say = (line) => process.stdout.write('FLOWFORGE ' + line + '\n');

// ---- done: a sessao avisa a ponte que terminou ------------------------------
function done(opts) {
  const requestId = opts.args[1];
  if (!requestId) { console.error('uso: live.js done <requestId> [--message "texto"] [--failed "motivo"]'); process.exit(2); }
  let control;
  try { control = JSON.parse(fs.readFileSync(controlFile(opts.url || 'ws://localhost:4317/agent'), 'utf8')); }
  catch (e) { console.error('nao ha ponte viva rodando (arme o Monitor com adapters/live.js)'); process.exit(1); }
  const body = JSON.stringify({ requestId, message: opts.message || '', failed: opts.failed || '' });
  const req = http.request({ host: '127.0.0.1', port: control.port, path: '/done', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
    let text = '';
    res.on('data', (d) => { text += d; });
    res.on('end', () => { console.log(text.trim()); process.exit(res.statusCode === 200 ? 0 : 1); });
  });
  req.on('error', (e) => { console.error('a ponte viva nao respondeu: ' + e.message); process.exit(1); });
  req.end(body);
}

// ---- listen: a ponte ---------------------------------------------------------
function listen(opts) {
  const url = opts.url || 'ws://localhost:4317/agent';
  const label = opts.label || 'Claude Code';
  const pending = new Map(); // requestId -> { evt, before, beat }
  let ws = null;
  let retryMs = 1000;
  let announcedDown = false;

  const send = (msg) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };

  // porta de controle: so loopback
  const control = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/done') { res.writeHead(404); return res.end(); }
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw); } catch (e) { res.writeHead(400); return res.end('json invalido'); }
      const job = pending.get(body.requestId);
      if (!job) { res.writeHead(404); return res.end('requestId desconhecido ou ja concluido: ' + body.requestId); }
      clearInterval(job.beat);
      pending.delete(body.requestId);
      let error = body.failed ? String(body.failed) : null;
      if (!error) error = applyReplyFile(job.evt, () => {}) || sealFiles(job.evt, job.before, body.message);
      send(error
        ? { type: 'failed', protocol: 1, requestId: body.requestId, message: error }
        : { type: 'completed', protocol: 1, requestId: body.requestId });
      res.writeHead(error ? 500 : 200);
      res.end(error ? 'falhou: ' + error : 'concluido: o canvas foi destravado');
    });
  });
  control.listen(0, '127.0.0.1', () => {
    const file = controlFile(url);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ port: control.address().port, pid: process.pid, url }));
  });
  const cleanup = () => { try { fs.unlinkSync(controlFile(url)); } catch (e) { /* ja foi */ } };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

  function onAnalyze(evt) {
    send({ type: 'accepted', protocol: 1, requestId: evt.requestId });
    if (pending.has(evt.requestId)) return; // reenvio do mesmo pedido: ja foi anunciado
    try { fs.unlinkSync(replyPath(evt)); } catch (e) { /* sem resposta velha */ }
    const beat = setInterval(() => send({ type: 'progress', protocol: 1, requestId: evt.requestId }), PROGRESS_MS);
    pending.set(evt.requestId, { evt, before: snapshotBefore(evt), beat });
    // UMA linha, e CURTA: e o que acorda a sessao, e o harness corta evento comprido (na
    // primeira prova, 18/09/2026, a linha com todos os caminhos chegou truncada no fim).
    // O que nao pode faltar vem primeiro (requestId); o resto e convencao, nao payload:
    //   <dir>/workspace.json  <dir>/thread.json  <dir>/reply.json   e   live.js done <requestId>
    // A nota inteira esta sempre no thread.json (o servidor grava la antes de despachar).
    const note = String(evt.note || '').replace(/\s+/g, ' ').trim();
    say('analisar ' + evt.requestId
      + ' sessao=' + evt.session
      + ' dir=' + path.dirname(evt.workspacePath).replace(/\\/g, '/')
      + ' nota=' + JSON.stringify(note.length > 240 ? note.slice(0, 240) + '… (inteira no thread.json)' : note));
  }

  function connect() {
    ws = new WebSocket(url);
    ws.on('open', () => { retryMs = 1000; });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      if (msg.type === 'hello') {
        send({ type: 'register', protocol: 1, adapterId: 'flowforge-live', label });
        say((announcedDown ? 'reconectado' : 'pronto') + ': o Analisar do canvas chega nesta sessao (' + url + ')');
        announcedDown = false;
      } else if (msg.type === 'analyze') {
        onAnalyze(msg);
      } else if (msg.type === 'error') {
        say('erro: ' + msg.message + ' — pare o outro adapter antes de armar este');
        process.exit(1);
      }
    });
    ws.on('close', () => {
      if (!announcedDown) { say('servidor fora do ar; tentando reconectar (pedidos pendentes serao reenviados)'); announcedDown = true; }
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 15000);
    });
    ws.on('error', () => { /* o close cuida */ });
  }
  connect();
}

const opts = parse(process.argv.slice(2));
if (opts.args[0] === 'done') done(opts);
else listen(opts);
