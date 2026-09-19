#!/usr/bin/env node
// =============================================================================
// verifica-codex.mjs — a prova da parte do Codex (issue #11). Nao gasta token.
//
// Duas pecas, com as pecas de verdade:
//
//   adapters/hooks/codex.js    a linha do tempo. Os payloads daqui estao no FORMATO REAL
//                              do hook do Codex, copiados de uma sonda na versao 0.154.0
//                              (CODEX_HOME temporario, hooks.json despejando o stdin).
//   adapters/deliver/codex.js  a entrega do "Analisar" na sessao aberta, por `codex queue`.
//                              Aqui o `codex` e um executavel falso que so anota o argv:
//                              o que se prova e a LINHA DE COMANDO, nao o CLI da OpenAI.
//
// Confere:
//   1. cada ferramenta do Codex vira uma linha curta, com arquivo relativo ao projeto
//   2. NARRACAO, nao transcricao: pedido, fala do agente, conteudo do patch e saida nao vazam
//   3. o hook anota o thread da sessao — e dai que a entrega sabe onde entregar
//   4. o hook nunca atrapalha: fora de projeto, payload torto -> exit 0, calado
//   5. install/uninstall mexem SO no que e do FlowForge no hooks.json do Codex
//   6. a entrega monta `codex queue --thread <id> --message <uma linha>` e propaga a falha
//
// Uso: node scripts/verifica-codex.mjs      (exit 1 se algo falhar)
// =============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'adapters', 'activity.js');
const require_ = createRequire(import.meta.url);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-codex-'));
const projectPath = path.join(tempRoot, 'projeto');
const dataDir = path.join(projectPath, '.flowforge');
const semProjeto = path.join(tempRoot, 'outro-lugar');
const codexHome = path.join(tempRoot, 'codex-home');
const threadsFile = path.join(tempRoot, 'codex-threads.json');
fs.mkdirSync(path.join(projectPath, 'src'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'desenho'), { recursive: true });
fs.mkdirSync(semProjeto);
fs.mkdirSync(codexHome);

