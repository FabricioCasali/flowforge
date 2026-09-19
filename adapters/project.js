// O que os comandos do lado do agente (tasks.js, activity.js) tem em comum:
// achar o .flowforge/ do projeto e saber quem esta publicando.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

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

const HARNESSES = {
  claude: { id: 'claude-code', label: 'Claude Code' },
  opencode: { id: 'opencode', label: 'OpenCode' },
  codex: { id: 'codex', label: 'Codex' },
};

/**
 * A cadeia de processos-pai, do mais proximo pro mais distante: [{ pid, name }].
 * So e consultada no caso AMBIGUO (um harness aberto de dentro do terminal de outro: as
 * variaveis de ambiente dos dois chegam juntas e nao dizem quem e o de dentro). Custa um
 * processo a mais; fora desse caso nao roda.
 */
function ancestors() {
  const out = [];
  try {
    if (process.platform === 'win32') {
      const ps = [
        '$p=' + process.ppid,
        'for($i=0;$i -lt 12 -and $p;$i++){',
        '$x=Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue',
        'if(-not $x){break}',
        'Write-Output ("" + $p + " " + $x.Name)',
        'if($x.ParentProcessId -eq $p){break}',
        '$p=$x.ParentProcessId}',
      ].join(';').replace('{;', '{');
      const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 8000, windowsHide: true });
      for (const line of String(r.stdout || '').split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+)\s+(.*)$/);
        if (m) out.push({ pid: Number(m[1]), name: m[2] });
      }
    } else {
      let p = process.ppid;
      for (let i = 0; i < 12 && p > 1; i++) {
        const r = spawnSync('ps', ['-o', 'ppid=,comm=', '-p', String(p)], { encoding: 'utf8', timeout: 3000 });
        const m = String(r.stdout || '').trim().match(/^(\d+)\s+(.*)$/);
        if (!m) break;
        out.push({ pid: p, name: path.basename(m[2]) });
        const next = Number(m[1]);
        if (!next || next === p) break;
        p = next;
      }
    }
  } catch (e) { /* sem cadeia: cai no palpite */ }
  return out;
}

/**
 * Quem esta publicando. `--list`/`--label` e FLOWFORGE_TASKS_LIST mandam; sem eles, o ambiente:
 * Claude Code poe CLAUDECODE nos filhos; OpenCode poe OPENCODE e OPENCODE_PID; Codex, CODEX_*.
 *
 * Quando DOIS aparecem (OpenCode aberto de dentro de um terminal do Claude Code, ou o contrario),
 * ganha o de dentro. Visto em 19/09/2026: tarefas do OpenCode saiam como "Claude Code" quando ele
 * era aberto de um terminal do Claude Code.
 */
function whoAmI(env = process.env, chainOf = ancestors) {
  if (env.FLOWFORGE_TASKS_LIST) return { id: env.FLOWFORGE_TASKS_LIST, label: env.FLOWFORGE_TASKS_LABEL || env.FLOWFORGE_TASKS_LIST };
  const claude = !!(env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT);
  const opencode = !!(env.OPENCODE || env.OPENCODE_PID || env.OPENCODE_BIN_PATH);
  const codex = !!(env.CODEX_SANDBOX || env.CODEX_THREAD_ID || env.CODEX_MANAGED_BY_NPM);
  const seen = [claude && 'claude', opencode && 'opencode', codex && 'codex'].filter(Boolean);
  if (seen.length === 0) return { id: 'cli', label: 'CLI' };
  if (seen.length === 1) return HARNESSES[seen[0]];

  // Ambiguo: sobe a cadeia de pais e ganha o PRIMEIRO harness encontrado — e o de dentro. Estar
  // na cadeia nao basta (o de fora tambem esta). O OpenCode se reconhece pelo PID que ele mesmo
  // informa; os outros, pelo nome do processo.
  const opid = Number(env.OPENCODE_PID);
  for (const a of chainOf()) {
    if (opid && a.pid === opid) return HARNESSES.opencode;
    if (/^opencode/i.test(a.name)) return HARNESSES.opencode;
    if (/^claude/i.test(a.name)) return HARNESSES.claude;
    if (/^codex/i.test(a.name)) return HARNESSES.codex;
  }
  return HARNESSES[seen[0]];
}

module.exports = { findExistingDataDir, findDataDir, whoAmI };
