#!/usr/bin/env node
// =============================================================================
// adapters/tasks.js — o agente publica as tarefas dele no canvas.
//
// Nem todo harness tem lista de tarefas propria (o Claude Code desta maquina nao
// tem), e as que existem nao se parecem. Entao o FlowForge nao espelha a lista
// de ninguem: oferece um ARQUIVO (<projeto>/.flowforge/tasks.json, contrato em
// docs/SCHEMA.md) e este comando, que qualquer agente com shell consegue chamar.
// O servidor vigia o arquivo e a lente "Tarefas" atualiza sozinha.
//
//   plan "<objetivo>" "<tarefa>" "<tarefa>" ...   comeca (ou troca) a lista
//   from-plan <sessao> ["<objetivo>"]             tira a lista do plano APROVADO no canvas
//   add "<tarefa>"                                acrescenta no fim
//   start <n> ["nota"]                            em andamento
//   done  <n> ["nota"]                            concluida
//   block <n> "<motivo>"                          travada
//   reset <n>                                     volta para pendente
//   note  <n> "<texto>"                           so a nota
//   link  <n> <sessao>/<no>                       liga a tarefa a um no do desenho
//   unlink <n>                                    desfaz o elo
//   clear                                         tira a lista do canvas
//   show                                          imprime a lista
//
//   <n> e a posicao (1, 2, 3...) ou o id da tarefa.
//   --list <id>  --label <nome>  --data-dir <dir>
//   --node <sessao>/<no>   em `add` e `start`: ja liga a tarefa ao no do desenho.
//                          O no apontado por uma tarefa `in_progress` aparece VIVO
//                          no canvas daquela sessao (travado, se ela estiver
//                          `blocked`). Ex: start 2 --node arquitetura/n7
//   --force                em `start`: executa uma etapa que o usuario ainda NAO
//                          aprovou. So quando ele mandar seguir assim mesmo.
//
// O `plan` NAO tem sintaxe de elo. Foi avaliado marcar o no no proprio titulo
// ("escrever o teste @sessao/n7") e recusado: titulo de tarefa tem "@" e "/" de
// verdade ("revisar o handler @auth/login"), e a regra comeria pedaco de texto do
// usuario. Ligar depois custa uma chamada e nao tem ambiguidade nenhuma.
//
// PLANO APROVADO (issue #9). Antes de um trabalho de varios passos, o agente
// DESENHA o plano — um fluxograma comum, o modelo `process` de uma sessao — e o
// usuario aprova, questiona ou reprova cada etapa no browser. O `from-plan` le
// esse desenho e monta a lista com uma tarefa por etapa APROVADA, na ordem de
// leitura do fluxo e ja ligada ao no (e o elo que faz a etapa acender enquanto
// esta sendo executada). Aprovar e gesto do USUARIO: o agente nunca aprova por
// conta propria, e por isso o `start` recusa etapa que ele ainda nao aprovou.
// =============================================================================

const fs = require('fs');
const path = require('path');
const T = require('../server/tasks.js');
const S = require('../server/state.js');
const { findDataDir, whoAmI } = require('./project.js');

function parse(argv) {
  const opts = {};
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') opts.list = argv[++i];
    else if (a === '--label') opts.label = argv[++i];
    else if (a === '--data-dir') opts.dataDir = argv[++i];
    else if (a === '--node') opts.node = argv[++i];
    else if (a === '--force') opts.force = true;
    else args.push(a);
  }
  return { opts, cmd: args[0], rest: args.slice(1) };
}

// Lanca em vez de sair: `fail` e chamada de DENTRO da trava do arquivo, e um
// process.exit ali pularia o `finally` que a solta.
class UsageError extends Error {}
function fail(msg) { throw new UsageError(msg); }

const ICON = { pending: '[ ]', in_progress: '[>]', completed: '[x]', blocked: '[!]' };
function print(list) {
  if (!list) { console.log('(sem lista publicada)'); return; }
  console.log(list.label + (list.title ? ' — ' + list.title : ''));
  list.tasks.forEach((t, i) => console.log('  ' + (i + 1) + '. ' + ICON[t.status] + ' ' + t.title
    + (t.note ? '  · ' + t.note : '') + (t.node ? '  -> ' + t.node.session + '/' + t.node.id : '')));
}

