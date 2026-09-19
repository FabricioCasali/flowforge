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
//   2. a cada "Analisar", ENTREGA o pedido a sessao (ver os dois modos abaixo);
//   3. segura o socket e manda `progress` enquanto a sessao trabalha;
//   4. quando a sessao roda `live.js done <requestId>`, aplica o reply.json, sela
//      os arquivos e manda `completed`.
//
//   node adapters/live.js [--url ws://localhost:4317/agent] [--label "Claude Code"] [--deliver <nome>]
//   node adapters/live.js wait [--port 4317] [--label "Claude Code"]   ouvinte do hook Stop
//   node adapters/live.js done <requestId> [--message "texto"] [--failed "motivo"]
//   node adapters/live.js stop [--port 4317]                          encerra a ponte destacada
//
// DOIS PAPEIS, porque acordar a sessao exige um processo que SAI e segurar o
// socket exige um que FICA:
//
//   A PONTE (fica) — este arquivo sem subcomando, ou com `--mode wait`. Segura o
//   /agent, manda `progress`, atende o `done`. Em `--mode wait` ela roda
//   DESTACADA (sem terminal, sobrevive ao fim do turno) e guarda os pedidos numa
//   fila ate um ouvinte vir buscar.
//
//   O OUVINTE (sai) — `live.js wait`, que e o que o hook `Stop` do plugin executa.
//   Ele sai 0 e calado quando nao ha o que fazer, garante que a ponte esta no ar,
//   espera o proximo pedido num long-poll (`GET /next` na porta de controle) e,
//   quando ele chega, escreve o pedido no STDERR e sai com codigo 2 — e isso que
//   acorda a sessao ociosa no Claude Code (hook `Stop` com `async` + `asyncRewake`).
//
// COMO o pedido chega na sessao depende do harness. O modo Monitor (sem subcomando)
// imprime a linha no stdout: serve a quem vigia o processo, como a ferramenta Monitor
// do Claude Code. `--deliver <nome>` troca isso por um modulo adapters/deliver/<nome>.js
// que exporta `deliver({ line, evt, opts })` -> Promise: e o lugar de entregar por API
// do harness (um servidor HTTP da TUI, por exemplo). O resto — registro, progress, o
// `done` — e igual nos tres modos.
//
// Saida: uma linha curta por evento, prefixo FLOWFORGE:
//   FLOWFORGE analisar <requestId> sessao=<slug> dir=<pasta da sessao> nota="<pedido>"
// Ao receber: leia <dir>/workspace.json e <dir>/thread.json, grave a resposta em
// <dir>/reply.json (formato em reply.js) e rode `live.js done <requestId>`.
//
// UMA ponte por servidor: a porta de controle e anunciada em
// ~/.flowforge/live-<porta>.json, e quem chega depois nao disputa.
// =============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { applyReplyFile, sealFiles, snapshotBefore } = require('./core.js');
const { replyPath } = require('./reply.js');
const { findExistingDataDir } = require('./project.js');

const PROGRESS_MS = 30000;
// Quanto o /next segura a conexao antes de devolver 204 (o ouvinte repergunta).
// Nao e prazo de vida do ouvinte: e so pra nao deixar um socket pendurado por horas.
const NEXT_HOLD_MS = 9 * 60 * 1000;
// Fim de vida da ponte destacada — ela nao pode ficar orfa pra sempre:
//   - sem ouvinte NEM pedido pendente por 30 min: o hook Stop dispara a cada fim de
//     turno, entao sessao viva rearma o ouvinte em um turno. 30 min sem nenhum e
//     sessao que foi embora.
//   - servidor fora do ar por 10 min: o projeto foi fechado.
const IDLE_MS = 30 * 60 * 1000;
const SERVER_GONE_MS = 10 * 60 * 1000;
const PARENT_CHECK_MS = 30000;   // o ouvinte morre junto com quem o chamou
const BRIDGE_READY_MS = 15000;   // espera a ponte destacada registrar
const DEFAULT_PORTS = [4317, 4318]; // a porta padrao e a alternativa que a skill sugere

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parse(argv) {
  const out = { args: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--port') out.port = argv[++i];
    else if (a === '--label') out.label = argv[++i];
    else if (a === '--message') out.message = argv[++i];
    else if (a === '--failed') out.failed = argv[++i];
    else if (a === '--deliver') out.deliver = argv[++i];
    else if (a === '--mode') out.mode = argv[++i];
    else out.args.push(a);
  }
  return out;
}

