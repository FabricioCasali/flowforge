#!/usr/bin/env node
'use strict';
// FlowForge bridge server.
//   - serve o editor (web-next/dist, React Flow + elkjs) em /
//   - WS /ws?session=<slug>  -> browsers (editam e recebem updates ao vivo)
//   - WS /agent              -> adapter externo (recebe eventos de "Analisar")
//   - WS /claude             -> alias temporario e legado de /agent
//   - fs.watch nas sessoes   -> quando um arquivo muda (browser OU agente), empurra o estado pros browsers
//
// Arquivos sao a fonte da verdade. O agente edita sessions/<slug>/workspace.json
// diretamente; o fs.watch propaga a mudanca pro canvas sem refresh manual.
//
// O editor antigo (Cytoscape, pasta web/, servido em /) foi REMOVIDO no FF-008,
// depois de o /v2 ser validado na tela. Sobrou dele so a migracao lazy em
// state.js: sessao antiga ainda tem diagram.json, ele vira workspace.json na
// primeira abertura e e preservado como backup (lei 5). Nada mais le nem escreve
// nesse arquivo.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { WebSocketServer } = require('ws');
const S = require('./state');
const Tasks = require('./tasks');
const Activity = require('./activity');

// ---- args -----------------------------------------------------------------
const argv = process.argv.slice(2);
function argVal(name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const PORT = Number(argVal('port', process.env.PORT || 4317));
const INITIAL_SESSION = argVal('session', null);
const DATA_DIR = argVal('data-dir', process.env.FLOWFORGE_DATA || null);
if (DATA_DIR) S.setDataDir(DATA_DIR);

const WEB_DIR = path.join(__dirname, '..', 'web-next', 'dist'); // o editor, servido em /

// ---- estado em memoria ----------------------------------------------------
const browsersBySession = new Map(); // slug -> Set<ws>
let activeAdapter = null;             // { ws, adapterId, label }
const watchers = new Map();           // slug -> fs.FSWatcher
const debounceTimers = new Map();     // slug -> timeout

// ---- helpers HTTP ---------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Tipos que o build do Vite produz (fontes, sourcemap, imagens).
const MIME_EXTRA = {
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.txt': 'text/plain; charset=utf-8',
};

// O editor e uma SPA: rota que nao existe em disco cai no index.html — mas SO se
// PARECER rota (sem extensao, ou .html). Asset faltando devolve 404 de verdade,
// senao um bundle quebrado viria disfarcado de HTML e o erro apareceria longe da
// causa.
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '' || rel === '/') rel = '/index.html';
  const filePath = path.normalize(path.join(WEB_DIR, rel));
  if (!filePath.startsWith(WEB_DIR)) { res.writeHead(403); return res.end('forbidden'); }

  fs.readFile(filePath, (err, buf) => {
    if (!err) {
      const ext = path.extname(filePath);
      const headers = { 'Content-Type': MIME[ext] || MIME_EXTRA[ext] || 'application/octet-stream' };
      // o Vite versiona o nome dos assets (hash) -> pode cachear; o resto, nunca.
      headers['Cache-Control'] = rel.startsWith('/assets/') ? 'public, max-age=86400' : 'no-store';
      res.writeHead(200, headers);
      return res.end(buf);
    }
    const ext = path.extname(rel);
    if (ext && ext !== '.html') { res.writeHead(404); return res.end('not found'); }

    fs.readFile(path.join(WEB_DIR, 'index.html'), (e2, html) => {
      if (e2) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('O editor ainda nao foi buildado.\n'
          + 'Rode: cd web-next && npm install && npm run build\n'
          + 'Esperado em: ' + WEB_DIR + '\n');
      }
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
      res.end(html);
    });
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ---- leitura segura (ignora escrita parcial) ------------------------------
// O arquivo-verdade e o workspace.json. Se ele existe mas nao le (rename em
// curso), devolve null: o proximo evento do fs.watch tenta de novo. Devolver um
// estado meio-lido seria pior que nao devolver nada — o canvas apagaria a lente.
//
// Antes do FF-008 isto exigia TAMBEM o diagram.json e devolvia null sem ele.
// Sessao nova nao tem mais esse arquivo, entao exigi-lo deixaria o canvas vazio
// pra sempre.
function safeReadState(slug) {
  let workspace = null;
  try {
    workspace = JSON.parse(fs.readFileSync(S.workspacePath(slug), 'utf8'));
  } catch (e) {
    if (fs.existsSync(S.workspacePath(slug))) return null; // existe mas nao leu -> transitorio
  }

  let thread = { messages: [] };
  try { thread = JSON.parse(fs.readFileSync(S.threadPath(slug), 'utf8')); } catch (e) {}

  return { workspace: S.normalizeWorkspace(workspace), thread };
}

// ---- estado "agente trabalhando" (trava de edicao no browser) --------------
// Enquanto trabalha, os browsers ficam em modo leitura. Cada trava pertence ao
// requestId despachado e so a resposta correspondente pode remove-la.
const BUSY_TIMEOUT_MS = Number(process.env.FLOWFORGE_BUSY_TIMEOUT_MS) || 180000;
const busyByRequest = new Map(); // requestId -> { slug, adapterWs|null, timer }
const requestSessionById = new Map(); // requestId despachado -> slug

function isSessionBusy(slug) {
  for (const busy of busyByRequest.values()) if (busy.slug === slug) return true;
  return false;
}
function busyForSession(slug) {
  for (const [requestId, busy] of busyByRequest) {
    if (busy.slug === slug) return { requestId, busy };
  }
  return null;
}
function broadcastBusy(slug) {
  const set = browsersBySession.get(slug);
  if (!set) return;
  const payload = JSON.stringify({ type: 'busy', session: slug, busy: isSessionBusy(slug) });
  for (const ws of set) { if (ws.readyState === ws.OPEN) ws.send(payload); }
}
function expireBusy(requestId) {
  const busy = busyByRequest.get(requestId);
  if (!busy) return;
  const adapterWs = busy.adapterWs;
  busy.adapterWs = null;
  busy.timer = null;
  S.appendThread(busy.slug, { author: 'system', text: 'O pedido excedeu o tempo limite; o adapter foi desconectado e a trava continua ativa para reenvio seguro.', ts: Date.now() });
  broadcastState(busy.slug);
  if (adapterWs && adapterWs.readyState === adapterWs.OPEN) adapterWs.close(1011, 'request timeout');
}
function armBusyTimer(requestId, busy) {
  clearTimeout(busy.timer);
  busy.timer = setTimeout(() => expireBusy(requestId), BUSY_TIMEOUT_MS);
}
function setBusy(slug, requestId, adapterWs) {
  if (busyByRequest.has(requestId)) return;
  const busy = { slug, adapterWs, timer: null };
  busyByRequest.set(requestId, busy);
  armBusyTimer(requestId, busy);
  broadcastBusy(slug);
}
function clearBusy(requestId, adapterWs) {
  const busy = busyByRequest.get(requestId);
  if (!busy || busy.adapterWs !== adapterWs) return false;
  clearTimeout(busy.timer);
  busyByRequest.delete(requestId);
  return true;
}

// ---- broadcast ------------------------------------------------------------
function broadcastState(slug) {
  const set = browsersBySession.get(slug);
  if (!set || set.size === 0) return;
  const st = safeReadState(slug);
  if (!st) return;
  for (const ws of set) { if (ws.readyState === ws.OPEN) ws.send(statePayload(slug, st)); }
}

function statePayload(slug, st) {
  return JSON.stringify({
    type: 'state',
    session: slug,
    workspace: st.workspace,
    thread: st.thread,
    busy: isSessionBusy(slug),
    agentOnline: activeAdapter !== null,
    agentLabel: activeAdapter ? activeAdapter.label : null,
  });
}

function broadcastAgentPresence() {
  const payload = JSON.stringify({
    type: 'agent',
    online: activeAdapter !== null,
    label: activeAdapter ? activeAdapter.label : null,
  });
  for (const set of browsersBySession.values()) {
    for (const ws of set) { if (ws.readyState === ws.OPEN) ws.send(payload); }
  }
}

function dispatchToAdapter(slug, event) {
  if (!activeAdapter || activeAdapter.ws.readyState !== activeAdapter.ws.OPEN) return false;
  const current = busyForSession(slug);
  if (current && current.requestId !== event.requestId) return false;
  const workspace = S.readWorkspace(slug);
  const freshEvent = {
    ...event,
    workspaceRev: workspace.rev,
    workspaceTitle: S.workspaceTitle(workspace),
  };
  // Persiste ANTES do envio: se o processo cair entre as duas operações, o boot
  // seguinte prefere reenviar com o mesmo requestId a destravar cedo demais.
  S.appendInbox(slug, {
    type: 'dispatched', protocol: 1, requestId: event.requestId, at: new Date().toISOString(),
  });
  activeAdapter.ws.send(JSON.stringify(freshEvent));
  requestSessionById.set(event.requestId, slug);
  if (current) {
    current.busy.adapterWs = activeAdapter.ws;
    armBusyTimer(event.requestId, current.busy);
  } else {
    setBusy(slug, event.requestId, activeAdapter.ws);
  }
  return true;
}

function dispatchNext(slug) {
  if (!activeAdapter || activeAdapter.ws.readyState !== activeAdapter.ws.OPEN) return false;
  const pending = S.pendingAnalyze(slug);
  const current = busyForSession(slug);
  if (current) {
    if (current.busy.adapterWs === activeAdapter.ws) return false;
    const event = pending.find((entry) => entry.requestId === current.requestId);
    return event ? dispatchToAdapter(slug, event) : false;
  }
  return pending.length > 0 ? dispatchToAdapter(slug, pending[0]) : false;
}

function replayPending(adapterWs) {
  for (const slug of S.listSessions()) {
    if (!activeAdapter || activeAdapter.ws !== adapterWs) return;
    dispatchNext(slug);
  }
}

function restoreDispatchedBusy() {
  for (const slug of S.listSessions()) {
    const event = S.pendingDispatchedAnalyze(slug)[0];
    if (!event) continue;
    busyByRequest.set(event.requestId, { slug, adapterWs: null, timer: null });
    requestSessionById.set(event.requestId, slug);
  }
}

function detachAdapterBusy(adapterWs) {
  const affected = new Set();
  for (const busy of busyByRequest.values()) {
    if (busy.adapterWs !== adapterWs) continue;
    busy.adapterWs = null;
    affected.add(busy.slug);
    S.appendThread(busy.slug, { author: 'system', text: 'O agente desconectou; o pedido ficou pendente para reenvio.', ts: Date.now() });
  }
  return affected;
}

// ---- fs.watch por sessao --------------------------------------------------
function ensureWatcher(slug) {
  if (watchers.has(slug)) return;
  const dir = S.sessionDir(slug);
  try {
    const w = fs.watch(dir, (evt, filename) => {
      if (!filename) return;
      const f = String(filename);
      // workspace.json entrou aqui: sem isso a edicao do agente no arquivo novo
      // nao chega no canvas — que e o loop vivo inteiro.
      if (f !== 'workspace.json' && f !== 'diagram.json' && f !== 'thread.json') return;
      clearTimeout(debounceTimers.get(slug));
      debounceTimers.set(slug, setTimeout(() => broadcastState(slug), 80));
    });
    watchers.set(slug, w);
  } catch (e) {
    console.error('[watch] falhou em', slug, e.message);
  }
}

// ---- tarefas ao vivo do CLI (<data-dir>/tasks.json) -------------------------
// Por PROJETO, nao por sessao: vai pra TODO browser aberto, em qualquer sessao.
// O servidor so le — quem escreve e o agente, pelo `adapters/tasks.js`. E um
// arquivo como os outros (lei 2): vigiado, e o que esta no disco e o que o canvas mostra.
// A linha do tempo (activity.jsonl, FF-035) segue a mesma regra: por projeto, so leitura,
// vai pra todo browser. Manda as ultimas ACTIVITY_TAIL — o arquivo e append-only e cresce.
const ACTIVITY_TAIL = 200;
function activityPayload() {
  return JSON.stringify({ type: 'activity', events: Activity.readTail(S.getRoot(), ACTIVITY_TAIL) });
}
function broadcastAll(payload) {
  for (const set of browsersBySession.values()) {
    for (const ws of set) { if (ws.readyState === ws.OPEN) ws.send(payload); }
  }
}
let activityTimer = null;

function tasksPayload() {
  return JSON.stringify({ type: 'tasks', tasks: Tasks.readTasks(S.getRoot()) });
}
function broadcastTasks() {
  const payload = tasksPayload();
  for (const set of browsersBySession.values()) {
    for (const ws of set) { if (ws.readyState === ws.OPEN) ws.send(payload); }
  }
}
let tasksTimer = null;
function watchTasks() {
  try {
    fs.mkdirSync(S.getRoot(), { recursive: true });
    // vigia a RAIZ, nao o arquivo: a escrita e por rename atomico, e no Windows
    // o watch de um arquivo morre quando ele e substituido.
    fs.watch(S.getRoot(), (evt, filename) => {
      const f = String(filename || '');
      if (f === 'tasks.json') {
        clearTimeout(tasksTimer);
        tasksTimer = setTimeout(broadcastTasks, 80);
      } else if (f === 'activity.jsonl') {
        // um turno do agente dispara varias acoes em rajada: junta um pouco mais
        clearTimeout(activityTimer);
        activityTimer = setTimeout(() => broadcastAll(activityPayload()), 150);
      }
    });
  } catch (e) {
    console.error('[tasks] nao consegui vigiar', S.getRoot(), e.message);
  }
}

// ---- HTTP server ----------------------------------------------------------
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (pathname === '/api/sessions') return sendJson(res, 200, { sessions: S.listSessions() });

  if (pathname === '/api/state') {
    const slug = S.slugify(parsed.query.session || INITIAL_SESSION || 'sessao');
    S.ensureSession(slug);
    return sendJson(res, 200, { session: slug, ...safeReadState(slug) });
  }

  if (pathname === '/api/tasks') return sendJson(res, 200, Tasks.readTasks(S.getRoot()));
  if (pathname === '/api/activity') return sendJson(res, 200, { events: Activity.readTail(S.getRoot(), ACTIVITY_TAIL) });

  if (pathname === '/api/health') return sendJson(res, 200, { ok: true, port: PORT, dataDir: S.getRoot() });

  // O editor morava em /v2 durante o porte. Quem tem a aba aberta ou um link
  // salvo cai aqui e e mandado pra raiz, com a query intacta (a sessao vai nela).
  if (pathname === '/v2' || pathname.startsWith('/v2/')) {
    const resto = pathname.slice(3) || '/';
    res.writeHead(301, { Location: resto + (parsed.search || '') });
    return res.end();
  }

  return serveStatic(req, res, pathname);
});