/**
 * "<sessao>/<no>" -> { session, id }. Validacao LEVE de proposito: so o formato.
 * Nao exige que a sessao ou o no existam — o agente pode ligar a tarefa a uma
 * etapa que ele ainda vai desenhar, e um id que nao existe simplesmente nao
 * acende nada no canvas. A sessao que falta vira AVISO no stdout, nao erro.
 */
function elo(ref) {
  const s = String(ref == null ? '' : ref).trim();
  const corte = s.indexOf('/');
  const session = corte < 0 ? '' : s.slice(0, corte).trim();
  const id = corte < 0 ? '' : s.slice(corte + 1).trim();
  if (!session || !id || id.includes('/')) fail('elo invalido: "' + s + '" — use <sessao>/<no>, ex: arquitetura/n7');
  return { session, id };
}

// ===========================================================================
// O PLANO APROVADO (issue #9)
//
// O plano nao tem formato proprio: e o modelo `process` de uma sessao, seguindo
// o "Contrato estrutural de processos" do docs/SCHEMA.md (inicio, fim, percurso).
// Nao ha kind novo nem campo novo no no — a etapa e um no de trabalho comum, e o
// veredito dela e o approved/questioned/rejected que o usuario ja da no browser.
// ===========================================================================

// So kind de TRABALHO vira tarefa. Inicio, fim, decisao, gateway, evento,
// anotacao e objeto de dados desenham o fluxo; nao sao trabalho a executar.
const KINDS_DE_TRABALHO = ['task', 'subprocess'];
const KINDS_DE_INICIO = ['start', 'event-start'];

// O motivo com que a reconciliacao trava uma tarefa. Precisa ser RECONHECIVEL
// depois: se a etapa voltar a ser aprovada numa revisao seguinte, a tarefa tem de
// voltar a pendente — senao um motivo velho ficaria travando trabalho ja liberado.
// Sem campo novo na tarefa pra isso (o contrato e o de types.ts): a marca e o
// proprio texto da nota, que comeca sempre por "etapa ".
const NOTA_REPROVADA = 'etapa reprovada na revisao';
const NOTA_QUESTIONADA = 'etapa questionada na revisao';
const NOTA_SEM_VEREDITO = 'etapa voltou a proposta: falta o veredito do usuario';
function eNotaDaReconciliacao(nota) { return /^etapa (reprovada|questionada|voltou)\b/.test(String(nota || '')); }

/**
 * Os ids do modelo na ORDEM DE LEITURA do fluxo: percurso a partir de cada
 * inicio, seguindo as setas na ordem em que estao no arquivo — por contrato, em
 * cada decisao a seta do caminho principal vem antes da do desvio. E percurso em
 * PROFUNDIDADE de proposito: o caminho principal inteiro vem antes do desvio, que
 * e como a lista de tarefas se le.
 *
 * `vistos` corta o laco (fluxo com volta e legitimo e nao pode rodar pra sempre),
 * e a pilha e explicita pra fluxo fundo nao estourar a recursao. O grafo decide a
 * ordem; a ordem do array e o DESEMPATE — vale pra escolher entre varios inicios e
 * pra quem o percurso nao alcanca (que entra no fim em vez de sumir).
 */
function ordemDeLeitura(model) {
  const nodes = (Array.isArray(model.nodes) ? model.nodes : []).filter((n) => n && typeof n.id === 'string' && n.id);
  const existe = new Set(nodes.map((n) => n.id));
  const saidas = new Map();
  for (const e of (Array.isArray(model.edges) ? model.edges : [])) {
    if (!e || typeof e.source !== 'string' || typeof e.target !== 'string') continue;
    if (!saidas.has(e.source)) saidas.set(e.source, []);
    saidas.get(e.source).push(e.target);
  }
  const vistos = new Set();
  const ordem = [];
  const anda = (raiz) => {
    const pilha = [raiz];
    while (pilha.length) {
      const atual = pilha.pop();
      if (!existe.has(atual) || vistos.has(atual)) continue;
      vistos.add(atual);
      ordem.push(atual);
      const proximos = saidas.get(atual) || [];
      for (let i = proximos.length - 1; i >= 0; i--) pilha.push(proximos[i]); // primeira seta, primeiro visitada
    }
  };
  const inicios = nodes.filter((n) => KINDS_DE_INICIO.includes(n.kind));
  for (const n of (inicios.length ? inicios : nodes)) anda(n.id);
  for (const n of nodes) if (!vistos.has(n.id)) { vistos.add(n.id); ordem.push(n.id); }
  return ordem;
}