function portOf(url) { return Number((String(url).match(/:(\d+)/) || [])[1] || 4317); }

/** O servidor a que esta invocacao se refere: --url manda, senao --port, senao o padrao. */
function resolveUrl(opts) {
  if (opts.url) return opts.url;
  if (opts.port) return 'ws://127.0.0.1:' + Number(opts.port) + '/agent';
  return 'ws://localhost:4317/agent';
}

/** Onde a ponte viva anuncia a porta de controle — um arquivo por servidor. */
function controlFile(url) {
  return path.join(os.homedir(), '.flowforge', 'live-' + portOf(url) + '.json');
}

function readControl(url) {
  try { return JSON.parse(fs.readFileSync(controlFile(url), 'utf8')); } catch (e) { return null; }
}

/** No Windows o mesmo diretorio aparece com caixas diferentes; comparar cru daria falso negativo. */
function sameDir(a, b) {
  const norm = (d) => (process.platform === 'win32' ? path.resolve(d).toLowerCase() : path.resolve(d));
  return norm(a) === norm(b);
}

const say = (line) => process.stdout.write('FLOWFORGE ' + line + '\n');

// ---- cliente HTTP da porta de controle (sempre loopback) --------------------
function ask(port, method, pathName, body, timeoutMs) {
  return new Promise((resolve) => {
    const options = { host: '127.0.0.1', port, path: pathName, method, headers: {} };
    if (body != null) {
      options.headers['content-type'] = 'application/json';
      options.headers['content-length'] = Buffer.byteLength(body);
    }
    const req = http.request(options, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', () => resolve(null));
    if (timeoutMs) req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.end(body == null ? undefined : body);
  });
}

const askJson = async (port, method, pathName, body, timeoutMs) => {
  const r = await ask(port, method, pathName, body, timeoutMs);
  if (!r || r.status !== 200) return null;
  try { return JSON.parse(r.text); } catch (e) { return null; }
};

/** O estado da ponte deste servidor, ou null se nao houver ponte viva. */
async function bridgeState(url) {
  const control = readControl(url);
  if (!control || !control.port) return null;
  return askJson(control.port, 'GET', '/state', null, 2000);
}

// ---- done: a sessao avisa a ponte que terminou ------------------------------
function done(opts) {
  const requestId = opts.args[1];
  if (!requestId) { console.error('uso: live.js done <requestId> [--message "texto"] [--failed "motivo"]'); process.exit(2); }
  const control = readControl(resolveUrl(opts));
  if (!control) { console.error('nao ha ponte viva rodando (o hook Stop a sobe sozinho; sem o plugin, arme o Monitor com adapters/live.js)'); process.exit(1); }
  const body = JSON.stringify({ requestId, message: opts.message || '', failed: opts.failed || '' });
  const req = http.request({ host: '127.0.0.1', port: control.port, path: '/done', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
    let text = '';
    res.on('data', (d) => { text += d; });
    res.on('end', () => { console.log(text.trim()); process.exit(res.statusCode === 200 ? 0 : 1); });
  });
  req.on('error', (e) => { console.error('a ponte viva nao respondeu: ' + e.message); process.exit(1); });
  req.end(body);
}

// ---- stop: encerra a ponte destacada ----------------------------------------
async function stop(opts) {
  const url = resolveUrl(opts);
  const control = readControl(url);
  if (!control) { console.log('nao ha ponte viva na porta ' + portOf(url)); process.exit(0); }
  const r = await ask(control.port, 'POST', '/stop', '{}', 3000);
  if (!r) {
    try { fs.unlinkSync(controlFile(url)); } catch (e) { /* ja foi */ }
    console.log('a ponte nao respondeu; limpei o arquivo de controle');
    process.exit(0);
  }
  console.log(r.text.trim() || 'ponte encerrada');
  process.exit(0);
}

// ---- listen: a ponte ---------------------------------------------------------
async function listen(opts) {
  const url = opts.url || 'ws://localhost:4317/agent';
  const label = opts.label || 'Claude Code';
  const mode = opts.mode === 'wait' ? 'wait' : 'monitor';
  const pending = new Map(); // requestId -> { evt, before, beat }
  const queue = [];          // pedidos que chegaram SEM ouvinte (modo wait)
  let listener = null;       // o `wait` pendurado no /next
  let registered = false;
  let refused = false;
  let downSince = Date.now();
  let lastFree = Date.now(); // desde quando a ponte esta sem ouvinte e sem pedido

  // UMA ponte por servidor. Sem esta checagem a segunda sobrescreveria o arquivo de
  // controle da primeira e, ao ser recusada pelo servidor, o apagaria — deixando a
  // ponte boa sem como receber o `done`.
  const outra = await bridgeState(url);
  if (outra) {
    if (mode === 'monitor') say('ja existe uma ponte viva neste servidor (pid ' + outra.pid + ', modo ' + outra.mode + '); nao vou disputar');
    process.exit(mode === 'monitor' ? 1 : 0);
  }

  let deliverer = null; // modulo de entrega; sem ele, o stdout e a entrega
  if (opts.deliver) {
    if (!/^[a-z0-9-]+$/.test(opts.deliver)) { console.error('--deliver invalido: ' + opts.deliver); process.exit(2); }
    deliverer = require(path.join(__dirname, 'deliver', opts.deliver + '.js'));
  }
  let ws = null;
  let retryMs = 1000;
  let announcedDown = false;

  const send = (msg) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
  const json = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };

  // O long-poll do ouvinte. Um ouvinte por vez: o hook Stop dispara a cada fim de
  // turno, e sem esta recusa empilharia um processo por turno.
  function onNext(req, res) {
    if (mode !== 'wait') return json(res, 409, { reason: 'monitor' });
    if (listener) return json(res, 409, { reason: 'ouvinte' });
    const entry = { res, timer: null };
    entry.deliver = (item) => {
      if (listener !== entry) return;
      listener = null;
      lastFree = Date.now();
      clearTimeout(entry.timer);
      if (item) json(res, 200, item);
      else { res.writeHead(204); res.end(); }
    };
    listener = entry;
    entry.timer = setTimeout(() => entry.deliver(null), NEXT_HOLD_MS);
    req.on('close', () => {
      if (listener !== entry) return;
      listener = null;
      lastFree = Date.now();
      clearTimeout(entry.timer);
    });
    if (queue.length) entry.deliver(queue.shift());
  }

  // porta de controle: so loopback
  const control = http.createServer((req, res) => {
    const rota = String(req.url || '').split('?')[0];
    if (req.method === 'GET' && rota === '/state') {
      return json(res, 200, { ok: true, mode, url, pid: process.pid, registered, refused, listener: !!listener, queued: queue.length, pending: pending.size });
    }
    if (req.method === 'GET' && rota === '/next') return onNext(req, res);
    if (req.method === 'POST' && rota === '/stop') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ponte encerrada');
      return setTimeout(() => process.exit(0), 50);
    }
    if (req.method !== 'POST' || rota !== '/done') { res.writeHead(404); return res.end(); }
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
    fs.writeFileSync(file, JSON.stringify({ port: control.address().port, pid: process.pid, url, mode }));
  });
  // So apaga o arquivo se ele ainda for NOSSO: duas pontas que subam no mesmo
  // instante nao podem apagar o anuncio da que venceu.
  const cleanup = () => {
    try {
      const cur = JSON.parse(fs.readFileSync(controlFile(url), 'utf8'));
      if (cur.pid === process.pid) fs.unlinkSync(controlFile(url));
    } catch (e) { /* ja foi, ou e de outra */ }
  };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

  // Fim de vida da ponte destacada (ver as constantes no topo). No modo Monitor
  // quem manda e o harness que vigia o processo: nada daqui se aplica.
  if (mode === 'wait') {
    setInterval(() => {
      if (downSince && Date.now() - downSince > SERVER_GONE_MS) process.exit(0);
      if (listener || queue.length || pending.size) { lastFree = Date.now(); return; }
      if (Date.now() - lastFree > IDLE_MS) process.exit(0);
    }, 30000);
  }

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
    const dir = path.dirname(evt.workspacePath).replace(/\\/g, '/');
    const line = 'analisar ' + evt.requestId
      + ' sessao=' + evt.session
      + ' dir=' + dir
      + ' nota=' + JSON.stringify(note.length > 240 ? note.slice(0, 240) + '… (inteira no thread.json)' : note);
    say(line); // sempre no stdout: e o log da ponte, mesmo quando a entrega e por outro caminho
    if (mode === 'wait') {
      // Pedido que chega sem ouvinte (a sessao estava no meio de um turno) NAO se
      // perde: fica na fila e o proximo `wait` o recebe.
      const item = { requestId: evt.requestId, session: evt.session, dir, line: 'FLOWFORGE ' + line };
      if (listener) listener.deliver(item);
      else queue.push(item);
    }
    if (deliverer) {
      Promise.resolve(deliverer.deliver({ line: 'FLOWFORGE ' + line, evt, opts }))
        .catch((e) => say('erro: a entrega por "' + opts.deliver + '" falhou: ' + e.message));
    }
  }

  function connect() {
    ws = new WebSocket(url);
    ws.on('open', () => { retryMs = 1000; });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      if (msg.type === 'hello') {
        send({ type: 'register', protocol: 1, adapterId: 'flowforge-live', label });
        registered = true;
        downSince = null;
        say((announcedDown ? 'reconectado' : 'pronto') + ': o Analisar do canvas chega nesta sessao (' + url + ')');
        announcedDown = false;
      } else if (msg.type === 'analyze') {
        onAnalyze(msg);
      } else if (msg.type === 'error') {
        say('erro: ' + msg.message + ' — pare o outro adapter antes de armar este');
        registered = false;
        refused = true;
        // No modo wait quem subiu esta ponte foi o `wait`, que esta perguntando o
        // /state: da tempo dele ver a recusa antes de sumir.
        if (mode === 'wait') setTimeout(() => process.exit(1), 2000);
        else process.exit(1);
      }
    });
    ws.on('close', () => {
      registered = false;
      if (downSince === null) downSince = Date.now();
      if (!announcedDown) { say('servidor fora do ar; tentando reconectar (pedidos pendentes serao reenviados)'); announcedDown = true; }
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 15000);
    });
    ws.on('error', () => { /* o close cuida */ });
  }
  connect();
}

