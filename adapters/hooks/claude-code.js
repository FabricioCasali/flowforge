// Traduz o payload de um hook do Claude Code (stdin JSON) numa acao da linha do tempo.
// Campos conferidos na versao 2.1.277: session_id, cwd, hook_event_name, tool_name,
// tool_input, tool_response. Doc: https://code.claude.com/docs/en/hooks
//
// Devolve { kind, summary, files?, failed? } ou null (acao que nao vale narrar).
// NARRACAO, nao transcricao: nunca o texto do pedido do usuario, nunca a saida da ferramenta.

const path = require('path');

const SOURCE = { id: 'claude-code', label: 'Claude Code' };
const EVENTS = ['PostToolUse', 'UserPromptSubmit', 'Stop'];

function rel(projectDir, file) {
  if (typeof file !== 'string' || !file) return null;
  const r = path.relative(projectDir, path.resolve(projectDir, file)).replace(/\\/g, '/');
  return r.startsWith('..') ? '…/' + path.basename(file) : r || path.basename(file);
}
const short = (s, n = 90) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

function map(payload, projectDir) {
  const event = payload.hook_event_name;
  if (event === 'UserPromptSubmit') return { kind: 'prompt', summary: 'recebeu um pedido do usuário' };
  if (event === 'Stop') return { kind: 'stop', summary: 'terminou o turno' };
  if (event !== 'PostToolUse') return null;

  const tool = String(payload.tool_name || '');
  const input = payload.tool_input || {};
  const response = payload.tool_response;
  const failed = !!(response && typeof response === 'object' && (response.is_error === true || response.interrupted === true
    || (Number.isFinite(response.exitCode) && response.exitCode !== 0))) || undefined;

  switch (tool) {
    case 'Read': { const f = rel(projectDir, input.file_path); return f && { kind: 'read', summary: 'leu ' + f, files: [f], failed }; }
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': {
      const f = rel(projectDir, input.file_path || input.notebook_path); return f && { kind: 'edit', summary: 'editou ' + f, files: [f], failed };
    }
    case 'Write': { const f = rel(projectDir, input.file_path); return f && { kind: 'edit', summary: 'gravou ' + f, files: [f], failed }; }
    case 'Bash': case 'PowerShell': {
      const cmd = String(input.command || '');
      // a contabilidade do proprio FlowForge nao e noticia
      if (/adapters[\\/](tasks|activity|live)\.js/.test(cmd)) return null;
      // Sem descricao, so o programa e o subcomando: o comando cru pode carregar segredo
      // (token em header, senha em URL), e isto aqui vai pra um arquivo do projeto.
      const words = cmd.trim().split(/\s+/);
      const bare = words.slice(0, 2).join(' ') + (words.length > 2 ? ' …' : '');
      return { kind: 'run', summary: input.description ? short(input.description) : 'rodou ' + bare, failed };
    }
    case 'Grep': return { kind: 'search', summary: 'buscou `' + short(input.pattern, 60) + '`' + (input.path ? ' em ' + rel(projectDir, input.path) : ''), failed };
    case 'Glob': return { kind: 'search', summary: 'listou ' + short(input.pattern, 60), failed };
    case 'WebFetch': { let host = ''; try { host = new URL(input.url).host; } catch (e) { /* url torta */ } return { kind: 'web', summary: 'consultou ' + (host || 'uma página'), failed }; }
    case 'WebSearch': return { kind: 'web', summary: 'pesquisou: ' + short(input.query, 70), failed };
    case 'Agent': case 'Task': return { kind: 'agent', summary: 'delegou: ' + short(input.description || 'um subagente', 70), failed };
    case 'Skill': return { kind: 'tool', summary: 'usou a skill ' + short(input.skill, 50), failed };
    case 'ToolSearch': case 'TodoWrite': case 'Monitor': case 'TaskOutput': case 'AskUserQuestion': return null;
    default: {
      const mcp = tool.match(/^mcp__(.+?)__(.+)$/);
      return { kind: 'tool', summary: mcp ? 'usou ' + mcp[1] + ': ' + mcp[2] : 'usou ' + tool, failed };
    }
  }
}

/** Entradas de hook para o settings.json do Claude Code. `command` ja vem pronto. */
function settingsEntries(command) {
  const hook = { type: 'command', command, async: true, timeout: 10 };
  return Object.fromEntries(EVENTS.map((ev) => [ev, ev === 'PostToolUse' ? { matcher: '', hooks: [hook] } : { hooks: [hook] }]));
}

module.exports = { SOURCE, EVENTS, map, settingsEntries };
