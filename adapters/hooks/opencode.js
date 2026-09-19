// Traduz o payload do PLUGIN do OpenCode (stdin JSON) numa acao da linha do tempo — e instala
// esse plugin. No OpenCode o gancho nao e entrada de settings: e um arquivo JS em
// .opencode/plugin/ do projeto (ou no config global). Doc: https://opencode.ai/docs/plugins
//
// Conferido contra a versao 1.18.31: os hooks vem do @opencode-ai/plugin
// (`tool.execute.after`, `chat.message`, `event`) e os parametros de cada ferramenta foram
// lidos do proprio binario (GET /experimental/tool):
//   bash {command,timeout,workdir}   read/edit/write {filePath,…}   apply_patch {patchText}
//   glob/grep {pattern,path}         webfetch {url}   websearch {query}
//   task {description,prompt,subagent_type}           skill {name}
// Repare: o bash do OpenCode NAO TEM campo `description` — entao comando SEMPRE vira
// programa + subcomando, nunca o comando cru.
//
// Devolve { kind, summary, files?, failed? } ou null (acao que nao vale narrar).
// NARRACAO, nao transcricao: nunca o texto do pedido do usuario, nunca a resposta do agente,
// nunca conteudo de arquivo, saida de ferramenta, comando cru, query de URL ou argumento de MCP.

const fs = require('fs');
const os = require('os');
const path = require('path');

const SOURCE = { id: 'opencode', label: 'OpenCode' };
// Os hooks do plugin que o FlowForge escuta. O resto do barramento NAO e escutado de proposito:
// `message.part.updated`, por exemplo, carrega o texto do usuario.
const EVENTS = ['tool.execute.after', 'chat.message', 'event:session.idle'];

function rel(projectDir, file) {
  if (typeof file !== 'string' || !file) return null;
  const r = path.relative(projectDir, path.resolve(projectDir, file)).replace(/\\/g, '/');
  return r.startsWith('..') ? '…/' + path.basename(file) : r || path.basename(file);
}
const short = (s, n = 90) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

