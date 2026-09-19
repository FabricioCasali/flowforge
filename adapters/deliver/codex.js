// Entrega o "Analisar" na SESSAO DO CODEX QUE JA ESTA ABERTA.
//
//   node adapters/live.js --deliver codex
//
// O Codex nao tem nada parecido com a ferramenta Monitor (um processo cujo stdout vira
// evento na conversa). O que ele tem e o caminho inverso, e serve melhor: `codex queue`
// enfileira uma mensagem numa sessao existente. Conferido na versao 0.154.0 contra uma
// sessao viva e ociosa: o comando devolve "Queued message <id> for thread <id>" e a sessao
// ABRE UM TURNO NOVO com aquele texto, sem nada digitado.
//
//   codex queue --thread <thread> --message "<texto>"
//
// Em qual sessao entregar, na ordem:
//   1. FLOWFORGE_CODEX_THREAD    voce diz qual, e acabou a conversa
//   2. CODEX_THREAD_ID           a ponte foi aberta de dentro da propria sessao (o Codex
//                                exporta essa variavel para o que ele roda)
//   3. o hook da linha do tempo  adapters/hooks/codex.js anota o thread da ultima sessao
//                                vista em cada projeto (por isso, com o hook instalado,
//                                nao ha nada a configurar)
//
// Limites que valem saber: a sessao precisa ter pelo menos um turno gravado (thread novo
// em branco: "no rollout found for thread id"); com a sessao no meio de um turno, a
// mensagem espera o turno acabar; com a sessao fechada, fica na fila para a proxima vez
// que o thread for retomado — nesse caso o canvas fica travado ate alguem fechar o pedido.

const path = require('path');
const { runProcess } = require('../core.js');
const { readThread } = require('../hooks/codex.js');

const LIVE = path.join(__dirname, '..', 'live.js').replace(/\\/g, '/');
const QUEUE_TIMEOUT_MS = 60000;

function threadOf(evt) {
  const dado = process.env.FLOWFORGE_CODEX_THREAD || process.env.CODEX_THREAD_ID;
  if (dado) return dado.trim();
  const projectDir = evt.projectPath || path.resolve(path.dirname(evt.workspacePath), '..', '..');
  return readThread(projectDir);
}

/**
 * UMA linha, sem aspas e sem metacaractere de shell: no Windows o `codex` instalado por npm
 * e um shim que so roda por shell, e a mensagem vai como ARGUMENTO. O pedido inteiro esta
 * sempre nos arquivos; isto aqui e so o aviso que acorda a sessao.
 */
function limpa(texto) {
  return String(texto || '').replace(/\s+/g, ' ').replace(/["'`^&|<>%$]/g, '').trim();
}

function mensagem(evt, opts = {}) {
  const dir = path.dirname(evt.workspacePath).replace(/\\/g, '/');
  const nota = limpa(evt.note).slice(0, 240);
  // O `done` acha a ponte pela PORTA que esta na url; sem repetir a url aqui, uma ponte
  // fora da porta padrao fica inalcancavel e o canvas trava (visto na prova de ponta a ponta).
  const done = 'node ' + LIVE + ' done ' + evt.requestId + (opts.url ? ' --url ' + opts.url : '');
  return limpa([
    'FLOWFORGE analisar ' + evt.requestId + ' sessao=' + evt.session + '.',
    'E um clique em Analisar no canvas, nao uma mensagem no chat.',
    'Leia ' + dir + '/workspace.json e ' + dir + '/thread.json (a nota inteira esta no thread).',
    'Responda gravando ' + dir + '/reply.json e depois rode, do jeito que esta:',
    done + '.',
    nota ? 'Nota: ' + nota : '',
  ].filter(Boolean).join(' '));
}

async function deliver({ evt, opts }) {
  const thread = threadOf(evt);
  if (!thread) {
    throw new Error('nao sei em qual sessao do Codex entregar: instale o hook '
      + '(node adapters/activity.js install codex) ou informe FLOWFORGE_CODEX_THREAD');
  }
  const bin = process.env.FLOWFORGE_CODEX_BIN || 'codex';
  const r = await runProcess(bin, ['queue', '--thread', thread, '--message', mensagem(evt, opts)], { timeoutMs: QUEUE_TIMEOUT_MS });
  if (r.timedOut) throw new Error('codex queue nao respondeu a tempo');
  if (r.code !== 0) throw new Error('codex queue saiu com codigo ' + r.code + ': ' + String(r.stderr || r.stdout).trim().slice(0, 300));
}

module.exports = { deliver, mensagem, threadOf };
