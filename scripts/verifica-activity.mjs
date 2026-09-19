#!/usr/bin/env node
// =============================================================================
// verifica-activity.mjs — a prova da linha do tempo (FF-035, 1a fatia).
//
// O caminho inteiro com as pecas de verdade: o comando que o hook do harness chama
// (adapters/activity.js hook claude-code) recebe payloads NO FORMATO REAL do Claude
// Code (chaves conferidas por sonda em 18/09/2026), grava o activity.jsonl, o
// servidor vigia e empurra `{type:'activity'}`. Confere:
//
//   1. cada ferramenta vira uma linha curta, com arquivo relativo ao projeto
//   2. a acao e carimbada com a tarefa in_progress de quem publica
//   3. NARRACAO, nao transcricao: pedido do usuario, comando cru e conteudo nao vazam
//   4. o hook nunca atrapalha: fora de projeto, payload torto, ferramenta muda -> exit 0, calado
//   5. a contabilidade do proprio FlowForge nao vira noticia
//   6. o browser recebe ao conectar e a cada acao; nao toca no workspace
//   7. install/uninstall mexem SO nas entradas do FlowForge no settings
//
// Uso: node scripts/verifica-activity.mjs      (exit 1 se algo falhar)
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'adapters', 'activity.js');
const TASKS = path.join(ROOT, 'adapters', 'tasks.js');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-activity-'));
const projectPath = path.join(tempRoot, 'projeto');
const dataDir = path.join(projectPath, '.flowforge');
fs.mkdirSync(path.join(projectPath, 'src'), { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
const semProjeto = path.join(tempRoot, 'outro-lugar');
fs.mkdirSync(semProjeto);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const envLimpo = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|OPENCODE|CODEX|FLOWFORGE_TASKS)/.test(k)));
const hook = (payload, raw) => spawnSync(process.execPath, [CLI, 'hook', 'claude-code'], { input: raw ?? JSON.stringify(payload), env: envLimpo, encoding: 'utf8' });
const run = (file, args, cwd = projectPath, env = {}) => spawnSync(process.execPath, [file, ...args], { cwd, env: { ...envLimpo, ...env }, encoding: 'utf8' });
const lines = () => { try { return fs.readFileSync(path.join(dataDir, 'activity.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; } };
const post = (tool_name, tool_input, extra = {}) => ({ session_id: 's1', transcript_path: 'x', cwd: path.join(projectPath, 'src'), prompt_id: 'p1', permission_mode: 'default', hook_event_name: 'PostToolUse', tool_name, tool_input, tool_response: {}, tool_use_id: 'toolu_1', duration_ms: 12, ...extra });

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function main() {
  const casos = [];
  const ok = (nome, cond) => casos.push([nome, !!cond]);
  const port = await freePort();
  const server = spawn(process.execPath, ['server/index.js', '--port', String(port), '--data-dir', dataDir], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  server.stdout.on('data', (c) => { out += c; });

  try {
    for (let i = 0; i < 50 && !out.includes('FlowForge server em'); i++) await sleep(100);
    assert.ok(out.includes('FlowForge server em'), 'servidor nao subiu');

    const browser = new WebSocket(`ws://127.0.0.1:${port}/ws?session=desenho`);
    let events = null;
    let state = null;
    browser.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.type === 'activity') events = m.events; if (m.type === 'state') state = m; });
    await new Promise((r) => browser.once('open', r));
    for (let i = 0; i < 50 && !(events && state); i++) await sleep(40);
    ok('browser recebe a linha do tempo ao conectar, mesmo vazia', Array.isArray(events) && events.length === 0);
    const revDesenho = state.workspace.rev;

    // uma tarefa em andamento, pra ter com o que carimbar
    run(TASKS, ['plan', 'Migrar o login', 'ler o codigo', 'trocar a lib'], projectPath, { CLAUDECODE: '1' });
    run(TASKS, ['start', '2'], projectPath, { CLAUDECODE: '1' });

    // ---- 1 e 2 ----
    hook(post('Read', { file_path: path.join(projectPath, 'src', 'auth.ts') }));
    hook(post('Edit', { file_path: path.join(projectPath, 'src', 'auth.ts'), old_string: 'SENHA=hunter2', new_string: 'x' }));
    hook(post('Write', { file_path: path.join(projectPath, 'NOVO.md'), content: 'CONTEUDO-SECRETO' }));
    hook(post('Bash', { command: 'curl -H "Authorization: Bearer TOKEN-ABC" https://api', description: 'Chama a API de login' }, { tool_response: { exitCode: 1 } }));
    hook(post('Bash', { command: 'npm test -- --watch=false' }));
    hook(post('Grep', { pattern: 'refreshToken', path: path.join(projectPath, 'src') }));
    hook(post('WebFetch', { url: 'https://docs.example.com/auth?key=SEGREDO-URL', prompt: 'x' }));
    hook(post('mcp__oracle__oracle_select', { sql: 'select * from SENHAS' }));
    hook(post('Read', { file_path: path.join(os.homedir(), '.ssh', 'id_rsa') }));
    let L = lines();
    ok('cada ferramenta vira uma linha', L.length === 9);
    ok('caminho relativo ao PROJETO, mesmo com o hook rodando de uma subpasta', L[0].summary === 'leu src/auth.ts' && L[0].files[0] === 'src/auth.ts' && L[0].kind === 'read');
    ok('Edit e Write viram "edit" com o arquivo', L[1].kind === 'edit' && L[1].summary === 'editou src/auth.ts' && L[2].summary === 'gravou NOVO.md');
    ok('Bash usa a DESCRICAO, nao o comando; exitCode != 0 marca falha', L[3].summary === 'Chama a API de login' && L[3].failed === true && L[3].kind === 'run');
    ok('Bash sem descricao mostra so programa + subcomando (comando cru pode ter segredo)', L[4].summary === 'rodou npm test …' && !L[4].failed);
    ok('Grep, WebFetch (so o host) e MCP (so servidor: ferramenta)', L[5].summary === 'buscou `refreshToken` em src' && L[6].summary === 'consultou docs.example.com' && L[7].summary === 'usou oracle: oracle_select');
    ok('arquivo fora do projeto nao expoe o caminho', L[8].summary === 'leu …/id_rsa');
    ok('toda acao carimbada com a tarefa in_progress do publicador', L.every((e) => e.task === 't2' && e.source === 'claude-code' && e.label === 'Claude Code'));

    // ---- 3. nada sensivel no arquivo ----
    hook({ cwd: projectPath, hook_event_name: 'UserPromptSubmit', prompt: 'PEDIDO-PRIVADO do usuario' });
    hook({ cwd: projectPath, hook_event_name: 'Stop', last_assistant_message: 'RESPOSTA-PRIVADA' });
    const bruto = fs.readFileSync(path.join(dataDir, 'activity.jsonl'), 'utf8');
    ok('pedido do usuario, resposta, conteudo, segredo de comando/URL/SQL NAO vazam', !/hunter2|CONTEUDO-SECRETO|TOKEN-ABC|SEGREDO-URL|SENHAS|PEDIDO-PRIVADO|RESPOSTA-PRIVADA/.test(bruto));
    L = lines();
    ok('pedido e fim de turno viram marcos sem texto', L.at(-2).kind === 'prompt' && L.at(-1).kind === 'stop' && L.length === 11);

    // ---- 4 e 5. o hook nunca atrapalha ----
    const n = lines().length;
    const fora = hook(post('Read', { file_path: 'x' }, { cwd: semProjeto }));
    const torto = hook(null, 'isto nao e json');
    const vazio = hook(null, '');
    ok('fora de projeto, payload torto e stdin vazio: exit 0, stdout/stderr vazios', [fora, torto, vazio].every((r) => r.status === 0 && !r.stdout && !r.stderr));
    ok('e nao cria .flowforge/ em projeto que nao usa', !fs.existsSync(path.join(semProjeto, '.flowforge')));

    // o ~/.flowforge e a pasta de ESTADO dos adapters, nao um projeto: um hook rodando em qualquer
    // pasta debaixo do HOME nao pode "achar" ele subindo a arvore e gravar la
    const casa = path.join(tempRoot, 'casa');
    const soltoNaCasa = path.join(casa, 'trabalho', 'sem-flowforge');
    fs.mkdirSync(path.join(casa, '.flowforge'), { recursive: true });
    fs.mkdirSync(soltoNaCasa, { recursive: true });
    const envCasa = { ...envLimpo, USERPROFILE: casa, HOME: casa };
    const naCasa = spawnSync(process.execPath, [CLI, 'hook', 'claude-code'],
      { input: JSON.stringify(post('Read', { file_path: 'x' }, { cwd: soltoNaCasa })), env: envCasa, encoding: 'utf8' });
    ok('a pasta de estado ~/.flowforge nao e confundida com o data-dir de um projeto',
      naCasa.status === 0 && !fs.existsSync(path.join(casa, '.flowforge', 'activity.jsonl')));
    hook(post('Bash', { command: 'node ' + TASKS + ' done 2' }));
    hook(post('Bash', { command: 'node C:/x/adapters/live.js done abc' }));
    hook(post('ToolSearch', { query: 'x' }));
    ok('contabilidade do FlowForge e ferramentas mudas nao viram noticia', lines().length === n);

    // ---- note ----
    const nota = run(CLI, ['note', 'decidi trocar a lib so depois do teste'], path.join(projectPath, 'src'), { CLAUDECODE: '1' });
    ok('note: o agente narra uma linha, carimbada com a tarefa', nota.status === 0 && lines().at(-1).kind === 'note' && lines().at(-1).task === 't2');

    // ---- 6. browser ----
    for (let i = 0; i < 60 && !(events && events.length === 12); i++) await sleep(50);
    ok('o browser recebe as acoes ao vivo, na ordem', events.length === 12 && events[0].summary === 'leu src/auth.ts' && events.at(-1).kind === 'note');
    const ws = JSON.parse(fs.readFileSync(path.join(dataDir, 'desenho', 'workspace.json'), 'utf8'));
    ok('a linha do tempo NAO sobe o rev do workspace', ws.rev === revDesenho);
    const api = await (await fetch(`http://127.0.0.1:${port}/api/activity`)).json();
    ok('GET /api/activity devolve o mesmo', api.events.length === 12);

    fs.appendFileSync(path.join(dataDir, 'activity.jsonl'), 'linha torta escrita a mao\n{"ts":"x"}\n');
    hook(post('Read', { file_path: path.join(projectPath, 'README.md') }));
    for (let i = 0; i < 60 && !(events && events.length === 13); i++) await sleep(50);
    ok('linha torta no arquivo e pulada, nao derruba a leitura', events.length === 13 && events.at(-1).summary === 'leu README.md');

    // ---- 7. install / uninstall ----
    const settings = path.join(projectPath, '.claude', 'settings.local.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ permissions: { allow: ['Bash(git *)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo do-usuario' }] }] } }));
    ok('install roda', run(CLI, ['install', 'claude-code'], path.join(projectPath, 'src')).status === 0);
    run(CLI, ['install', 'claude-code']); // de novo: nao pode duplicar
    let s = JSON.parse(fs.readFileSync(settings, 'utf8'));
    ok('install liga os 3 eventos, assincrono, sem duplicar ao reinstalar', ['PostToolUse', 'UserPromptSubmit', 'Stop'].every((ev) =>
      s.hooks[ev].filter((g) => g.hooks.some((h) => /adapters\/activity\.js" hook claude-code$/.test(h.command) && h.async === true)).length === 1));
    ok('install preserva permissoes e hooks do usuario', s.permissions.allow[0] === 'Bash(git *)' && s.hooks.Stop.some((g) => g.hooks[0].command === 'echo do-usuario'));
    run(CLI, ['uninstall', 'claude-code']);
    s = JSON.parse(fs.readFileSync(settings, 'utf8'));
    ok('uninstall tira SO o do FlowForge', !s.hooks.PostToolUse && s.hooks.Stop.length === 1 && s.hooks.Stop[0].hooks[0].command === 'echo do-usuario' && s.permissions.allow.length === 1);

    browser.close();
  } finally {
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
