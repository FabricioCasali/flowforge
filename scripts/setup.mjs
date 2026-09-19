#!/usr/bin/env node
// =============================================================================
// setup.mjs — deixa a instalacao PRONTA PRA RODAR, num comando.
//
// O repositorio nao versiona dependencias nem o front compilado. Quem chega por um
// clone limpo — ou pelo plugin recem-instalado, cuja pasta de cache e trocada a cada
// versao — nao tem o `ws` do servidor nem a pagina do canvas (`web-next/dist`).
//
//   node scripts/setup.mjs            prepara so o que falta (nao refaz o que ja esta pronto)
//   node scripts/setup.mjs --check    so diz o que falta; sai 0 se esta pronto, 1 se nao
//   node scripts/setup.mjs --force    refaz tudo (depois de atualizar o codigo, por exemplo)
//
// Sai 0 com tudo pronto. Em falha diz QUAL passo falhou e o motivo mais provavel
// (sem `npm` no PATH, sem rede), em vez de despejar o log do npm.
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web-next');
const flags = new Set(process.argv.slice(2));
const force = flags.has('--force');
const checkOnly = flags.has('--check');

const has = (...p) => fs.existsSync(path.join(...p));

/** O build fica velho quando o fonte do front e mais novo que ele. */
function distStale() {
  const index = path.join(WEB, 'dist', 'index.html');
  if (!fs.existsSync(index)) return true;
  const built = fs.statSync(index).mtimeMs;
  const newest = (dir) => {
    let m = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      m = Math.max(m, e.isDirectory() ? newest(p) : fs.statSync(p).mtimeMs);
    }
    return m;
  };
  return newest(path.join(WEB, 'src')) > built;
}

const steps = [
  {
    nome: 'dependencias do servidor (ws)',
    falta: () => force || !has(ROOT, 'node_modules', 'ws'),
    run: ['npm', ['install', '--no-audit', '--no-fund', '--prefix', ROOT]],
  },
  {
    nome: 'dependencias do front (web-next)',
    // so precisa delas pra COMPILAR: com o dist em dia, nao instala meio gigabyte a toa
    falta: () => force || (distStale() && !has(WEB, 'node_modules', 'vite')),
    run: ['npm', ['install', '--no-audit', '--no-fund', '--prefix', WEB]],
  },
  {
    nome: 'front compilado (web-next/dist)',
    falta: () => force || distStale(),
    run: ['npm', ['run', 'build', '--prefix', WEB]],
  },
];

const pendentes = steps.filter((s) => s.falta());
if (checkOnly) {
  if (!pendentes.length) { console.log('pronto: nada a preparar'); process.exit(0); }
  console.log('falta preparar: ' + pendentes.map((s) => s.nome).join('; '));
  process.exit(1);
}
if (!pendentes.length) { console.log('pronto: nada a preparar'); process.exit(0); }

console.log('Preparando o FlowForge (' + pendentes.length + ' passo(s); um ou dois minutos na primeira vez)…');
for (const step of steps) {
  if (!step.falta()) continue; // reavalia: instalar o front muda o que o build precisa
  const t0 = Date.now();
  process.stdout.write('  · ' + step.nome + ' … ');
  const [cmd, args] = step.run;
  // No Windows o npm e um .cmd: so roda por shell — e com shell a linha e montada aqui, com
  // aspas nos caminhos (o Node nao escapa args nesse modo, e avisa DEP0190 se receber a lista).
  const win = process.platform === 'win32';
  const q = (a) => (/[\s"&|<>^%()]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a);
  const r = win
    ? spawnSync([cmd, ...args].map(q).join(' '), { cwd: ROOT, encoding: 'utf8', shell: true })
    : spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    console.log('FALHOU');
    const out = String((r.stderr || '') + (r.stdout || ''));
    const motivo = r.error && r.error.code === 'ENOENT' ? 'o `npm` nao esta no PATH (instale o Node.js, que traz o npm)'
      : /ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|network/i.test(out) ? 'sem acesso a rede pro registro do npm'
        : /EACCES|EPERM/i.test(out) ? 'sem permissao de escrita em ' + ROOT
          : 'veja o fim do log abaixo';
    console.error('\nNao consegui preparar "' + step.nome + '": ' + motivo + '.');
    console.error(out.trim().split('\n').slice(-12).join('\n'));
    process.exit(1);
  }
  console.log('ok (' + Math.round((Date.now() - t0) / 1000) + ' s)');
}
console.log('Pronto. Suba o servidor: node server/index.js --data-dir "<projeto>/.flowforge" --port 4317');