/** O ultimo comentario do usuario no no, curto — e dele que sai o motivo da questao. */
function ultimaFalaDoUsuario(no) {
  const cs = Array.isArray(no.comments) ? no.comments : [];
  for (let i = cs.length - 1; i >= 0; i--) {
    const c = cs[i];
    if (!c || c.author !== 'user' || typeof c.text !== 'string' || !c.text.trim()) continue;
    const t = c.text.trim().replace(/\s+/g, ' ');
    return t.length > 80 ? t.slice(0, 77) + '...' : t;
  }
  return '';
}

function tituloDaEtapa(no) {
  return typeof no.label === 'string' && no.label.trim() ? no.label.trim() : no.id;
}

/** Por que esta etapa NAO vira tarefa. So e chamado pra no que nao esta `approved`. */
function motivoDeFora(no) {
  if (no.status === 'rejected') return 'reprovada na revisao';
  if (no.status === 'questioned') {
    const q = ultimaFalaDoUsuario(no);
    return q ? 'questionada: ' + q : 'questionada na revisao';
  }
  return 'ainda proposta (sem veredito do usuario)';
}

/** O motivo com que a tarefa e TRAVADA quando a etapa dela deixa de estar aprovada. */
function motivoDoBloqueio(no) {
  if (no.status === 'rejected') return NOTA_REPROVADA;
  if (no.status === 'questioned') {
    const q = ultimaFalaDoUsuario(no);
    return q ? 'etapa questionada: ' + q : NOTA_QUESTIONADA;
  }
  return NOTA_SEM_VEREDITO;
}

/** O modelo `process` de uma sessao do projeto, normalizado. */
function leProcesso(dataDir, sessao) {
  S.setDataDir(dataDir);
  const ws = S.readWorkspace(sessao);
  return { ws, model: ws.process };
}

/** Le o plano desenhado numa sessao: as etapas de trabalho na ordem do fluxo. */
function lePlano(dataDir, sessao) {
  const { ws, model } = leProcesso(dataDir, sessao);
  const porId = new Map((Array.isArray(model.nodes) ? model.nodes : [])
    .filter((n) => n && typeof n.id === 'string' && n.id).map((n) => [n.id, n]));
  const ordem = ordemDeLeitura(model);
  const posicao = new Map(ordem.map((id, i) => [id, i]));
  const trabalho = ordem.map((id) => porId.get(id)).filter((n) => KINDS_DE_TRABALHO.includes(n.kind));
  return {
    sessao,
    titulo: S.workspaceTitle(ws),
    temDesenho: porId.size > 0,
    porId,
    posicao,
    trabalho,
    aprovadas: trabalho.filter((n) => n.status === 'approved'),
    fora: trabalho.filter((n) => n.status !== 'approved'),
  };
}

/**
 * A TRAVA do `start`: o no da etapa, quando ele existe no `process` daquela sessao
 * e NAO esta aprovado. Devolve null quando nao ha o que travar.
 *
 * A trava e do PLANO, nao do elo: tarefa sem `node`, tarefa ligada a um no de
 * outra lente (mind/er/state) e sessao que nem existe passam direto — so o
 * fluxograma e plano, e so ele manda no que pode ser executado.
 */
