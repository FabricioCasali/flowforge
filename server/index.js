#!/usr/bin/env node
'use strict';
// FlowForge bridge server.
//   - serve o editor antigo (web/, Cytoscape) em /          -> lei 1: nao pode parar
//   - serve o editor novo   (web-next/dist, React Flow) em /v2
//   - WS /ws?session=<slug>  -> browsers (editam e recebem updates ao vivo)
//   - WS /claude             -> Monitor do Claude (recebe eventos de "Analisar")
//   - fs.watch nas sessoes   -> quando um arquivo muda (browser OU Claude), empurra o estado pros browsers
//
// Arquivos sao a fonte da verdade. O Claude edita sessions/<slug>/workspace.json
// (ou o diagram.json antigo) diretamente; o fs.watch propaga a mudanca pro canvas
// sem refresh manual.
//
// Durante o porte os DOIS editores rodam ao mesmo tempo, cada um no seu arquivo:
//   /    -> web/       -> diagram.json    -> patch SEM lens  -> writeDiagram
//   /v2  -> web-next/  -> workspace.json  -> patch COM lens  -> writeWorkspaceLens
// Por isso o broadcast de 'state' leva os dois: 'diagram' (pro antigo) e
// 'workspace' (pro novo). Quando o antigo morrer, 'diagram' sai daqui.

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

const WEB_DIR = path.join(__dirname, '..', 'web');            // editor antigo (/)
const WEB_NEXT_DIR = path.join(__dirname, '..', 'web-next', 'dist'); // editor novo (/v2)

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

// /v2 -> web-next/dist (o editor novo). Rota separada de proposito: o / continua
// servindo o web/ antigo exatamente como sempre (lei 1). Como e uma SPA, uma rota
// que nao existe em disco cai no index.html — mas SO se parecer rota (sem extensao
// ou .html); asset faltando devolve 404 de verdade, senao um bundle quebrado viria
// disfarcado de HTML e o erro apareceria longe da causa.
// Tipos que so o build do Vite produz. Tabela separada de proposito: mexer no
// MIME compartilhado mudaria o Content-Type de arquivos servidos em / tambem.
const MIME_V2 = Object.assign({}, MIME, {
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.txt': 'text/plain; charset=utf-8',
});