/** Do envelope do apply_patch so os CABECALHOS: nome de arquivo e narracao, o corpo e conteudo. */
function patchFiles(projectDir, patchText) {
  const out = [];
  const re = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
  for (let m = re.exec(String(patchText || '')); m && out.length < 4; m = re.exec(String(patchText || ''))) {
    const f = rel(projectDir, m[1].trim());
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}

function map(payload, projectDir) {
  const hook = String(payload.hook || '');
  if (hook === 'chat.message') return { kind: 'prompt', summary: 'recebeu um pedido do usuário' };
  if (hook === 'event') return payload.type === 'session.idle' ? { kind: 'stop', summary: 'terminou o turno' } : null;
  if (hook !== 'tool.execute.after') return null;

  const tool = String(payload.tool || '');
  const args = payload.args && typeof payload.args === 'object' ? payload.args : {};
  const failed = payload.failed === true || undefined;

  switch (tool) {
    case 'read': { const f = rel(projectDir, args.filePath); return f && { kind: 'read', summary: 'leu ' + f, files: [f], failed }; }
    case 'edit': { const f = rel(projectDir, args.filePath); return f && { kind: 'edit', summary: 'editou ' + f, files: [f], failed }; }
    case 'write': { const f = rel(projectDir, args.filePath); return f && { kind: 'edit', summary: 'gravou ' + f, files: [f], failed }; }
    case 'apply_patch': {
      const files = patchFiles(projectDir, args.patchText);
      return { kind: 'edit', summary: files.length ? 'editou ' + files.join(', ') : 'aplicou um patch', ...(files.length ? { files } : {}), failed };
    }
    case 'bash': {
      const cmd = String(args.command || '').trim();
      // a contabilidade do proprio FlowForge nao e noticia
      if (/adapters[\\/](tasks|activity|live)\.js/.test(cmd)) return null;
      if (!cmd) return { kind: 'run', summary: 'rodou um comando', failed };
      // So o programa e o subcomando: o comando cru pode carregar segredo (token em header,
      // senha em URL), e isto aqui vai pra um arquivo do projeto de outra pessoa.
      const words = cmd.split(/\s+/);
      return { kind: 'run', summary: 'rodou ' + words.slice(0, 2).join(' ') + (words.length > 2 ? ' …' : ''), failed };
    }
    case 'grep': return { kind: 'search', summary: 'buscou `' + short(args.pattern, 60) + '`' + (args.path ? ' em ' + rel(projectDir, args.path) : ''), failed };
    case 'glob': return { kind: 'search', summary: 'listou ' + short(args.pattern, 60), failed };
    case 'list': return { kind: 'search', summary: 'listou ' + (rel(projectDir, args.path) || 'o projeto'), failed };
    case 'webfetch': { let host = ''; try { host = new URL(args.url).host; } catch (e) { /* url torta */ } return { kind: 'web', summary: 'consultou ' + (host || 'uma página'), failed }; }
    case 'websearch': return { kind: 'web', summary: 'pesquisou: ' + short(args.query, 70), failed };
    case 'task': return { kind: 'agent', summary: 'delegou: ' + short(args.description || args.subagent_type || 'um subagente', 70), failed };
    case 'skill': return { kind: 'tool', summary: 'usou a skill ' + short(args.name, 50), failed };
    case 'todowrite': case 'todoread': case 'question': case 'invalid': case 'batch': return null;
    default: {
      // MCP no OpenCode chega como <servidor>_<ferramenta>; nome de ferramenta nao e segredo,
      // argumento e — por isso nunca sai daqui nada alem do nome.
      const mcp = tool.match(/^([a-z0-9][a-z0-9-]*)_(.+)$/);
      return { kind: 'tool', summary: mcp ? 'usou ' + mcp[1] + ': ' + mcp[2] : 'usou ' + (tool || 'uma ferramenta'), failed };
    }
  }
}

// ---- o plugin: instalar, tirar, e o bilhete com a URL do servidor ----------------------
const MARK = 'flowforge:plugin';
const PLUGIN_FILE = 'flowforge.js';

/**
 * Onde o plugin deixa a URL do servidor HTTP da instancia em que ele roda — um arquivo por
 * instancia. E dai que `adapters/deliver/opencode.js` descobre pra onde mandar o "Analisar":
 * a TUI sorteia a porta e nao publica a URL em variavel de ambiente (conferido na 1.18.31),
 * mas o `serverUrl` chega pronto no PluginInput.
 */
function announceDir() { return path.join(os.homedir(), '.flowforge', 'opencode'); }

/** O config global do OpenCode: OPENCODE_CONFIG_DIR > XDG_CONFIG_HOME/opencode > ~/.config/opencode. */
function configDir() {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR;
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, 'opencode');
  return path.join(os.homedir(), '.config', 'opencode');
}

function pluginFile({ global, projectDir }) {
  return path.join(global ? configDir() : path.join(projectDir, '.opencode'), 'plugin', PLUGIN_FILE);
}

