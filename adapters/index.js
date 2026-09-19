#!/usr/bin/env node
// =============================================================================
// adapters/index.js — liga um harness ao FlowForge.
//
//   node adapters/index.js <claude-code|opencode|codex> [opcoes]
//
//   --url <ws>      servidor (padrao ws://localhost:4317/agent)
//   --model <m>     modelo, no formato que o harness entende
//   --effort <n>    esforco de raciocinio, onde o harness tem isso (low|medium|high)
//   --label <nome>  nome mostrado na barra do canvas
//   --fresh         nao retoma a conversa anterior da sessao
//   --              tudo depois disso vai cru para o CLI do harness
//
// Um adapter por vez: o servidor recusa o segundo registro.
// =============================================================================

const { startAdapter } = require('./core.js');

const DRIVERS = ['claude-code', 'opencode', 'codex'];

function parseArgs(argv) {
  const out = { extraArgs: [] };
  const rest = argv.slice();
  out.driver = rest.shift();
  while (rest.length) {
    const a = rest.shift();
    if (a === '--') { out.extraArgs = rest.splice(0); break; }
    if (a === '--fresh') out.fresh = true;
    else if (a === '--url') out.url = rest.shift();
    else if (a === '--model') out.model = rest.shift();
    else if (a === '--effort') out.effort = rest.shift();
    else if (a === '--label') out.label = rest.shift();
    else { console.error('opcao desconhecida: ' + a); process.exit(2); }
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));
if (!DRIVERS.includes(opts.driver)) {
  console.error('uso: node adapters/index.js <' + DRIVERS.join('|') + '> [--url ws://...] [--model m] [--effort n] [--label nome] [--fresh] [-- args do harness]');
  process.exit(2);
}

const driver = require('./drivers/' + opts.driver + '.js');
const adapter = startAdapter(driver, { ...opts, onStop: () => process.exit(1) });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { adapter.stop(); process.exit(0); });
}
