// O que os comandos do lado do agente (tasks.js, activity.js) tem em comum:
// achar o .flowforge/ do projeto e saber quem esta publicando.

const fs = require('fs');
const path = require('path');

/** Sobe a partir de `start` ate achar um `.flowforge/`. Devolve null se nao houver. */
function findExistingDataDir(start) {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, '.flowforge');
    try { if (fs.statSync(candidate).isDirectory()) return candidate; } catch (e) { /* segue subindo */ }
    if (path.dirname(dir) === dir) return null;
  }
}

/** Como acima, mas cai em `<start>/.flowforge` (a criar) quando o projeto ainda nao tem um. */
function findDataDir(start) {
  return findExistingDataDir(start) || path.join(path.resolve(start), '.flowforge');
}

/** Quem esta publicando. So um palpite pelo ambiente; `--list`/`--label` mandam. */
function whoAmI(env = process.env) {
  if (env.FLOWFORGE_TASKS_LIST) return { id: env.FLOWFORGE_TASKS_LIST, label: env.FLOWFORGE_TASKS_LABEL || env.FLOWFORGE_TASKS_LIST };
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return { id: 'claude-code', label: 'Claude Code' };
  if (env.OPENCODE || env.OPENCODE_BIN_PATH) return { id: 'opencode', label: 'OpenCode' };
  if (env.CODEX_SANDBOX || env.CODEX_THREAD_ID || env.CODEX_MANAGED_BY_NPM) return { id: 'codex', label: 'Codex' };
  return { id: 'cli', label: 'CLI' };
}

module.exports = { findExistingDataDir, findDataDir, whoAmI };
