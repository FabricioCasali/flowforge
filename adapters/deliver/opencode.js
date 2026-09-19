// =============================================================================
// adapters/deliver/opencode.js — o "Analisar" entregue na sessao do OpenCode JA ABERTA.
//
//   node adapters/live.js --deliver opencode
//
// O OpenCode sobe um servidor HTTP dentro da propria TUI (https://opencode.ai/docs/server).
// Entregar ali e escrever no prompt de quem ja esta trabalhando no projeto:
//   POST /tui/append-prompt  {"text":"<pedido>"}   escreve no prompt da TUI aberta
//   POST /tui/submit-prompt                        manda
//
// ONDE FICA ESSE SERVIDOR. A TUI sorteia a porta (`--port` tem padrao 0) e NAO publica a URL
// em variavel de ambiente — conferido no binario 1.18.31, que so exporta OPENCODE=1 e
// OPENCODE_PID. Quem sabe a URL e o PLUGIN: `serverUrl` chega pronto no PluginInput. Entao o
// plugin do FlowForge (adapters/hooks/opencode.js, instalado por
// `node adapters/activity.js install opencode`) deixa um bilhete em
// ~/.flowforge/opencode/<pid>-<projeto>.json, e esta ponte le o bilhete da instancia cujo
// diretorio e o do projeto do pedido. Bilhete de processo morto e jogado fora na leitura.
// Sem plugin: FLOWFORGE_OPENCODE_URL=http://127.0.0.1:<porta> (ou `--opencode-url <url>` na
// linha do live.js), que e o caso de quem abre a TUI com `--port` fixo.
//
// QUAL SESSAO. A que o usuario esta olhando: `append-prompt` cai no prompt da TUI aberta, seja
// qual for a conversa dela — nao ha id pra adivinhar nem pra errar. Para servidor sem TUI
// (`opencode serve`), FLOWFORGE_OPENCODE_SESSION (ou `--opencode-session <id>`) troca a entrega
// por POST /session/<id>/prompt_async, que aceita o mesmo texto.
//
// Falha de entrega vira erro nesta promessa; o live.js avisa no stdout e segue vivo — o pedido
// continua pendente e o `live.js done <requestId>` fecha do mesmo jeito.
// =============================================================================

const fs = require('fs');
const path = require('path');
const { announceDir } = require('../hooks/opencode.js');

const TIMEOUT_MS = Number(process.env.FLOWFORGE_OPENCODE_TIMEOUT_MS) || 10000;
const NOTA_MAX = 500; // a nota inteira esta sempre no thread.json

/** Le uma opcao que o live.js nao conhece: ela sobra em opts.args, sem tocar no live.js. */
function flag(opts, nome) {
  const args = (opts && opts.args) || [];
  const i = args.indexOf('--' + nome);
  const v = i >= 0 ? args[i + 1] : null;
  return v && !v.startsWith('--') ? v : '';
}

const vivo = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const norm = (p) => path.resolve(String(p || '')).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const mesmaArvore = (a, b) => {
  if (!a || !b) return false;
  const [x, y] = [norm(a), norm(b)];
  return x === y || x.startsWith(y + '/') || y.startsWith(x + '/');
};

/** Os bilhetes vivos, do mais recente pro mais antigo. Limpa os de processo que ja morreu. */
function bilhetes() {
  const dir = announceDir();
  let nomes = [];
  try { nomes = fs.readdirSync(dir); } catch (e) { return []; }
  const out = [];
  for (const nome of nomes) {
    if (!nome.endsWith('.json')) continue;
    const file = path.join(dir, nome);
    let b;
    try { b = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { continue; }
    if (!b || typeof b.url !== 'string' || !b.url) continue;
    if (b.pid && !vivo(Number(b.pid))) { try { fs.unlinkSync(file); } catch (e) { /* alguem foi mais rapido */ } continue; }
    out.push(b);
  }
  return out.sort((x, y) => (y.ts || 0) - (x.ts || 0));
}

/** Pra onde mandar: a opcao explicita manda; senao, o bilhete da instancia deste projeto. */
function alvo(evt, opts) {
  const forcado = process.env.FLOWFORGE_OPENCODE_URL || flag(opts, 'opencode-url');
  if (forcado) return { url: forcado };
  const lista = bilhetes();
  if (!lista.length) {
    throw new Error('nao achei servidor do OpenCode aberto. Instale o plugin com '
      + '`node adapters/activity.js install opencode` e reabra a sessao, ou passe FLOWFORGE_OPENCODE_URL');
  }
  return lista.find((b) => mesmaArvore(b.directory, evt.projectPath) || mesmaArvore(b.worktree, evt.projectPath)) || lista[0];
}

/**
 * O pedido, por extenso. A linha do live.js e curta demais pra um agente que nao tem a skill
 * do FlowForge carregada: aqui vai o roteiro inteiro — onde ler, onde gravar, como fechar.
 */
function pedido(evt) {
  const dir = path.dirname(evt.workspacePath).replace(/\\/g, '/');
  const raiz = path.resolve(__dirname, '..', '..').replace(/\\/g, '/');
  const nota = String(evt.note || '').replace(/\s+/g, ' ').trim();
  return [
    'FLOWFORGE: o usuário clicou "Analisar" no canvas (sessão ' + evt.session + '). Não é mensagem no chat: é um pedido sobre o desenho.',
    'nota: ' + (nota.length > NOTA_MAX ? nota.slice(0, NOTA_MAX) + '… (inteira no thread.json)' : nota || '(sem nota)'),
    '1. leia ' + dir + '/workspace.json e ' + dir + '/thread.json — olhe primeiro os nós rejected/questioned e os comments de author:"user".',
    '2. responda gravando UM arquivo, ' + dir + '/reply.json:',
    '   { "model": "process|state|er|mind", "message": "<resposta curta, no idioma do usuário>",',
    '     "update": [{"id":"<nó>","status":"questioned","comment":"…"}],',
    '     "addNodes": [{"id":"<novo>","label":"…"}], "addEdges": [{"source":"<id>","target":"<id>"}],',
    '     "updateEdges": [], "removeNodes": [], "removeEdges": [] }   — só "message" é obrigatório; nó novo vai sem x/y.',
    '3. feche o pedido, senão o canvas fica travado em modo leitura:',
    '   node ' + raiz + '/adapters/live.js done ' + evt.requestId,
    '   (ou … done ' + evt.requestId + ' --message "só texto", ou --failed "motivo")',
  ].join('\n');
}

async function post(t, rota, corpo) {
  const url = new URL(rota, t.url);
  if (t.directory) url.searchParams.set('directory', t.directory);
  const res = await fetch(url, {
    method: 'POST',
    ...(corpo ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) } : {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error('POST ' + rota + ' respondeu ' + res.status);
  return res;
}

async function deliver({ evt, opts }) {
  const t = alvo(evt, opts);
  const text = pedido(evt);
  const sessao = process.env.FLOWFORGE_OPENCODE_SESSION || flag(opts, 'opencode-session');
  if (sessao) {
    await post(t, '/session/' + encodeURIComponent(sessao) + '/prompt_async', { parts: [{ type: 'text', text }] });
    return;
  }
  await post(t, '/tui/append-prompt', { text });
  await post(t, '/tui/submit-prompt', null);
}

module.exports = { deliver, pedido, alvo, bilhetes };
