// Traduz o payload de um hook do Codex (stdin JSON) numa acao da linha do tempo.
// Campos conferidos por sonda na versao codex-cli 0.154.0 (hooks e feature `stable`):
//   comuns      session_id, transcript_path, cwd, hook_event_name, model, permission_mode
//   por turno   turn_id
//   PostToolUse tool_name, tool_input, tool_response, tool_use_id
//   UserPromptSubmit  prompt          Stop  stop_hook_active, last_assistant_message
// Doc: https://developers.openai.com/codex/hooks (redireciona para learn.chatgpt.com/docs/hooks)
//
// Devolve { kind, summary, files?, failed? } ou null (acao que nao vale narrar).
// NARRACAO, nao transcricao: nunca o texto do pedido do usuario, nunca a fala final do
// agente, nunca o conteudo do patch, nunca a saida da ferramenta.
//
// Duas ferramentas foram vistas de verdade na sonda: `Bash` (no Windows o Codex manda uma
// linha de PowerShell em tool_input.command) e `apply_patch` (tool_input.command e o
// envelope do patch INTEIRO — dele so sai o NOME dos arquivos). O resto cai no generico.

const fs = require('fs');
const os = require('os');
const path = require('path');

const SOURCE = { id: 'codex', label: 'Codex' };
const EVENTS = ['PostToolUse', 'UserPromptSubmit', 'Stop'];

function rel(projectDir, file) {
  if (typeof file !== 'string' || !file) return null;
  const r = path.relative(projectDir, path.resolve(projectDir, file)).replace(/\\/g, '/');
  return r.startsWith('..') ? '…/' + path.basename(file) : r || path.basename(file);
}
const short = (s, n = 90) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

// ---- de qual sessao do Codex veio isto ---------------------------------------
// O `session_id` do payload E o thread id que o `codex queue --thread` aceita (conferido:
// o id que saiu do hook foi aceito pelo queue). Guardar isso e o que permite ao
// adapters/deliver/codex.js entregar o "Analisar" na sessao que ja esta aberta. Fica no
// HOME, como o adapter-state: e da maquina, e a pasta .flowforge/ vai junto com o projeto.
const threadsFile = () => process.env.FLOWFORGE_CODEX_THREADS || path.join(os.homedir(), '.flowforge', 'codex-threads.json');
const keyOf = (dir) => path.resolve(dir).replace(/\\/g, '/').toLowerCase();

function readThreads() {
  try { return JSON.parse(fs.readFileSync(threadsFile(), 'utf8')); } catch (e) { return {}; }
}

/** O thread id da ultima sessao do Codex vista neste projeto, ou null. */
function readThread(projectDir) {
  if (!projectDir) return null;
  const entry = readThreads()[keyOf(projectDir)];
  return (entry && entry.threadId) || null;
}

/** Anota o thread id do projeto. So escreve quando mudou: o hook roda a cada acao. */
function rememberThread(projectDir, threadId) {
  if (!projectDir || !/^[0-9a-fA-F-]{16,64}$/.test(String(threadId || ''))) return;
  const all = readThreads();
  const key = keyOf(projectDir);
  if (all[key] && all[key].threadId === threadId) return;
  all[key] = { threadId, at: new Date().toISOString() };
  const file = threadsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
}

// ---- a traducao ---------------------------------------------------------------
/** Os arquivos citados no envelope de um apply_patch — o NOME, nunca o conteudo. */
function patchedFiles(command) {
  const out = [];
  for (const raw of String(command || '').split(/\r?\n/)) {
    const m = raw.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/) || raw.match(/^\*\*\* (Move) to: (.+)$/);
    if (m) out.push({ op: m[1], file: m[2].trim() });
  }
  return out;
}

/**
 * Falhou? So quando da pra saber SEM guardar a saida. O `Bash` do Codex devolve a saida
 * crua, sem codigo de retorno — nesses casos fica indefinido, e e assim mesmo: inventar
 * um "falhou" a partir do texto seria adivinhar (e mexer no texto e transcricao).
 */
function didFail(response) {
  if (response && typeof response === 'object') {
    return (response.is_error === true || (Number.isFinite(response.exitCode) && response.exitCode !== 0)) || undefined;
  }
  if (typeof response === 'string') {
    const m = response.match(/^Exit code: (\d+)/);
    if (m) return m[1] !== '0' || undefined;
  }
  return undefined;
}