/** O arquivo de plugin, gerado. ESM: e o que o OpenCode carrega (Bun). */
function pluginSource(scriptPath) {
  return [
    '// FlowForge — ' + MARK + ' (gerado por `adapters/activity.js install opencode`; nao edite a mao).',
    '// Dois trabalhos, os dois silenciosos: narrar na linha do tempo do canvas o que o agente faz,',
    '// e deixar a URL do servidor desta instancia pra ponte viva saber onde entregar o "Analisar".',
    '// Erro aqui NUNCA derruba o OpenCode: narrar e cortesia.',
    'import fs from "node:fs";',
    'import os from "node:os";',
    'import path from "node:path";',
    'import crypto from "node:crypto";',
    'import { spawn } from "node:child_process";',
    '',
    'const SCRIPT = ' + JSON.stringify(String(scriptPath).replace(/\\/g, '/')) + ';',
    'const NODE = process.env.FLOWFORGE_NODE || "node";',
    '',
    'export const FlowForge = async ({ directory, worktree, serverUrl }) => {',
    '  const dir = path.join(os.homedir(), ".flowforge", "opencode");',
    '  const key = crypto.createHash("sha1").update(String(directory)).digest("hex").slice(0, 8);',
    '  const bilhete = path.join(dir, process.pid + "-" + key + ".json");',
    '  try {',
    '    fs.mkdirSync(dir, { recursive: true });',
    '    fs.writeFileSync(bilhete, JSON.stringify({ url: String(serverUrl), pid: process.pid, directory, worktree, ts: Date.now() }));',
    '  } catch (e) { /* sem bilhete a ponte ainda aceita FLOWFORGE_OPENCODE_URL */ }',
    '',
    '  const narrar = (payload) => {',
    '    try {',
    '      const p = spawn(NODE, [SCRIPT, "hook", "opencode"], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });',
    '      p.on("error", () => {});',
    '      p.stdin.on("error", () => {});',
    '      p.stdin.end(JSON.stringify(payload));',
    '      p.unref();',
    '    } catch (e) { /* calado de proposito */ }',
    '  };',
    '  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);',
    '',
    '  return {',
    '    // SO o tipo que interessa: o barramento inteiro passa por aqui, com o texto do usuario dentro.',
    '    event: async ({ event }) => {',
    '      if (!event || event.type !== "session.idle") return;',
    '      narrar({ hook: "event", type: event.type, cwd: directory, sessionID: event.properties && event.properties.sessionID });',
    '    },',
    '    "chat.message": async (input) => {',
    '      narrar({ hook: "chat.message", cwd: directory, sessionID: input && input.sessionID });',
    '    },',
    '    "tool.execute.after": async (input, output) => {',
    '      const meta = (output && output.metadata) || {};',
    '      const exit = num(meta.exit) ?? num(meta.exitCode) ?? num(meta.exit_code);',
    '      // A saida e o titulo da ferramenta ficam de fora: sao transcricao (no bash, o titulo E o comando).',
    '      narrar({ hook: "tool.execute.after", cwd: directory, tool: input.tool, sessionID: input.sessionID,',
    '        callID: input.callID, args: input.args, failed: exit !== undefined && exit !== 0 });',
    '    },',
    '    dispose: async () => { try { fs.unlinkSync(bilhete); } catch (e) { /* ja foi */ } },',
    '  };',
    '};',
    '',
  ].join('\n');
}

/**
 * Escreve (ou tira) o plugin: `.opencode/plugin/flowforge.js` do projeto, ou o do config global
 * com `global`. Reinstalar da o mesmo arquivo; `remove` apaga SO o arquivo do FlowForge, e nem
 * isso se alguem tiver posto um `flowforge.js` proprio ali.
 */
function install({ global, remove, projectDir, scriptPath }) {
  const file = pluginFile({ global, projectDir });
  let atual = null;
  try { atual = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw new Error('nao consegui ler ' + file + ': ' + e.message); }
  if (atual !== null && !atual.includes(MARK)) throw new Error(file + ' existe e nao e do FlowForge; nao vou mexer');

  if (remove) {
    if (atual === null) return 'nada a remover: nao ha plugin do FlowForge em ' + file;
    fs.unlinkSync(file);
    return 'plugin removido de ' + file
      + '\no OpenCode carrega plugin ao abrir: a sessao em curso so para de narrar no proximo start.';
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, pluginSource(scriptPath));
  return 'plugin instalado em ' + file
    + '\nele narra a linha do tempo E anuncia o servidor da sessao (o que a ponte viva usa pra entregar o Analisar).'
    + '\no OpenCode carrega plugin ao abrir: reabra a sessao pra valer.';
}

module.exports = { SOURCE, EVENTS, map, install, announceDir, pluginFile, pluginSource, MARK };