const envLimpo = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|OPENCODE|CODEX|FLOWFORGE)/.test(k)));
const hookEnv = { ...envLimpo, FLOWFORGE_CODEX_THREADS: threadsFile };
const hook = (payload, raw) => spawnSync(process.execPath, [CLI, 'hook', 'codex'], { input: raw ?? JSON.stringify(payload), env: hookEnv, encoding: 'utf8' });
const run = (args, cwd = projectPath, env = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...hookEnv, ...env }, encoding: 'utf8' });
const lines = () => { try { return fs.readFileSync(path.join(dataDir, 'activity.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; } };

// Payload no formato real: o Codex manda esses campos em TODO evento.
const SID = '01a0ba39-7891-7832-922d-8db8f310584a';
const base = (extra) => ({
  session_id: SID, turn_id: '01a0ba39-7937-7640-8c52-639639ac5af9',
  transcript_path: path.join(codexHome, 'sessions', 'rollout.jsonl'),
  cwd: path.join(projectPath, 'src'), model: 'gpt-6-astra', permission_mode: 'bypassPermissions', ...extra,
});
const post = (tool_name, tool_input, tool_response = '') => base({ hook_event_name: 'PostToolUse', tool_name, tool_input, tool_response, tool_use_id: 'exec-ca9cfdc2' });
const patch = (corpo) => '*** Begin Patch\n' + corpo + '\n*** End Patch';

// ---- executavel falso no lugar do `codex` ------------------------------------
// Precisa ser um programa de verdade: o runProcess do core.js monta a linha e, no Windows,
// roda por shell — e isso que se quer provar.
const fakeJs = path.join(tempRoot, 'fake-codex.js');
fs.writeFileSync(fakeJs, [
  'const fs = require("fs");',
  'fs.writeFileSync(process.env.FF_FAKE_OUT, JSON.stringify(process.argv.slice(2)));',
  'if (process.env.FF_FAKE_FAIL) { process.stderr.write("thread nao existe"); process.exit(1); }',
  'process.stdout.write("Queued message 1 for thread x.");',
].join('\n'));
let fakeBin;
if (process.platform === 'win32') {
  fakeBin = path.join(tempRoot, 'fake-codex.cmd');
  fs.writeFileSync(fakeBin, '@echo off\r\nnode "' + fakeJs + '" %*\r\n');
} else {
  fakeBin = path.join(tempRoot, 'fake-codex');
  fs.writeFileSync(fakeBin, '#!/bin/sh\nexec node "' + fakeJs + '" "$@"\n');
  fs.chmodSync(fakeBin, 0o755);
}
const fakeOut = path.join(tempRoot, 'argv.json');

const evt = {
  requestId: '11111111-2222-4333-8444-555555555555', session: 'desenho', note: 'da uma olhada no fluxo',
  workspacePath: path.join(dataDir, 'desenho', 'workspace.json'),
  threadPath: path.join(dataDir, 'desenho', 'thread.json'),
  projectPath,
};

const casos = [];
const ok = (nome, cond) => casos.push([nome, !!cond]);

try {
  // ---- 1 e 2. a linha do tempo -------------------------------------------------
  hook(post('Bash', { command: 'Get-Content -LiteralPath src/segredos.txt' }, 'conteudo secreto: SENHA-PLANTADA\r\n'));
  hook(post('Bash', { command: 'curl -H Authorization:Bearer TOKEN-ABC https://api' }));
  hook(post('apply_patch', { command: patch('*** Update File: src/auth.ts\n@@\n-const SENHA = "hunter2"\n+const SENHA = process.env.X') }, 'Exit code: 0\nOutput:\nSuccess. Updated the following files:\nM src/auth.ts\n'));
  hook(post('apply_patch', { command: patch('*** Add File: NOVO.md\n+CONTEUDO-SECRETO') }, 'Exit code: 0\n'));
  hook(post('apply_patch', { command: patch('*** Delete File: src/velho.ts') }, 'Exit code: 1\nOutput:\nfalhou\n'));
  hook(post('apply_patch', { command: patch('*** Update File: ' + path.join(os.homedir(), '.ssh', 'config').replace(/\\/g, '/') + '\n@@\n-a\n+b') }));
  hook(post('mcp__oracle__oracle_select', { sql: 'select * from SENHAS' }));
  hook(post('web_search', { query: 'SEGREDO-DA-BUSCA' }));
  hook(post('update_plan', { plan: [] }));
  hook(base({ hook_event_name: 'UserPromptSubmit', prompt: 'PEDIDO-PRIVADO do usuario' }));
  hook(base({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'RESPOSTA-PRIVADA' }));

  const L = lines();
  ok('cada acao do Codex vira uma linha (update_plan nao e noticia)', L.length === 10);
  ok('Bash: so programa + subcomando, porque o comando cru pode ter segredo', L[0].summary === 'rodou Get-Content -LiteralPath …' && L[0].kind === 'run' && L[1].summary === 'rodou curl -H …');
  ok('apply_patch vira "editou <arquivo>", com o caminho relativo ao PROJETO', L[2].kind === 'edit' && L[2].summary === 'editou src/auth.ts' && L[2].files[0] === 'src/auth.ts' && !L[2].failed);
  ok('apply_patch que so cria e "gravou"; "Exit code" diferente de 0 marca falha', L[3].summary === 'gravou NOVO.md' && L[4].summary === 'apagou src/velho.ts' && L[4].failed === true);
  ok('arquivo fora do projeto nao expoe o caminho', L[5].summary === 'editou …/config');
  ok('MCP: so servidor e ferramenta; ferramenta desconhecida nao leva os argumentos', L[6].summary === 'usou oracle: oracle_select' && L[7].summary === 'usou web_search');
  ok('pedido e fim de turno viram marcos sem texto', L[8].kind === 'prompt' && L[9].kind === 'stop');
  ok('toda acao sai carimbada como Codex', L.every((e) => e.source === 'codex' && e.label === 'Codex'));

  const bruto = fs.readFileSync(path.join(dataDir, 'activity.jsonl'), 'utf8');
  ok('nada vaza: pedido, fala do agente, conteudo do patch, saida da ferramenta, segredo de comando/MCP/busca',
    !/SENHA-PLANTADA|TOKEN-ABC|hunter2|CONTEUDO-SECRETO|SENHAS|SEGREDO-DA-BUSCA|PEDIDO-PRIVADO|RESPOSTA-PRIVADA|Begin Patch/.test(bruto));

  // ---- 3. o hook anota o thread da sessao --------------------------------------
  const anotado = JSON.parse(fs.readFileSync(threadsFile, 'utf8'));
  const chave = Object.keys(anotado)[0];
  ok('o hook anota o thread da sessao, por projeto (e dai que a entrega sabe onde entregar)',
    Object.keys(anotado).length === 1 && anotado[chave].threadId === SID && chave.endsWith('/projeto'));

  // ---- 4. o hook nunca atrapalha -----------------------------------------------
  const n = lines().length;
  const fora = hook({ ...post('Bash', { command: 'ls' }), cwd: semProjeto });
  const torto = hook(null, 'isto nao e json');
  const vazio = hook(null, '');
  ok('fora de projeto, payload torto e stdin vazio: exit 0, stdout/stderr vazios', [fora, torto, vazio].every((r) => r.status === 0 && !r.stdout && !r.stderr));
  ok('e nao cria .flowforge/ em projeto que nao usa', !fs.existsSync(path.join(semProjeto, '.flowforge')));
  hook(post('Bash', { command: 'node ' + path.join(ROOT, 'adapters', 'tasks.js') + ' done 2' }));
  hook(post('Bash', { command: 'node /x/adapters/live.js done abc' }));
  ok('a contabilidade do proprio FlowForge nao vira noticia', lines().length === n);

  // ---- 5. install / uninstall ---------------------------------------------------
  const projHooks = path.join(projectPath, '.codex', 'hooks.json');
  fs.mkdirSync(path.dirname(projHooks), { recursive: true });
  fs.writeFileSync(projHooks, JSON.stringify({ description: 'do usuario', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo do-usuario' }] }] } }));
  ok('install roda de uma subpasta do projeto', run(['install', 'codex'], path.join(projectPath, 'src')).status === 0);
  run(['install', 'codex']); // de novo: nao pode duplicar
  let c = JSON.parse(fs.readFileSync(projHooks, 'utf8'));
  ok('install liga os 3 eventos no .codex/hooks.json, sem duplicar ao reinstalar', ['PostToolUse', 'UserPromptSubmit', 'Stop'].every((ev) =>
    c.hooks[ev].filter((g) => g.hooks.some((h) => h.type === 'command' && /adapters\/activity\.js" hook codex$/.test(String(h.command).replace(/\\/g, '/')))).length === 1));
  ok('install preserva o que e do usuario', c.description === 'do usuario' && c.hooks.Stop.some((g) => g.hooks[0].command === 'echo do-usuario'));
  run(['uninstall', 'codex']);
  c = JSON.parse(fs.readFileSync(projHooks, 'utf8'));
  ok('uninstall tira SO o do FlowForge', !c.hooks.PostToolUse && c.hooks.Stop.length === 1 && c.hooks.Stop[0].hooks[0].command === 'echo do-usuario' && c.description === 'do usuario');

  run(['install', 'codex', '--global'], projectPath, { CODEX_HOME: codexHome });
  const global = JSON.parse(fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8'));
  ok('--global escreve no hooks.json do CODEX_HOME', Object.keys(global.hooks).length === 3);
  run(['uninstall', 'codex', '--global'], projectPath, { CODEX_HOME: codexHome });
  ok('e o uninstall global limpa', !JSON.parse(fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8')).hooks);

  // ---- 6. a entrega na sessao aberta --------------------------------------------
  process.env.FLOWFORGE_CODEX_THREADS = threadsFile;
  process.env.FLOWFORGE_CODEX_BIN = fakeBin;
  process.env.FF_FAKE_OUT = fakeOut;
  delete process.env.FLOWFORGE_CODEX_THREAD;
  delete process.env.CODEX_THREAD_ID;
  const deliverer = require_(path.join(ROOT, 'adapters', 'deliver', 'codex.js'));

  ok('sem hook e sem variavel, a entrega diz o que falta em vez de inventar',
    deliverer.threadOf({ ...evt, projectPath: semProjeto }) === null);
  ok('o thread vem do que o hook anotou para ESTE projeto', deliverer.threadOf(evt) === SID);
  process.env.FLOWFORGE_CODEX_THREAD = 'mandado-por-variavel';
  ok('e a variavel manda em cima do hook', deliverer.threadOf(evt) === 'mandado-por-variavel');
  delete process.env.FLOWFORGE_CODEX_THREAD;

  const msg = deliverer.mensagem(evt);
  ok('a mensagem e UMA linha, sem aspas nem metacaractere de shell', !/[\r\n"'`^&|<>%$]/.test(msg));
  ok('e diz tudo que a sessao precisa: requestId, os dois arquivos, o reply.json e o done',
    msg.includes(evt.requestId) && msg.includes('workspace.json') && msg.includes('thread.json')
    && msg.includes('reply.json') && /adapters\/live\.js done 11111111-/.test(msg) && msg.includes('da uma olhada no fluxo'));
  const comUrl = deliverer.mensagem(evt, { url: 'ws://127.0.0.1:53685/agent' });
  ok('ponte fora da porta padrao manda a url junto (sem ela o done nao acha a ponte e o canvas trava)',
    /done 11111111-2222-4333-8444-555555555555 --url ws:\/\/127\.0\.0\.1:53685\/agent/.test(comUrl));

  await deliverer.deliver({ evt });
  const argv = JSON.parse(fs.readFileSync(fakeOut, 'utf8'));
  ok('a entrega chama `codex queue --thread <thread> --message <uma linha>`',
    argv[0] === 'queue' && argv[1] === '--thread' && argv[2] === SID && argv[3] === '--message' && argv[4].includes(evt.requestId) && argv.length === 5);

  process.env.FF_FAKE_FAIL = '1';
  let erro = null;
  await deliverer.deliver({ evt }).catch((e) => { erro = e; });
  ok('queue que falha vira erro com o motivo, nao silencio', erro && /codex queue saiu com codigo 1/.test(erro.message) && /thread nao existe/.test(erro.message));
  delete process.env.FF_FAKE_FAIL;

  let semThread = null;
  await deliverer.deliver({ evt: { ...evt, projectPath: semProjeto } }).catch((e) => { semThread = e; });
  ok('sem sessao conhecida a entrega falha explicando como resolver', semThread && /FLOWFORGE_CODEX_THREAD/.test(semThread.message));
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

let falhas = 0;
for (const [nome, passou] of casos) {
  console.log((passou ? '   ok    ' : '   FALHA ') + nome);
  if (!passou) falhas++;
}
console.log(falhas ? `\nVEREDITO: FALHA — ${falhas} de ${casos.length}` : `\nVEREDITO: OK — ${casos.length} casos`);
process.exit(falhas ? 1 : 0);