// ---- wait: o ouvinte que o hook Stop executa --------------------------------
// Ele SAI — e o codigo 2 com texto no stderr que acorda a sessao ociosa. Tudo que
// nao for "chegou um pedido" termina em exit 0 e SILENCIO: o hook roda a cada fim
// de turno e nao pode virar ruido nem atrapalhar quem nao usa o FlowForge.
function readStdin() {
  return new Promise((resolve) => {
    let s = '';
    process.stdin.on('data', (d) => { s += d; });
    const pronto = () => { try { process.stdin.pause(); } catch (e) { /* ja fechou */ } resolve(s); };
    process.stdin.on('end', pronto);
    process.stdin.on('error', pronto);
    setTimeout(pronto, 2000).unref(); // hook sem stdin nao pode pendurar o harness
  });
}

/** O servidor FlowForge DESTE projeto, ou null. Outro projeto na mesma porta nao serve. */
async function findServer(opts, dataDir) {
  const ports = [];
  if (opts.port) ports.push(Number(opts.port));
  else if (opts.url) ports.push(portOf(opts.url));
  else if (process.env.FLOWFORGE_PORT) ports.push(Number(process.env.FLOWFORGE_PORT));
  else ports.push(...DEFAULT_PORTS);
  for (const p of ports) {
    const health = await askJson(p, 'GET', '/api/health', null, 1500);
    if (!health || !health.ok || !health.dataDir) continue;
    if (!sameDir(health.dataDir, dataDir)) continue; // e o servidor de OUTRO projeto
    return 'ws://127.0.0.1:' + p + '/agent';
  }
  return null;
}

