#!/usr/bin/env node
'use strict';
// FlowForge bridge server.
//   - serve o editor (web/) via HTTP
//   - WS /ws?session=<slug>  -> browsers (editam e recebem updates ao vivo)
//   - WS /claude             -> Monitor do Claude (recebe eventos de "Analisar")
//   - fs.watch nas sessoes   -> quando um arquivo muda (browser OU Claude), empurra o estado pros browsers
//
// Arquivos sao a fonte da verdade. O Claude edita sessions/<slug>/diagram.json
// diretamente; o fs.watch propaga a mudanca pro canvas sem refresh manual.

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { WebSocketServer } = require('ws');
const S = require('./state');

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

const WEB_DIR = path.join(__dirname, '..', 'web');

// ---- estado em memoria ----------------------------------------------------
const browsersBySession = new Map(); // slug -> Set<ws>
const claudeClients = new Set();      // Set<ws> (conexoes Monitor)
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

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(WEB_DIR, rel));
  if (!filePath.startsWith(WEB_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const headers = { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' };
    // assets que mudam (o app em si) nunca sao cacheados -> sem Ctrl+Shift+R.
    // libs vendorizadas podem cachear (nao mudam).
    headers['Cache-Control'] = rel.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-store';
    res.writeHead(200, headers);
    res.end(buf);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ---- leitura segura (ignora escrita parcial) ------------------------------
function safeReadState(slug) {
  try {
    const diagram = JSON.parse(fs.readFileSync(S.diagramPath(slug), 'utf8'));
    let thread = { messages: [] };
    try { thread = JSON.parse(fs.readFileSync(S.threadPath(slug), 'utf8')); } catch (e) {}
    return { diagram, thread };
  } catch (e) {
    return null; // arquivo no meio de um rename/escrita — outro evento vira
  }
}

// ---- estado "Claude pensando" (trava de edicao no browser) ----------------
// Enquanto pensa, os browsers ficam em modo leitura (ver/navegar sim, editar
// nao) — mata a corrida de sincronia. Liga ao despachar "analyze" pro Claude;
// desliga quando o Claude posta a resposta no thread (passo final do contrato)
// ou por timeout de seguranca.
const BUSY_TIMEOUT_MS = 180000;
const busyBySession = new Map(); // slug -> { timer, baseClaude }

function claudeCount(st) { return ((st && st.thread && st.thread.messages) || []).filter((m) => m.author === 'claude').length; }
function broadcastBusy(slug) {
  const set = browsersBySession.get(slug);
  if (!set) return;
  const payload = JSON.stringify({ type: 'busy', session: slug, busy: busyBySession.has(slug) });
  for (const ws of set) { if (ws.readyState === ws.OPEN) ws.send(payload); }
}
function setBusy(slug) {
  const prev = busyBySession.get(slug);
  if (prev) clearTimeout(prev.timer);
  const timer = setTimeout(() => { busyBySession.delete(slug); broadcastBusy(slug); }, BUSY_TIMEOUT_MS);
  busyBySession.set(slug, { timer, baseClaude: claudeCount(safeReadState(slug)) });
  broadcastBusy(slug);
}
function clearBusy(slug) {
  const b = busyBySession.get(slug);
  if (!b) return;
  clearTimeout(b.timer);
  busyBySession.delete(slug);
  broadcastBusy(slug);
}

// ---- broadcast ------------------------------------------------------------
function broadcastState(slug) {
  const set = browsersBySession.get(slug);
  if (!set || set.size === 0) return;
  const st = safeReadState(slug);
  if (!st) return;
  // Claude terminou? nova mensagem dele no thread -> destrava.
  const b = busyBySession.get(slug);
  if (b && claudeCount(st) > b.baseClaude) clearBusy(slug);
  const payload = JSON.stringify({ type: 'state', session: slug, diagram: st.diagram, thread: st.thread, busy: busyBySession.has(slug) });
  for (const ws of set) { if (ws.readyState === ws.OPEN) ws.send(payload); }
}

function pushToClaude(event) {
  const payload = JSON.stringify(event);
  for (const ws of claudeClients) { if (ws.readyState === ws.OPEN) ws.send(payload); }
  return claudeClients.size;
}

// ---- fs.watch por sessao --------------------------------------------------
function ensureWatcher(slug) {
  if (watchers.has(slug)) return;
  const dir = S.sessionDir(slug);
  try {
    const w = fs.watch(dir, (evt, filename) => {
      if (!filename) return;
      const f = String(filename);
      if (f !== 'diagram.json' && f !== 'thread.json') return;
      clearTimeout(debounceTimers.get(slug));
      debounceTimers.set(slug, setTimeout(() => broadcastState(slug), 80));
    });
    watchers.set(slug, w);
  } catch (e) {
    console.error('[watch] falhou em', slug, e.message);
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

  if (pathname === '/api/health') return sendJson(res, 200, { ok: true, port: PORT, dataDir: S.getRoot() });

  return serveStatic(req, res, pathname);
});

// ---- WebSocket ------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  if (pathname === '/ws' || pathname === '/claude') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws._kind = pathname === '/claude' ? 'claude' : 'browser';
      ws._session = S.slugify(parsed.query.session || INITIAL_SESSION || 'sessao');
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  if (ws._kind === 'claude') {
    claudeClients.add(ws);
    console.log('[claude] Monitor conectado. total=', claudeClients.size);
    ws.on('close', () => claudeClients.delete(ws));
    ws.on('error', () => claudeClients.delete(ws));
    ws.send(JSON.stringify({ kind: 'hello', msg: 'FlowForge conectado. Voce recebera eventos "analyze" aqui.' }));
    return;
  }

  // browser
  const slug = ws._session;
  S.ensureSession(slug);
  ensureWatcher(slug);
  if (!browsersBySession.has(slug)) browsersBySession.set(slug, new Set());
  browsersBySession.get(slug).add(ws);
  console.log('[browser] conectado session=', slug);

  // estado inicial (inclui busy, pra quem conecta durante o "pensando")
  const st = safeReadState(slug);
  if (st) ws.send(JSON.stringify({ type: 'state', session: slug, diagram: st.diagram, thread: st.thread, busy: busyBySession.has(slug) }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

    if (msg.type === 'patch' && msg.diagram) {
      // browser editou -> grava (rev++). fs.watch propaga pros demais.
      S.writeDiagram(slug, msg.diagram, 'user');
      return;
    }

    if (msg.type === 'analyze') {
      const note = String(msg.note || '').slice(0, 4000);
      const diagram = S.readDiagram(slug);
      const at = new Date().toISOString();
      if (note) S.appendThread(slug, { author: 'user', text: note, ts: Date.now() });
      const event = {
        kind: 'analyze',
        session: slug,
        note,
        rev: diagram.rev,
        title: diagram.title,
        at,
        diagramPath: S.diagramPath(slug),
        threadPath: S.threadPath(slug),
        hint: 'Leia diagramPath + threadPath, rebata, e edite o diagram (rev+1, updatedBy:"claude").',
      };
      S.appendInbox(slug, event);
      const n = pushToClaude(event);
      console.log('[analyze] session=', slug, 'note=', JSON.stringify(note.slice(0, 60)), 'claudeClients=', n);
      if (n > 0) {
        setBusy(slug); // trava a edicao no browser ate o Claude responder
      } else {
        // feedback imediato no thread pro usuario ver que foi enviado
        S.appendThread(slug, { author: 'system', text: '(Claude offline — pedido salvo no inbox; sera lido quando o Monitor conectar.)', ts: Date.now() });
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
if (INITIAL_SESSION) S.ensureSession(S.slugify(INITIAL_SESSION));
// Sem host -> dual-stack (:: com IPv4 mapeado): aceita tanto localhost=IPv6(::1)
// quanto 127.0.0.1. No Windows o Chrome resolve localhost pra ::1 primeiro, e
// bind so em 127.0.0.1 fazia o WebSocket falhar ("desconectado").
server.listen(PORT, () => {
  console.log('FlowForge server em http://localhost:' + PORT);
  console.log('  dados: ' + S.getRoot());
  if (INITIAL_SESSION) {
    console.log('  sessao inicial: ' + S.slugify(INITIAL_SESSION));
    console.log('  editor: http://localhost:' + PORT + '/?session=' + S.slugify(INITIAL_SESSION));
  }
  console.log('  claude WS: ws://localhost:' + PORT + '/claude');
});
