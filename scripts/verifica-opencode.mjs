#!/usr/bin/env node
// =============================================================================
// verifica-opencode.mjs — a prova do OpenCode: sessao viva (adapters/deliver/opencode.js)
// e linha do tempo (adapters/hooks/opencode.js).
//
// Nao gasta token e nao precisa do OpenCode rodando: o servidor do OpenCode e um
// servidor HTTP falso, subido aqui, que guarda metodo, caminho e corpo de cada
// pedido. O resto e peca de verdade — o comando que o plugin chama
// (adapters/activity.js hook opencode) e a ponte (adapters/live.js) com o servidor
// do FlowForge no ar. Confere:
//
//   1. `map` com payloads no formato REAL do plugin (hooks e parametros conferidos
//      contra a 1.18.31): cada ferramenta vira uma linha curta e carimbada
//   2. NARRACAO, nao transcricao: os segredos plantados nos payloads nao chegam ao arquivo
//   3. install/uninstall: idempotentes, e nao encostam no que e do usuario
//   4. a entrega: POST /tui/append-prompt + /tui/submit-prompt, com o corpo certo, e um
//      texto que se explica sozinho (onde ler, onde gravar, como fechar)
//   5. a entrega por sessao (servidor sem TUI): POST /session/<id>/prompt_async
//   6. o bilhete que o plugin deixa e o que diz onde e o servidor
//   7. entrega que falha (servidor fora do ar) nao derruba a ponte, e e relatada
//
// Uso: node scripts/verifica-opencode.mjs      (exit 1 se algo falhar)
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
const CLI = path.join(ROOT, 'adapters', 'activity.js');
const TASKS = path.join(ROOT, 'adapters', 'tasks.js');
const LIVE = path.join(ROOT, 'adapters', 'live.js');
const HOOK = await import(new URL('../adapters/hooks/opencode.js', import.meta.url));

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-opencode-'));
const projectPath = path.join(tempRoot, 'projeto');
const dataDir = path.join(projectPath, '.flowforge');
fs.mkdirSync(path.join(projectPath, 'src'), { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const envLimpo = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|OPENCODE|CODEX|FLOWFORGE)/.test(k)));
const hook = (payload, raw) => spawnSync(process.execPath, [CLI, 'hook', 'opencode'], { input: raw ?? JSON.stringify(payload), env: envLimpo, encoding: 'utf8' });
const run = (file, args, cwd = projectPath, env = {}) => spawnSync(process.execPath, [file, ...args], { cwd, env: { ...envLimpo, ...env }, encoding: 'utf8' });
const lines = () => { try { return fs.readFileSync(path.join(dataDir, 'activity.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; } };
// o envelope que o plugin manda: conferido contra os hooks do @opencode-ai/plugin 1.18.31
const exec = (tool, args, extra = {}) => ({ hook: 'tool.execute.after', cwd: path.join(projectPath, 'src'), tool, sessionID: 'ses_1', callID: 'call_1', args, ...extra });

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function until(pred, what, timeout = 8000) {
  const t0 = Date.now();
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('timeout esperando ' + what);
    await sleep(40);
  }
}

/** O OpenCode falso: guarda o que chegou e responde como o de verdade (200 / 204). */
function fakeOpenCode(recebidos) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        const u = new URL(req.url, 'http://x');
        recebidos.push({ method: req.method, pathname: u.pathname, directory: u.searchParams.get('directory'), type: req.headers['content-type'] || '', raw });
        if (u.pathname.endsWith('/prompt_async')) { res.writeHead(204); return res.end(); }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('true');
      });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

const casos = [];
const ok = (nome, cond) => casos.push([nome, !!cond]);

async function main() {
  const port = await freePort();
  const url = `ws://127.0.0.1:${port}/agent`;
  const server = spawn(process.execPath, ['server/index.js', '--port', String(port), '--data-dir', dataDir], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  server.stdout.on('data', (c) => { out += c; });
  const recebidos = [];
  let oc = null;
  let bridge = null;
  const bilhete = path.join(HOOK.announceDir(), 'verifica-' + process.pid + '.json');

  try {
    await until(() => out.includes('FlowForge server em'), 'servidor do FlowForge');
    oc = await fakeOpenCode(recebidos);
    const ocUrl = 'http://127.0.0.1:' + oc.address().port;

    // ---- 1. map: cada ferramenta do OpenCode vira uma linha -------------------------
    run(TASKS, ['plan', 'Migrar o login', 'ler o codigo', 'trocar a lib'], projectPath, { FLOWFORGE_TASKS_LIST: 'opencode', FLOWFORGE_TASKS_LABEL: 'OpenCode' });
    run(TASKS, ['start', '2'], projectPath, { FLOWFORGE_TASKS_LIST: 'opencode', FLOWFORGE_TASKS_LABEL: 'OpenCode' });

    hook(exec('read', { filePath: path.join(projectPath, 'src', 'auth.ts'), offset: 0, limit: 200 }));
    hook(exec('edit', { filePath: path.join(projectPath, 'src', 'auth.ts'), oldString: 'SENHA=hunter2', newString: 'x' }));
    hook(exec('write', { filePath: path.join(projectPath, 'NOVO.md'), content: 'CONTEUDO-SECRETO' }));
    hook(exec('apply_patch', { patchText: '*** Begin Patch\n*** Update File: src/login.ts\n-const t = "TOKEN-NO-PATCH"\n*** Add File: src/novo.ts\n+ola\n*** End Patch' }));
    hook(exec('bash', { command: 'curl -H "Authorization: Bearer TOKEN-ABC" https://api', timeout: 120000 }, { failed: true }));
    hook(exec('bash', { command: 'npm test -- --watch=false' }));
    hook(exec('grep', { pattern: 'refreshToken', path: path.join(projectPath, 'src'), include: '*.ts' }));
    hook(exec('glob', { pattern: 'src/**/*.ts' }));
    hook(exec('webfetch', { url: 'https://docs.example.com/auth?key=SEGREDO-URL', format: 'text' }));
    hook(exec('websearch', { query: 'como girar refresh token' }));
    hook(exec('task', { description: 'revisar o login', prompt: 'PROMPT-PRIVADO do subagente', subagent_type: 'general' }));
    hook(exec('skill', { name: 'flowforge' }));
    hook(exec('notas_gravar', { texto: 'ANOTACAO-SECRETA', chave: 'k1' }));
    hook(exec('read', { filePath: path.join(os.homedir(), '.ssh', 'id_rsa') }));

    let L = lines();
    ok('cada ferramenta do OpenCode vira uma linha', L.length === 14);
    ok('read/edit/write: caminho relativo ao PROJETO, mesmo com o hook rodando de uma subpasta',
      L[0].summary === 'leu src/auth.ts' && L[0].files[0] === 'src/auth.ts' && L[1].summary === 'editou src/auth.ts' && L[2].summary === 'gravou NOVO.md');
    ok('apply_patch vira "editou" só com os arquivos do cabeçalho, nunca o corpo do patch',
      L[3].kind === 'edit' && L[3].summary === 'editou src/login.ts, src/novo.ts' && L[3].files.length === 2);
    ok('bash mostra só programa + subcomando (o bash do OpenCode não tem campo description)',
      L[4].summary === 'rodou curl -H …' && L[4].failed === true && L[5].summary === 'rodou npm test …' && !L[5].failed);
    ok('grep, glob, webfetch (só o host) e websearch', L[6].summary === 'buscou `refreshToken` em src'
      && L[7].summary === 'listou src/**/*.ts' && L[8].summary === 'consultou docs.example.com' && L[9].summary === 'pesquisou: como girar refresh token');
    ok('task narra a descrição, nunca o prompt; skill narra o nome', L[10].summary === 'delegou: revisar o login' && L[11].summary === 'usou a skill flowforge');
    ok('MCP no OpenCode (<servidor>_<ferramenta>): só o nome', L[12].summary === 'usou notas: gravar' && L[12].kind === 'tool');
    ok('arquivo fora do projeto não expõe o caminho', L[13].summary === 'leu …/id_rsa');
    ok('toda ação carimbada com a tarefa in_progress do publicador', L.every((e) => e.task === 't2' && e.source === 'opencode' && e.label === 'OpenCode'));

    // ---- 2. narracao, nao transcricao -----------------------------------------------
    hook({ hook: 'chat.message', cwd: projectPath, sessionID: 'ses_1' });
    hook({ hook: 'event', type: 'session.idle', cwd: projectPath, sessionID: 'ses_1' });
    const bruto = fs.readFileSync(path.join(dataDir, 'activity.jsonl'), 'utf8');
    ok('conteúdo, comando cru, token, segredo de URL, prompt de subagente e argumento de MCP NÃO vazam',
      !/hunter2|CONTEUDO-SECRETO|TOKEN-ABC|TOKEN-NO-PATCH|SEGREDO-URL|PROMPT-PRIVADO|ANOTACAO-SECRETA|Authorization/.test(bruto));
    L = lines();
    ok('pedido do usuário e fim de turno viram marcos sem texto', L.at(-2).kind === 'prompt' && L.at(-1).kind === 'stop' && L.length === 16);

    // ---- o hook nunca atrapalha ------------------------------------------------------
    const n = lines().length;
    const semProjeto = path.join(tempRoot, 'outro-lugar');
    fs.mkdirSync(semProjeto, { recursive: true });
    const fora = hook(exec('read', { filePath: 'x' }, { cwd: semProjeto }));
    const torto = hook(null, 'isto nao e json');
    const vazio = hook(null, '');
    ok('fora de projeto, payload torto e stdin vazio: exit 0, stdout/stderr vazios', [fora, torto, vazio].every((r) => r.status === 0 && !r.stdout && !r.stderr));
    hook(exec('bash', { command: 'node ' + TASKS + ' done 2' }));
    hook(exec('bash', { command: 'node /x/adapters/live.js done abc' }));
    hook(exec('todowrite', { todos: [{ content: 'PLANO-PRIVADO', status: 'pending' }] }));
    hook({ hook: 'event', type: 'message.part.updated', cwd: projectPath });
    ok('contabilidade do FlowForge, ferramentas mudas e evento fora da lista não viram notícia', lines().length === n);

    // ---- 3. install / uninstall ------------------------------------------------------
    const pluginDir = path.join(projectPath, '.opencode', 'plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'do-usuario.js'), 'export const Meu = async () => ({});\n');
    ok('install roda', run(CLI, ['install', 'opencode'], path.join(projectPath, 'src')).status === 0);
    const pluginFile = path.join(pluginDir, 'flowforge.js');
    const gerado = fs.readFileSync(pluginFile, 'utf8');
    ok('install escreve o plugin no .opencode/plugin/ do projeto, ESM e com os três ganchos',
      gerado.includes('flowforge:plugin') && /^export const FlowForge = async/m.test(gerado)
      && ['"tool.execute.after"', '"chat.message"', 'event:'].every((k) => gerado.includes(k)));
    ok('o plugin chama o hook por stdin e não manda saída de ferramenta',
      gerado.includes('"hook", "opencode"') && gerado.includes('p.stdin.end(JSON.stringify(payload))') && !gerado.includes('output.output'));
    run(CLI, ['install', 'opencode']); // de novo: idempotente
    ok('reinstalar dá o mesmo arquivo e preserva o plugin do usuário',
      fs.readFileSync(pluginFile, 'utf8') === gerado && fs.existsSync(path.join(pluginDir, 'do-usuario.js')));
    run(CLI, ['uninstall', 'opencode']);
    ok('uninstall tira SÓ o do FlowForge', !fs.existsSync(pluginFile) && fs.existsSync(path.join(pluginDir, 'do-usuario.js')));
    fs.writeFileSync(pluginFile, 'export const FlowForge = async () => ({}); // escrito a mao\n');
    const recusa = run(CLI, ['install', 'opencode']);
    ok('install recusa sobrescrever um flowforge.js que não é do FlowForge', recusa.status === 1 && /nao vou mexer/.test(recusa.stderr));
    fs.unlinkSync(pluginFile);

    // ---- 6. o bilhete: e dele que sai a URL do servidor -------------------------------
    fs.mkdirSync(HOOK.announceDir(), { recursive: true });
    fs.writeFileSync(bilhete, JSON.stringify({ url: ocUrl, pid: process.pid, directory: projectPath, worktree: projectPath, ts: Date.now() }));
    const morto = path.join(HOOK.announceDir(), 'verifica-morto-' + process.pid + '.json');
    fs.writeFileSync(morto, JSON.stringify({ url: 'http://127.0.0.1:1', pid: 2 ** 22 + 7, directory: projectPath, ts: Date.now() + 10000 }));
    const DELIVER = await import(new URL('../adapters/deliver/opencode.js', import.meta.url));
    const evtFalso = { requestId: 'r0', session: 's', note: 'x', projectPath, workspacePath: path.join(dataDir, 's', 'workspace.json') };
    ok('a ponte acha o servidor pelo bilhete do projeto, e joga fora bilhete de processo morto',
      DELIVER.alvo(evtFalso, { args: [] }).url === ocUrl && !fs.existsSync(morto));
    ok('FLOWFORGE_OPENCODE_URL e --opencode-url mandam mais que o bilhete',
      DELIVER.alvo(evtFalso, { args: ['--opencode-url', 'http://127.0.0.1:9'] }).url === 'http://127.0.0.1:9');

    // ---- 4. a entrega, com a ponte de verdade ----------------------------------------
    const browser = new WebSocket(`ws://127.0.0.1:${port}/ws?session=viva`);
    let last = null;
    let online = false;
    browser.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'state') { last = m; online = !!m.agentOnline; }
      if (m.type === 'agent') online = !!m.online; // a presenca do adapter vem por mensagem propria
    });
    await until(() => last, 'browser conectar');

    // Um adapter por vez: o servidor recusa o segundo. Entao trocar de ponte e derrubar a
    // anterior, esperar ela sair, e so entao subir a proxima.
    const ponte = async (extra) => {
      if (bridge) {
        bridge.kill();
        await until(() => bridge.exitCode !== null || bridge.signalCode !== null, 'a ponte anterior sair');
        await until(() => !online, 'o canvas ver o agente sair');
      }
      bridge = spawn(process.execPath, [LIVE, '--url', url, '--label', 'OpenCode', '--deliver', 'opencode'],
        { stdio: ['ignore', 'pipe', 'pipe'], env: { ...envLimpo, ...extra } });
      bridge.saida = [];
      let buf = '';
      bridge.stdout.on('data', (c) => { buf += c; const p = buf.split('\n'); buf = p.pop(); bridge.saida.push(...p.filter(Boolean)); });
      await until(() => online, 'o canvas ver a ponte');
      return bridge;
    };
    const pedir = async (note) => {
      const k = bridge.saida.length;
      browser.send(JSON.stringify({ type: 'analyze', note }));
      const linha = await until(() => bridge.saida.slice(k).find((l) => l.startsWith('FLOWFORGE analisar ')), 'linha do pedido');
      await until(() => last.busy, 'a trava do canvas');
      return linha.split(' ')[2];
    };
    const fechar = (args) => spawnSync(process.execPath, [LIVE, 'done', ...args, '--url', url], { encoding: 'utf8' });

    await ponte({ FLOWFORGE_OPENCODE_URL: ocUrl });
    const id1 = await pedir('o nó de login está certo?');
    await until(() => recebidos.length >= 2, 'os dois POSTs da entrega');
    const [append, submit] = recebidos;
    ok('a entrega é POST /tui/append-prompt com {"text": …} em JSON',
      append.method === 'POST' && append.pathname === '/tui/append-prompt' && /application\/json/.test(append.type)
      && typeof JSON.parse(append.raw).text === 'string');
    ok('e POST /tui/submit-prompt logo depois, sem corpo', submit.method === 'POST' && submit.pathname === '/tui/submit-prompt' && submit.raw === '');
    const texto = JSON.parse(append.raw).text;
    ok('o texto se explica sozinho: nota, os dois arquivos, o reply.json e o comando que fecha',
      texto.includes('o nó de login está certo?') && texto.includes('workspace.json') && texto.includes('thread.json')
      && texto.includes('reply.json') && texto.includes('"model"') && texto.includes('adapters/live.js done ' + id1));
    ok('o texto é um pedido, não um despejo: cabe numa tela', texto.length < 1600);

    const fecha = fechar([id1, '--message', 'respondi do OpenCode']);
    await until(() => !last.busy, 'canvas destravado');
    ok('o fechamento não mudou: live.js done solta a trava', fecha.status === 0 && /concluido/.test(fecha.stdout));

    // ---- 5. entrega por sessao (servidor sem TUI) -------------------------------------
    recebidos.length = 0;
    await ponte({ FLOWFORGE_OPENCODE_URL: ocUrl, FLOWFORGE_OPENCODE_SESSION: 'ses_abc' });
    const id2 = await pedir('sem TUI');
    await until(() => recebidos.length >= 1, 'o POST por sessão');
    ok('com sessão forçada a entrega vira POST /session/<id>/prompt_async com parts[0].text',
      recebidos[0].method === 'POST' && recebidos[0].pathname === '/session/ses_abc/prompt_async'
      && JSON.parse(recebidos[0].raw).parts[0].type === 'text' && JSON.parse(recebidos[0].raw).parts[0].text.includes(id2));
    fechar([id2, '--message', 'ok']);
    await until(() => !last.busy, 'segunda trava solta');

    // ---- 7. servidor do OpenCode fora do ar ------------------------------------------
    const morta = await freePort();
    await ponte({ FLOWFORGE_OPENCODE_URL: 'http://127.0.0.1:' + morta });
    const id3 = await pedir('OpenCode fechado');
    const erro = await until(() => bridge.saida.find((l) => l.startsWith('FLOWFORGE erro: a entrega')), 'o aviso de falha');
    ok('entrega que falha é relatada no stdout da ponte, com o nome do módulo', /a entrega por "opencode" falhou/.test(erro));
    ok('e a ponte continua viva', bridge.exitCode === null);
    const r3 = fechar([id3, '--failed', 'o OpenCode estava fechado']);
    await until(() => !last.busy, 'trava solta mesmo sem entrega');
    ok('e o pedido ainda pode ser fechado à mão: a trava não fica presa',
      r3.status === 1 && last.thread.messages.some((t) => /OpenCode estava fechado/.test(t.text)));

    browser.close();
  } finally {
    for (const p of [bridge]) { if (p) p.kill(); }
    if (oc) oc.close();
    server.kill();
    await sleep(300);
    try { fs.unlinkSync(bilhete); } catch (e) { /* ja foi */ }
    try { fs.unlinkSync(path.join(os.homedir(), '.flowforge', 'live-' + port + '.json')); } catch (e) { /* a ponte limpou */ }
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