// ---- WebSocket ------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  if (pathname === '/ws' || pathname === '/agent' || pathname === '/claude') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws._kind = pathname === '/ws' ? 'browser' : 'agent';
      ws._session = S.slugify(parsed.query.session || INITIAL_SESSION || 'sessao');
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  if (ws._kind === 'agent') {
    let disconnected = false;
    const disconnect = () => {
      if (disconnected) return;
      disconnected = true;
      if (!activeAdapter || activeAdapter.ws !== ws) return;
      const affected = detachAdapterBusy(ws);
      activeAdapter = null;
      console.log('[agent] adapter desconectado');
      broadcastAgentPresence();
      for (const slug of affected) broadcastState(slug);
    };
    ws.on('close', disconnect);
    ws.on('error', disconnect);
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

      if (msg.type === 'register') {
        if (msg.protocol !== 1 || typeof msg.adapterId !== 'string' || !msg.adapterId.trim()
          || typeof msg.label !== 'string' || !msg.label.trim()) {
          ws.send(JSON.stringify({ type: 'error', message: 'Registro de adapter invalido.' }));
          ws.close(1008, 'invalid register');
          return;
        }
        if (activeAdapter && activeAdapter.ws !== ws) {
          ws.send(JSON.stringify({ type: 'error', message: 'Ja existe um adapter ativo.' }));
          ws.close(1008, 'adapter already active');
          return;
        }
        if (activeAdapter) return;
        activeAdapter = { ws, adapterId: msg.adapterId.trim(), label: msg.label.trim() };
        console.log('[agent] adapter registrado id=', activeAdapter.adapterId, 'label=', JSON.stringify(activeAdapter.label));
        broadcastAgentPresence();
        replayPending(ws);
        return;
      }

      // Batimento do adapter: "ainda estou trabalhando neste pedido". Rearma o
      // prazo da trava sem registrar nada — uma analise de verdade passa facil dos
      // 3 minutos, e sem isso o servidor derrubava o adapter no meio do trabalho.
      if (msg.type === 'progress') {
        if (!activeAdapter || activeAdapter.ws !== ws || typeof msg.requestId !== 'string') return;
        const busy = busyByRequest.get(msg.requestId);
        if (busy && busy.adapterWs === ws) armBusyTimer(msg.requestId, busy);
        return;
      }

      if (msg.type === 'accepted' || msg.type === 'completed' || msg.type === 'failed') {
        if (!activeAdapter || activeAdapter.ws !== ws || typeof msg.requestId !== 'string') return;
        const busy = busyByRequest.get(msg.requestId);
        const slug = requestSessionById.get(msg.requestId);
        if (!slug || !busy || busy.adapterWs !== ws) return;
        S.appendInbox(slug, {
          type: msg.type,
          protocol: 1,
          requestId: msg.requestId,
          at: new Date().toISOString(),
          ...(typeof msg.message === 'string' && msg.message ? { message: msg.message.slice(0, 4000) } : {}),
        });
        if (msg.type === 'completed' || msg.type === 'failed') {
          if (msg.type === 'failed') {
            const detail = typeof msg.message === 'string' && msg.message.trim() ? ': ' + msg.message.trim().slice(0, 300) : '';
            S.appendThread(slug, { author: 'system', text: 'O agente falhou ao processar o pedido' + detail, ts: Date.now() });
          }
          clearBusy(msg.requestId, ws);
          requestSessionById.delete(msg.requestId);
          dispatchNext(slug);
          clearTimeout(debounceTimers.get(slug));
          debounceTimers.delete(slug);
          // O mesmo state publica os arquivos que o agente acabou de gravar E
          // a trava final. Destravar antes deixava o browser editar o rev antigo.
          broadcastState(slug);
        }
      }
    });
    ws.send(JSON.stringify({ type: 'hello', protocol: 1 }));
    return;
  }

  // browser
  const slug = ws._session;
  S.ensureSession(slug);
  ensureWatcher(slug);
  if (!browsersBySession.has(slug)) browsersBySession.set(slug, new Set());
  browsersBySession.get(slug).add(ws);
  console.log('[browser] conectado session=', slug);

  // estado inicial (inclui busy, pra quem conecta durante o processamento)
  const st = safeReadState(slug);
  if (st) ws.send(statePayload(slug, st));
  ws.send(tasksPayload());
  ws.send(activityPayload());

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

    if (msg.type === 'patch' && msg.diagram) {
      // browser editou -> grava (rev++). fs.watch propaga pros demais.
      // Todo patch e lens-aware desde o FF-008. Patch sem `lens` era do editor
      // antigo: recusa em voz alta em vez de adivinhar a lente, porque escrever
      // no modelo errado e pior que nao escrever.
      if (isSessionBusy(slug)) {
        console.error('[patch] recusado: sessao ocupada pelo agente:', slug);
        const current = safeReadState(slug);
        if (current && ws.readyState === ws.OPEN) ws.send(statePayload(slug, current));
        return;
      }
      if (!msg.lens) { console.error('[patch] recusado: veio sem `lens` (cliente desatualizado?)'); return; }
      if (!S.isModelKey(msg.lens)) { console.error('[patch] lens desconhecida:', msg.lens); return; }
      // atencao: na lens 'seq' o payload e um SeqModel { participants, messages },
      // nao um Diagram — o campo se chama 'diagram' so por causa do protocolo.
      S.writeWorkspaceLens(slug, msg.lens, msg.diagram, 'user');
      return;
    }

    if (msg.type === 'analyze') {
      const note = String(msg.note || '').slice(0, 4000);
      const workspace = S.readWorkspace(slug);
      const at = new Date().toISOString();
      if (note) S.appendThread(slug, { author: 'user', text: note, ts: Date.now() });
      // Um arquivo, um rev. Antes do FF-008 este evento carregava tambem o
      // rev/title/path do diagram.json, e os dois revs andavam separados — era
      // fonte de confusao pro agente sobre qual somar.
      const event = {
        type: 'analyze',
        protocol: 1,
        requestId: crypto.randomUUID(),
        session: slug,
        note,
        at,
        workspacePath: S.workspacePath(slug),
        workspaceRev: workspace.rev,
        workspaceTitle: S.workspaceTitle(workspace),
        threadPath: S.threadPath(slug),
        projectPath: path.basename(S.getRoot()) === '.flowforge' ? path.dirname(S.getRoot()) : process.cwd(),
      };
      S.appendInbox(slug, event);
      const estavaBusy = isSessionBusy(slug);
      const dispatched = dispatchNext(slug);
      const status = dispatched ? 'online' : estavaBusy ? 'queued' : 'offline';
      console.log('[analyze] session=', slug, 'requestId=', event.requestId, 'adapter=', status);
      if (!dispatched && !estavaBusy) {
        S.appendThread(slug, { author: 'system', text: 'Agente offline; pedido salvo no inbox e pendente para reenvio.', ts: Date.now() });
      } else if (estavaBusy) {
        S.appendThread(slug, { author: 'system', text: 'Pedido salvo no inbox e enfileirado nesta sessao.', ts: Date.now() });
      }
      return;
    }

    if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
  });

  ws.on('close', () => {
    const set = browsersBySession.get(slug);
    if (set) set.delete(ws);
  });
  ws.on('error', () => {
    const set = browsersBySession.get(slug);
    if (set) set.delete(ws);
  });
});

// ---- start ----------------------------------------------------------------
restoreDispatchedBusy();
watchTasks();
if (INITIAL_SESSION) S.ensureSession(S.slugify(INITIAL_SESSION));
// Sem host -> dual-stack (:: com IPv4 mapeado): aceita tanto localhost=IPv6(::1)
// quanto 127.0.0.1. No Windows o Chrome resolve localhost pra ::1 primeiro, e
// bind so em 127.0.0.1 fazia o WebSocket falhar ("desconectado").
server.listen(PORT, () => {
  console.log('FlowForge server em http://localhost:' + PORT);
  console.log('  dados: ' + S.getRoot());
  if (INITIAL_SESSION) {
    const s = S.slugify(INITIAL_SESSION);
    console.log('  sessao inicial: ' + s);
    console.log('  editor: http://localhost:' + PORT + '/?session=' + s);
  }
  console.log('  agent WS: ws://localhost:' + PORT + '/agent');
  console.log('  alias legado: ws://localhost:' + PORT + '/claude');
});