/** Sobe a ponte DESTACADA (sem terminal, sobrevive ao fim do turno). */
async function spawnBridge(url, opts) {
  const args = [__filename, '--url', url, '--mode', 'wait'];
  if (opts.label) args.push('--label', opts.label);
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  const t0 = Date.now();
  while (Date.now() - t0 < BRIDGE_READY_MS) {
    const s = await bridgeState(url);
    if (s && s.refused) return false; // o /agent e de outro adapter: nao disputa
    if (s && s.registered) return true;
    await sleep(200);
  }
  return false;
}

// O Claude Code entrega este texto ao modelo rotulado como "Stop hook blocking
// error" — por isso a PRIMEIRA linha desmente o rotulo: nao e erro, e o usuario
// chamando. Depois vem a mesma linha do modo Monitor e o que fazer com ela.
function wakeText(item) {
  const raiz = path.resolve(__dirname, '..').replace(/\\/g, '/');
  return [
    'FLOWFORGE: NAO e um erro. E o clique do usuario em "Analisar" no canvas do FlowForge.',
    item.line,
    'Leia ' + item.dir + '/workspace.json e ' + item.dir + '/thread.json, grave ' + item.dir + '/reply.json e rode:',
    '  node ' + raiz + '/adapters/live.js done ' + item.requestId,
  ].join('\n') + '\n';
}