function serveV2(req, res, pathname) {
  let rel = decodeURIComponent(pathname.slice('/v2'.length));
  if (rel === '' || rel === '/') rel = '/index.html';
  const filePath = path.normalize(path.join(WEB_NEXT_DIR, rel));
  if (!filePath.startsWith(WEB_NEXT_DIR)) { res.writeHead(403); return res.end('forbidden'); }

  fs.readFile(filePath, (err, buf) => {
    if (!err) {
      const headers = { 'Content-Type': MIME_V2[path.extname(filePath)] || 'application/octet-stream' };
      // o Vite versiona o nome dos assets (hash) -> pode cachear; o resto, nunca.
      headers['Cache-Control'] = rel.startsWith('/assets/') ? 'public, max-age=86400' : 'no-store';
      res.writeHead(200, headers);
      return res.end(buf);
    }
    const ext = path.extname(rel);
    if (ext && ext !== '.html') { res.writeHead(404); return res.end('not found'); }

    fs.readFile(path.join(WEB_NEXT_DIR, 'index.html'), (e2, html) => {
      if (e2) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('O editor novo ainda nao foi buildado.\n'
          + 'Rode: cd web-next && npm run build\n'
          + 'Esperado em: ' + WEB_NEXT_DIR + '\n'
          + 'O editor antigo continua em / (intocado).');
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
// Le os DOIS arquivos-verdade. Se um deles existe mas nao le (rename em curso),
// devolve null: o proximo evento do fs.watch tenta de novo. Devolver um estado
// meio-lido seria pior que nao devolver nada — o canvas apagaria a lente.
function safeReadState(slug) {
  let diagram;
  try {
    diagram = JSON.parse(fs.readFileSync(S.diagramPath(slug), 'utf8'));
  } catch (e) {
    return null; // arquivo no meio de um rename/escrita — outro evento vira
  }

  let workspace = null;
  try {
    workspace = JSON.parse(fs.readFileSync(S.workspacePath(slug), 'utf8'));
  } catch (e) {
    if (fs.existsSync(S.workspacePath(slug))) return null; // existe mas nao leu -> transitorio
  }

  let thread = { messages: [] };
  try { thread = JSON.parse(fs.readFileSync(S.threadPath(slug), 'utf8')); } catch (e) {}

  return { diagram, workspace: S.normalizeWorkspace(workspace), thread };
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
  for (const ws of set) { if (ws.readyState === ws.OPEN) ws.send(statePayload(slug, st)); }
}

// O payload de 'state' leva 'workspace' (editor novo) E 'diagram' (editor antigo).
// Os dois convivem ate o corte final; nenhum dos dois pode ficar cego.
function statePayload(slug, st) {
  return JSON.stringify({
    type: 'state',
    session: slug,
    workspace: st.workspace,
    diagram: st.diagram,
    thread: st.thread,
    busy: busyBySession.has(slug),
    claudeOnline: claudeClients.size > 0,
  });
}

// O browser precisa distinguir DUAS conexoes: a dele com o servidor e a do
// Claude (o Monitor no /claude). Mostrar so a primeira fez o Fabricio clicar
// "Analisar" vendo "conectado" e receber "Claude offline" — o pill mentia por
// omissao. Isto avisa todos os browsers quando um Monitor entra ou sai.
function broadcastClaudeOnline() {
  const payload = JSON.stringify({ type: 'claude', online: claudeClients.size > 0 });
  for (const set of browsersBySession.values()) {
    for (const ws of set) { if (ws.readyState === ws.OPEN) ws.send(payload); }
  }
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
      // workspace.json entrou aqui: sem isso a edicao do Claude no arquivo novo
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

  // editor novo. O redirect /v2 -> /v2/ existe pra base de assets fechar
  // (index.html referencia /v2/assets/...); sem a barra o browser resolveria na raiz.
  if (pathname === '/v2') {
    res.writeHead(302, { Location: '/v2/' + (parsed.search || '') });
    return res.end();
  }
  if (pathname.startsWith('/v2/')) return serveV2(req, res, pathname);

  // editor antigo: exatamente como sempre (lei 1)
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
    broadcastClaudeOnline();
    const sai = () => { claudeClients.delete(ws); broadcastClaudeOnline(); };
    ws.on('close', sai);
    ws.on('error', sai);
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
  if (st) ws.send(statePayload(slug, st));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

    if (msg.type === 'patch' && msg.diagram) {
      // browser editou -> grava (rev++). fs.watch propaga pros demais.
      // Quem manda 'lens' e o editor novo: grava SO aquele modelo dentro do
      // workspace. Quem nao manda e o editor antigo: continua gravando o
      // diagram.json inteiro, como sempre (lei 1).
      if (msg.lens) {
        if (!S.isModelKey(msg.lens)) { console.error('[patch] lens desconhecida:', msg.lens); return; }
        // atencao: na lens 'seq' o payload e um SeqModel { participants, messages },
        // nao um Diagram — o campo se chama 'diagram' so por causa do protocolo.
        S.writeWorkspaceLens(slug, msg.lens, msg.diagram, 'user');
      } else {
        S.writeDiagram(slug, msg.diagram, 'user');
      }
      return;
    }

    if (msg.type === 'analyze') {
      const note = String(msg.note || '').slice(0, 4000);
      const diagram = S.readDiagram(slug);
      const workspace = S.readWorkspace(slug);
      const at = new Date().toISOString();
      if (note) S.appendThread(slug, { author: 'user', text: note, ts: Date.now() });
      // 'rev'/'title'/'diagramPath' continuam falando do diagram.json enquanto o
      // editor antigo existir. 'workspaceRev' e o rev que o Claude precisa somar
      // quando escrever no arquivo novo — os dois revs andam separados.
      const event = {
        kind: 'analyze',
        session: slug,
        note,
        rev: diagram.rev,
        title: diagram.title,
        at,
        workspacePath: S.workspacePath(slug),
        workspaceRev: workspace.rev,
        workspaceTitle: S.workspaceTitle(workspace),
        diagramPath: S.diagramPath(slug),
        threadPath: S.threadPath(slug),
        hint: 'Leia workspacePath + threadPath, rebata, e edite o workspace: um dos 5 modelos '
          + '(process|state|er|mind|seq) com rev = workspaceRev+1 e updatedBy:"claude". '
          + 'diagramPath e o arquivo do editor antigo (/), ainda vivo — so mexa nele se o pedido for de la.',
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
    const s = S.slugify(INITIAL_SESSION);
    console.log('  sessao inicial: ' + s);
    console.log('  editor antigo: http://localhost:' + PORT + '/?session=' + s);
    console.log('  editor novo:   http://localhost:' + PORT + '/v2/?session=' + s);
  }
  console.log('  claude WS: ws://localhost:' + PORT + '/claude');
});