function etapaQueTrava(dataDir, ref) {
  if (!ref || !ref.session || !ref.id) return null;
  if (!fs.existsSync(path.join(dataDir, ref.session))) return null; // sessao inexistente ja e so aviso
  const { model } = leProcesso(dataDir, ref.session);
  const no = (Array.isArray(model.nodes) ? model.nodes : []).find((n) => n && n.id === ref.id);
  if (!no || no.status === 'approved') return null;
  return no;
}

function main() {
  const { opts, cmd, rest } = parse(process.argv.slice(2));
  const who = whoAmI();
  const listId = opts.list || who.id;
  const label = opts.label || (opts.list ? opts.list : who.label);
  const dataDir = opts.dataDir ? path.resolve(opts.dataDir) : findDataDir(process.cwd());
  const now = Date.now();

  if (!cmd || cmd === 'help' || cmd === '--help') {
    // o cabecalho deste arquivo E a ajuda: vai do primeiro ao segundo separador
    // (sem isso, o help arrastava junto comentarios do meio do codigo)
    const linhas = fs.readFileSync(__filename, 'utf8').split(/\r?\n/).filter((l) => l.startsWith('//'));
    const fim = linhas.findIndex((l, i) => i > 0 && /^\/\/ =+$/.test(l));
    console.log(linhas.slice(1, fim < 0 ? -1 : fim).map((l) => l.slice(3)).join('\n'));
    return;
  }
  if (cmd === 'show') { print(T.readTasks(dataDir).lists.find((l) => l.id === listId)); return; }

  // O elo e resolvido FORA da trava: erro de formato tem de sair antes de abrir o
  // arquivo, e o aviso da sessao que falta e so uma olhada no disco.
  if (opts.node != null && cmd !== 'add' && cmd !== 'start') {
    fail('--node so vale em `add` e `start`; para ligar uma tarefa que ja existe use: link <n> <sessao>/<no>');
  }
  if (cmd === 'link' && !rest[1]) fail('uso: link <n> <sessao>/<no>');
  const noOpt = opts.node != null ? elo(opts.node) : null;
  const noLink = cmd === 'link' ? elo(rest[1]) : null;
  const alvo = noLink || noOpt;
  if (alvo && !fs.existsSync(path.join(dataDir, alvo.session))) {
    console.log('aviso: a sessao "' + alvo.session + '" ainda nao existe neste projeto — o elo fica gravado e acende quando o desenho existir');
  }

  // O plano tambem e lido FORA da trava: sessao sem desenho ou sem etapa aprovada
  // tem de sair antes de abrir o arquivo, pra lista que ja existe ficar INTACTA.
  let plano = null;
  if (cmd === 'from-plan') {
    const sessao = String(rest[0] || '').trim();
    if (!sessao) fail('uso: from-plan <sessao> ["<objetivo>"]');
    if (!fs.existsSync(path.join(dataDir, sessao))) fail('a sessao "' + sessao + '" nao existe neste projeto — desenhe o plano nela primeiro');
    plano = lePlano(dataDir, sessao);
    if (!plano.temDesenho) fail('a sessao "' + sessao + '" nao tem fluxograma (o modelo `process` esta vazio) — desenhe o plano antes de executa-lo');
    if (!plano.trabalho.length) {
      fail('o fluxograma de "' + sessao + '" nao tem etapa de trabalho (kind `task` ou `subprocess`) — inicio, fim, decisao, gateway, evento, anotacao e objeto de dados nao viram tarefa');
    }
    if (!plano.aprovadas.length) {
      fail('nenhuma das ' + plano.trabalho.length + ' etapas de "' + sessao + '" esta aprovada:\n'
        + plano.fora.map((n) => '  - "' + tituloDaEtapa(n) + '" (' + n.id + '): ' + motivoDeFora(n)).join('\n')
        + '\n  aprovar e gesto do usuario: peca a revisao no canvas e rode este comando de novo.');
    }
  }

  const STATUS_BY_CMD = { start: 'in_progress', done: 'completed', block: 'blocked', reset: 'pending' };
  let shown = null;
  const relato = [];
  T.updateTasks(dataDir, (file) => {
    let list = file.lists.find((l) => l.id === listId);
    const ensure = () => {
      if (!list) { list = { id: listId, label, updatedAt: now, tasks: [] }; file.lists.push(list); }
      list.label = label;
      list.updatedAt = now;
      return list;
    };
    const pick = (ref) => {
      if (!list) fail('nao ha lista "' + listId + '" — comece com: plan "<objetivo>" "<tarefa>" ...');
      const n = Number(ref);
      const task = Number.isInteger(n) && n >= 1 ? list.tasks[n - 1] : list.tasks.find((t) => t.id === ref);
      if (!task) fail('tarefa "' + ref + '" nao existe (a lista tem ' + list.tasks.length + ')');
      return task;
    };

    if (cmd === 'plan') {
      if (rest.length < 2) fail('uso: plan "<objetivo>" "<tarefa>" ["<tarefa>" ...]');
      ensure();
      list.title = rest[0];
      list.tasks = rest.slice(1).map((title, i) => ({ id: 't' + (i + 1), title, status: 'pending', updatedAt: now }));
    } else if (cmd === 'from-plan') {
      ensure();
      list.title = rest[1] || plano.titulo;
      const antes = list.tasks;
      const usados = new Set(antes.map((t) => t.id));
      const novoId = () => { let k = antes.length + 1; while (usados.has('t' + k)) k++; usados.add('t' + k); return 't' + k; };

      // Reconciliar em vez de refazer: rodar de novo depois de uma revisao nova nao
      // pode perder andamento. A tarefa e reencontrada pelo ELO — o titulo muda quando
      // o usuario renomeia a etapa, o id da tarefa nao.
      const porNo = new Map();
      for (const t of antes) {
        if (t.node && t.node.session === plano.sessao && !porNo.has(t.node.id)) porNo.set(t.node.id, t);
      }
      const reaproveitadas = new Set();
      const lista = [];
      for (const no of plano.aprovadas) {
        const existente = porNo.get(no.id);
        if (!existente) {
          lista.push({ id: novoId(), title: tituloDaEtapa(no), status: 'pending', updatedAt: now, node: { session: plano.sessao, id: no.id } });
          relato.push('  + "' + tituloDaEtapa(no) + '" (' + no.id + '): etapa nova aprovada');
          continue;
        }
        reaproveitadas.add(existente);
        existente.title = tituloDaEtapa(no); // o desenho manda no texto da etapa
        // etapa que a reconciliacao tinha travado e voltou a ser aprovada volta a
        // pendente: manter o motivo velho seria travar trabalho ja liberado.
        if (existente.status === 'blocked' && eNotaDaReconciliacao(existente.note)) {
          existente.status = 'pending';
          delete existente.note;
          existente.updatedAt = now;
          relato.push('  ~ "' + existente.title + '" (' + no.id + '): destravada — o usuario aprovou a etapa de novo');
        }
        lista.push(existente);
      }

      // O que sobrou nao some. Etapa que deixou de estar aprovada vira `blocked` com
      // o motivo: sumir esconderia do usuario que algo planejado nao vai ser feito.
      // Tarefa que o agente acrescentou a mao (sem elo, ou ligada a um no de outra
      // sessao ou de outra lente) e preservada como esta — ela nao e do plano.
      for (const t of antes) {
        if (reaproveitadas.has(t)) continue;
        const no = t.node && t.node.session === plano.sessao ? plano.porId.get(t.node.id) : null;
        if (no && KINDS_DE_TRABALHO.includes(no.kind) && no.status !== 'approved') {
          t.status = 'blocked';
          t.note = motivoDoBloqueio(no);
          t.updatedAt = now;
          relato.push('  ! "' + t.title + '" (' + no.id + '): travada — ' + t.note);
        }
        lista.push(t);
      }

      // Ordem de leitura do fluxo; quem nao esta no desenho vai pro fim, na ordem
      // em que ja estava (ordenacao estavel: empate preserva a posicao relativa).
      const posicaoDe = (t) => (t.node && t.node.session === plano.sessao && plano.posicao.has(t.node.id)
        ? plano.posicao.get(t.node.id) : Number.MAX_SAFE_INTEGER);
      list.tasks = lista
        .map((t, i) => ({ t, i, p: posicaoDe(t) }))
        .sort((a, b) => (a.p - b.p) || (a.i - b.i))
        .map((x) => x.t);
    } else if (cmd === 'add') {
      if (!rest[0]) fail('uso: add "<tarefa>"');
      ensure();
      const used = new Set(list.tasks.map((t) => t.id));
      let k = list.tasks.length + 1;
      while (used.has('t' + k)) k++;
      list.tasks.push({ id: 't' + k, title: rest[0], status: 'pending', updatedAt: now, ...(noOpt ? { node: noOpt } : {}) });
    } else if (STATUS_BY_CMD[cmd]) {
      if (!rest[0]) fail('uso: ' + cmd + ' <n> ["nota"]');
      if (cmd === 'block' && !rest[1]) fail('uso: block <n> "<motivo>" — travou por que?');
      const task = pick(rest[0]);
      // A TRAVA do plano: so se executa o que o usuario aprovou. Vale no `start`
      // porque e ele que comeca o trabalho — `done`, `block` e `note` so contam o
      // que ja aconteceu, e travar ali deixaria uma tarefa presa em andamento.
      if (cmd === 'start' && !opts.force) {
        const ref = noOpt || task.node;
        const etapa = etapaQueTrava(dataDir, ref);
        if (etapa) {
          fail('a etapa "' + tituloDaEtapa(etapa) + '" (' + ref.session + '/' + etapa.id + ') esta "'
            + (etapa.status || 'proposed') + '", e o plano so executa o que o usuario aprovou.\n'
            + '  peca a revisao no canvas (ele aprova, questiona ou reprova e clica Analisar) e rode: tasks.js from-plan ' + ref.session + '\n'
            + '  se ele mandou seguir assim mesmo: tasks.js start ' + rest[0] + ' --force');
        }
      }
      task.status = STATUS_BY_CMD[cmd];
      task.updatedAt = now;
      if (rest[1]) task.note = rest[1];
      else if (cmd === 'done' || cmd === 'reset') delete task.note; // a nota era do andamento
      // pegar a tarefa e dizer onde ela mora no desenho e o mesmo gesto: `start 2 --node <sessao>/<no>`
      if (cmd === 'start' && noOpt) task.node = noOpt;
      ensure();
    } else if (cmd === 'link' || cmd === 'unlink') {
      if (!rest[0]) fail('uso: ' + (cmd === 'link' ? 'link <n> <sessao>/<no>' : 'unlink <n>'));
      const task = pick(rest[0]);
      // o elo NAO mexe no status: ligar uma tarefa a um no nao e comecar a faze-la
      if (noLink) task.node = noLink; else delete task.node;
      task.updatedAt = now;
      ensure();
    } else if (cmd === 'note') {
      if (!rest[0] || rest[1] == null) fail('uso: note <n> "<texto>"');
      const task = pick(rest[0]);
      if (rest[1]) task.note = rest[1]; else delete task.note;
      task.updatedAt = now;
      ensure();
    } else if (cmd === 'clear') {
      file.lists = file.lists.filter((l) => l.id !== listId);
      list = null;
    } else {
      fail('comando desconhecido: ' + cmd + ' (veja: help)');
    }
    shown = list;
  });

  // O que ficou de FORA e por que: sem isso o usuario nao descobre que uma etapa
  // que ele desenhou nao entrou na lista, e o silencio parece consentimento.
  if (plano) {
    console.log('plano de "' + plano.sessao + '": ' + plano.aprovadas.length + ' de ' + plano.trabalho.length + ' etapas aprovadas viraram tarefa');
    if (plano.fora.length) {
      console.log('fora da lista:');
      for (const n of plano.fora) console.log('  - "' + tituloDaEtapa(n) + '" (' + n.id + '): ' + motivoDeFora(n));
    }
    if (relato.length) {
      console.log('reconciliacao:');
      for (const l of relato) console.log(l);
    }
  }
  print(shown);
}

try {
  main();
} catch (e) {
  console.error('flowforge tasks: ' + e.message);
  process.exit(e instanceof UsageError ? 2 : 1);
}