function map(payload, projectDir) {
  const event = payload.hook_event_name;
  rememberThread(projectDir, payload.session_id);

  if (event === 'UserPromptSubmit') return { kind: 'prompt', summary: 'recebeu um pedido do usuário' };
  if (event === 'Stop') return { kind: 'stop', summary: 'terminou o turno' };
  if (event !== 'PostToolUse') return null;

  const tool = String(payload.tool_name || '');
  const input = payload.tool_input || {};
  const failed = didFail(payload.tool_response);

  if (tool === 'Bash' || tool === 'shell' || tool === 'local_shell') {
    const cmd = String(input.command || '');
    // a contabilidade do proprio FlowForge nao e noticia
    if (/adapters[\\/](tasks|activity|live)\.js/.test(cmd)) return null;
    // Sem descricao, so o programa e o subcomando: o comando cru pode carregar segredo
    // (token em header, senha em URL), e isto aqui vai pra um arquivo do projeto.
    const words = cmd.trim().split(/\s+/);
    const bare = words.slice(0, 2).join(' ') + (words.length > 2 ? ' …' : '');
    return { kind: 'run', summary: input.description ? short(input.description) : 'rodou ' + bare, failed };
  }

  if (tool === 'apply_patch') {
    const touched = patchedFiles(input.command);
    if (!touched.length) return { kind: 'edit', summary: 'aplicou um patch', failed };
    const files = touched.map((t) => rel(projectDir, t.file)).filter(Boolean);
    if (!files.length) return { kind: 'edit', summary: 'aplicou um patch', failed };
    const verbo = touched.every((t) => t.op === 'Delete') ? 'apagou ' : touched.every((t) => t.op === 'Add') ? 'gravou ' : 'editou ';
    const mostra = files.slice(0, 3).join(', ') + (files.length > 3 ? ' …' : '');
    return { kind: 'edit', summary: verbo + mostra, files, failed };
  }

  // Ferramentas que sao andamento do proprio Codex, nao acao no projeto: a lente Tarefas
  // ja mostra o plano, e repetir aqui so faz barulho.
  if (tool === 'update_plan' || tool === 'view_image') return null;

  const mcp = tool.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) return { kind: 'tool', summary: 'usou ' + mcp[1] + ': ' + mcp[2], failed };
  return tool ? { kind: 'tool', summary: 'usou ' + short(tool, 50), failed } : null;
}

/**
 * Liga (ou tira) o hook na configuracao do Codex. O Codex le hooks de um `hooks.json` —
 * JSON, nao TOML: `<projeto>/.codex/hooks.json`, ou `$CODEX_HOME/hooks.json` (na falta da
 * variavel, `~/.codex/hooks.json`) com `global`. Reinstalar nao duplica; `remove` tira SO
 * o que e do FlowForge.
 */
const MARK = 'adapters/activity.js';
const isOurs = (group) => (group.hooks || []).some((h) => String(h.command || '').replace(/\\/g, '/').includes(MARK));
const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

function install({ global, remove, projectDir, scriptPath }) {
  const file = global ? path.join(codexHome(), 'hooks.json') : path.join(projectDir, '.codex', 'hooks.json');
  let config = {};
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new Error(file + ' nao e JSON valido; nao vou mexer'); }
  config.hooks = config.hooks || {};
  const entries = hookEntries('node "' + scriptPath + '" hook ' + SOURCE.id);
  for (const ev of EVENTS) {
    const kept = (config.hooks[ev] || []).filter((g) => !isOurs(g));
    config.hooks[ev] = remove ? kept : [...kept, entries[ev]];
    if (!config.hooks[ev].length) delete config.hooks[ev];
  }
  if (!Object.keys(config.hooks).length) delete config.hooks;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  if (remove) return 'hook removido de ' + file;
  // Duas confiancas diferentes, e as duas falham EM SILENCIO (provado na 0.154.0, em 19/09/2026):
  //  - o hook: o Codex so roda hook em que o usuario confiou (/hooks);
  //  - o PROJETO: o .codex/ de um projeto so e lido se o projeto esta marcado como confiavel no
  //    config.toml do Codex. Sem isso o hooks.json de projeto nem e carregado — estar num repo git
  //    nao basta. O global ($CODEX_HOME/hooks.json) nao tem essa segunda exigencia.
  return 'hook instalado em ' + file
    + '\no Codex so roda hook em que voce confiou: abra a sessao e rode /hooks para confiar neste.'
    + (global ? '' : '\natencao: o Codex so le o .codex/ de projeto CONFIAVEL. Abra o Codex nesta pasta e aceite confiar no projeto'
      + '\n(ou use --global, que dispensa isso e e seguro: o hook nao faz nada em projeto sem .flowforge/).');
}

/** Entradas de hook no formato do hooks.json do Codex. `command` ja vem pronto. */
function hookEntries(command) {
  const hook = { type: 'command', command, timeout: 10 };
  return Object.fromEntries(EVENTS.map((ev) => [ev, { hooks: [hook] }]));
}

module.exports = { SOURCE, EVENTS, map, hookEntries, install, readThread, rememberThread };
