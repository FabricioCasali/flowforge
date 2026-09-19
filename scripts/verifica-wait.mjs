#!/usr/bin/env node
// =============================================================================
// verifica-wait.mjs — a prova do rearme automatico da escuta (issue #12).
//
// No Claude Code a escuta do Analisar vivia na ferramenta Monitor, que expira em
// no maximo 30 min. O rearme passa a ser um hook `Stop` que roda `live.js wait`:
// um OUVINTE que sai 0 e calado quando nao ha o que fazer, e que, quando chega um
// pedido, escreve no stderr e sai com codigo 2 — e isso que acorda a sessao ociosa.
// Quem segura o socket do /agent e a PONTE, destacada, que o proprio `wait` sobe.
//
// Aqui nao ha token nem Claude Code: sobe o servidor real numa porta livre e
// confere, com processos de verdade:
//
//   a. projeto sem .flowforge/            -> wait sai 0 e calado
//   b. servidor de OUTRO projeto na porta -> wait sai 0 e calado
//   c. wait sobe a ponte, o canvas ve o agente online, e o Analisar faz o wait
//      sair com 2 e o texto certo no stderr ("nao e um erro" + requestId)
//   d. segundo wait simultaneo            -> sai 0 e calado
//   e. pedido que chega SEM ouvinte e entregue ao proximo wait
//   f. done aplica o reply.json, destrava o canvas, e a ponte continua viva
//   g. stop encerra a ponte e o canvas mostra o agente offline
//   h. /agent ocupado por outro adapter   -> wait sai 0 e calado, sem derrubar o outro
//
// Uso: node scripts/verifica-wait.mjs      (exit 1 se algo falhar)
// =============================================================================

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = path.join(ROOT, 'adapters', 'live.js');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-wait-'));
const projeto = path.join(tempRoot, 'projeto');
const dataDir = path.join(projeto, '.flowforge');
const outroData = path.join(tempRoot, 'outro', '.flowforge');
const semFf = path.join(tempRoot, 'sem-flowforge');
for (const d of [dataDir, outroData, semFf]) fs.mkdirSync(d, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const controlFile = (port) => path.join(os.homedir(), '.flowforge', 'live-' + port + '.json');

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function until(pred, what, timeout = 8000) {
  const t0 = Date.now();
  for (;;) {
    const v = await pred(); // serve pra predicado sincrono e pra um que consulta a ponte
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('timeout esperando ' + what);
    await sleep(50);
  }
}

function pega(port, rota) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: rota, method: 'GET' }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(2000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/** O /state da ponte que atende o servidor desta porta (ou null). */
async function estadoDaPonte(port) {
  let control;
  try { control = JSON.parse(fs.readFileSync(controlFile(port), 'utf8')); } catch (e) { return null; }
  const r = await pega(control.port, '/state');
  if (!r || r.status !== 200) return null;
  try { return { ...JSON.parse(r.text), controlPort: control.port }; } catch (e) { return null; }
}

/** Roda o ouvinte como o hook Stop roda: payload no stdin, stdout/stderr capturados. */
function abreWait(cwd, port) {
  const p = spawn(process.execPath, [LIVE, 'wait', '--port', String(port), '--label', 'Sessao de teste'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const r = { proc: p, out: '', err: '', code: null };
  p.stdout.on('data', (d) => { r.out += d; });
  p.stderr.on('data', (d) => { r.err += d; });
  r.fim = new Promise((res) => p.on('close', (c) => { r.code = c; res(r); }));
  p.stdin.end(JSON.stringify({ hook_event_name: 'Stop', session_id: 'teste', cwd, stop_hook_active: false }));
  return r;
}

async function esperaFim(r, ms, what) {
  const venceu = await Promise.race([r.fim, sleep(ms).then(() => null)]);
  if (!venceu) { r.proc.kill(); throw new Error('timeout esperando ' + what); }
  return r;
}

const calado = (r) => r.code === 0 && r.out.trim() === '' && r.err.trim() === '';

async function main() {
  const portaA = await freePort();
  const portaB = await freePort();
  const casos = [];
  const ok = (nome, cond) => casos.push([nome, !!cond]);
  let servidorOutro = null;
  let servidor = null;
  let outroAdapter = null;
  let pontePid = null;

  try {
    // ---- a. projeto sem .flowforge/ -------------------------------------------
    const a = await esperaFim(abreWait(semFf, portaA), 15000, 'o wait sem .flowforge');
    ok('projeto sem .flowforge/: o wait sai 0 e calado', calado(a));

    // ---- b. servidor de OUTRO projeto na porta --------------------------------
    servidorOutro = spawn(process.execPath, ['server/index.js', '--port', String(portaA), '--data-dir', outroData], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let outOutro = '';
    servidorOutro.stdout.on('data', (c) => { outOutro += c; });
    await until(() => outOutro.includes('FlowForge server em'), 'o servidor do outro projeto');
    const b = await esperaFim(abreWait(projeto, portaA), 15000, 'o wait com servidor alheio');
    ok('servidor de OUTRO projeto na porta: o wait sai 0 e calado', calado(b));
    ok('e nao subiu ponte nenhuma nessa porta', !fs.existsSync(controlFile(portaA)));
    servidorOutro.kill();
    servidorOutro = null;

    // ---- servidor deste projeto ----------------------------------------------
    servidor = spawn(process.execPath, ['server/index.js', '--port', String(portaB), '--data-dir', dataDir], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    servidor.stdout.on('data', (c) => { out += c; });
    await until(() => out.includes('FlowForge server em'), 'o servidor do projeto');

    const browser = new WebSocket(`ws://127.0.0.1:${portaB}/ws?session=viva`);
    let last = null;
    let agente = null;
    browser.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'state') { last = m; agente = m.agentOnline ? m.agentLabel : null; }
      if (m.type === 'agent') agente = m.online ? m.label : null;
      if (m.type === 'busy' && last) last = { ...last, busy: m.busy };
    });
    await until(() => last, 'o estado inicial no browser');

    // ---- c. o wait sobe a ponte ------------------------------------------------
    const w1 = abreWait(projeto, portaB);
    await until(() => agente === 'Sessao de teste', 'o canvas ver o agente online', 20000);
    ok('o wait sobe a ponte destacada e o canvas ve o agente online', true);
    const estado = await until(async () => {
      const s = await estadoDaPonte(portaB);
      return s && s.listener ? s : null;
    }, 'o ouvinte se pendurar no /next');
    ok('a ponte roda em modo wait e o ouvinte esta pendurado no /next', estado.mode === 'wait' && estado.listener === true);
    pontePid = estado.pid;

    // ---- d. segundo wait simultaneo -------------------------------------------
    const d = await esperaFim(abreWait(projeto, portaB), 15000, 'o segundo wait');
    ok('segundo wait com ouvinte vivo: sai 0 e calado', calado(d));
    ok('e o primeiro continua esperando', w1.code === null);

    // ---- c (fim). o Analisar acorda o ouvinte ---------------------------------
    const rev0 = last.workspace.rev;
    browser.send(JSON.stringify({ type: 'analyze', note: 'primeiro pedido pelo hook' }));
    await esperaFim(w1, 15000, 'o wait sair com o pedido');
    const id1 = (w1.err.match(/analisar ([0-9a-f-]{36})/) || [])[1];
    const sessDir = path.join(dataDir, 'viva');
    ok('o Analisar faz o wait sair com codigo 2', w1.code === 2);
    ok('o stderr diz LOGO NO COMECO que nao e um erro, e sim o clique no canvas',
      /^FLOWFORGE: NAO e um erro\./.test(w1.err.trim()) && /"Analisar"/.test(w1.err));
    ok('o stderr traz a linha do pedido com o requestId, a sessao e o dir',
      !!id1 && /sessao=viva/.test(w1.err) && w1.err.includes(sessDir.replace(/\\/g, '/')));
    ok('o stderr diz o que fazer: ler os dois arquivos, gravar o reply.json e rodar o done',
      /workspace\.json/.test(w1.err) && /thread\.json/.test(w1.err) && /reply\.json/.test(w1.err)
      && w1.err.includes('live.js done ' + id1));
    ok('o texto do despertar e curto (o harness corta aviso comprido)', w1.err.length < 800);
    ok('o wait nao escreve nada no stdout', w1.out.trim() === '');
    await until(() => last && last.busy, 'a trava do canvas');

    // ---- f. done aplica o reply e a ponte continua viva -----------------------
    fs.writeFileSync(path.join(sessDir, 'reply.json'), JSON.stringify({
      model: 'mind', message: 'Respondi depois do despertar.',
      addNodes: [{ id: 'w1', label: 'ideia do rearme' }],
    }));
    const r1 = spawnSync(process.execPath, [LIVE, 'done', id1, '--port', String(portaB)], { encoding: 'utf8' });
    ok('done depois do wait responde "concluido" e sai 0', r1.status === 0 && /concluido/.test(r1.stdout));
    await until(() => !last.busy && last.workspace.rev === rev0 + 1, 'o canvas destravado');
    ok('done aplica o reply.json: no novo, rev+1 e trava solta',
      last.workspace.mind.nodes.some((n) => n.id === 'w1') && last.thread.messages.at(-1).text === 'Respondi depois do despertar.');
    const vivaDepois = await estadoDaPonte(portaB);
    ok('e a ponte CONTINUA viva, sem ouvinte, para o proximo wait',
      vivaDepois && vivaDepois.pid === pontePid && vivaDepois.listener === false);

    // ---- e. pedido que chega SEM ouvinte --------------------------------------
    browser.send(JSON.stringify({ type: 'analyze', note: 'pedido sem ouvinte' }));
    await until(async () => {
      const s = await estadoDaPonte(portaB);
      return s && s.queued === 1;
    }, 'o pedido entrar na fila da ponte');
    const w3 = abreWait(projeto, portaB);
    await esperaFim(w3, 15000, 'o wait receber o pedido da fila');
    const id3 = (w3.err.match(/analisar ([0-9a-f-]{36})/) || [])[1];
    ok('pedido que chegou SEM ouvinte e entregue ao proximo wait', w3.code === 2 && !!id3 && id3 !== id1);
    const r3 = spawnSync(process.execPath, [LIVE, 'done', id3, '--message', 'ok', '--port', String(portaB)], { encoding: 'utf8' });
    await until(() => !last.busy, 'a trava do segundo pedido');
    ok('e o done desse pedido tambem fecha o ciclo', r3.status === 0);

    // ---- g. stop ---------------------------------------------------------------
    const rStop = spawnSync(process.execPath, [LIVE, 'stop', '--port', String(portaB)], { encoding: 'utf8' });
    await until(() => agente === null, 'o canvas ver o agente offline');
    ok('stop encerra a ponte e o canvas mostra o agente offline',
      rStop.status === 0 && !fs.existsSync(controlFile(portaB)) && agente === null);
    pontePid = null;

    // ---- h. /agent ocupado por outro adapter ----------------------------------
    outroAdapter = new WebSocket(`ws://127.0.0.1:${portaB}/agent`);
    outroAdapter.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'hello') outroAdapter.send(JSON.stringify({ type: 'register', protocol: 1, adapterId: 'monitor-antigo', label: 'Monitor antigo' }));
    });
    await until(() => agente === 'Monitor antigo', 'o outro adapter registrar');
    const h = await esperaFim(abreWait(projeto, portaB), 25000, 'o wait com o /agent ocupado');
    ok('/agent ocupado por outro adapter: o wait sai 0 e calado', calado(h));
    ok('e o outro adapter continua online (o wait nao disputa)',
      agente === 'Monitor antigo' && outroAdapter.readyState === WebSocket.OPEN);
    await until(() => !fs.existsSync(controlFile(portaB)), 'a ponte recusada se limpar', 10000);
    ok('a ponte recusada some e nao deixa arquivo de controle para tras', true);

    browser.close();
  } finally {
    if (outroAdapter) outroAdapter.close();
    if (pontePid) { try { process.kill(pontePid); } catch (e) { /* ja morreu */ } }
    for (const p of [portaA, portaB]) {
      try {
        const c = JSON.parse(fs.readFileSync(controlFile(p), 'utf8'));
        try { process.kill(c.pid); } catch (e) { /* ja morreu */ }
      } catch (e) { /* sem arquivo */ }
      try { fs.unlinkSync(controlFile(p)); } catch (e) { /* ja foi */ }
    }
    if (servidorOutro) servidorOutro.kill();
    if (servidor) servidor.kill();
    await sleep(300);
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