async function wait(opts) {
  let payload = {};
  try { payload = JSON.parse(await readStdin()) || {}; } catch (e) { payload = {}; }
  const dataDir = findExistingDataDir(payload.cwd || process.cwd());
  if (!dataDir) return process.exit(0); // este projeto nao usa FlowForge

  const url = await findServer(opts, dataDir);
  if (!url) return process.exit(0); // sem servidor deste projeto no ar

  const state = await bridgeState(url);
  if (state && state.mode !== 'wait') return process.exit(0); // o Monitor (ou o --deliver) manda
  if (state && state.listener) return process.exit(0);        // ja ha um ouvinte vivo
  if (!state && !(await spawnBridge(url, opts))) return process.exit(0);

  // O ouvinte nao sobrevive a quem o chamou: hook e processo filho do harness, e
  // sem isto uma sessao fechada deixaria um socket pendurado pra sempre.
  const pai = process.ppid;
  setInterval(() => {
    try { process.kill(pai, 0); } catch (e) { process.exit(0); }
  }, PARENT_CHECK_MS).unref();

  const control = readControl(url);
  if (!control) return process.exit(0);
  for (;;) {
    const r = await ask(control.port, 'GET', '/next', null, NEXT_HOLD_MS + 60000);
    if (!r) return process.exit(0);          // a ponte sumiu: o proximo turno rearma
    if (r.status === 204) continue;          // long-poll renovado
    if (r.status !== 200) return process.exit(0); // 409: outro ouvinte, ou modo Monitor
    let item;
    try { item = JSON.parse(r.text); } catch (e) { return process.exit(0); }
    process.stderr.write(wakeText(item));
    return process.exit(2);
  }
}

const opts = parse(process.argv.slice(2));
const cmd = opts.args[0];
const falhou = (e) => { console.error('flowforge live: ' + e.message); process.exit(1); };
if (cmd === 'done') done(opts);
else if (cmd === 'wait') wait(opts).catch(() => process.exit(0));
else if (cmd === 'stop') stop(opts).catch(falhou);
else listen(opts).catch(falhou);
