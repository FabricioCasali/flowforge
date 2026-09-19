#!/usr/bin/env node
// =============================================================================
// verifica-tasks.mjs — a prova das tarefas ao vivo (FF-034).
//
// O caminho inteiro, com as pecas de verdade: o comando que o agente chama
// (adapters/tasks.js) grava o <data-dir>/tasks.json, o servidor vigia a raiz e
// empurra `{type:'tasks'}` pra todo browser. Confere:
//
//   1. browser que conecta recebe as tarefas na hora (mesmo sem arquivo)
//   2. cada comando do agente chega ao browser, em QUALQUER sessao (e por projeto)
//   3. dois publicadores nao pisam um no outro, nem escrevendo ao mesmo tempo
//   4. as tarefas NAO tocam no workspace.json (rev do desenho intacto)
//   5. erro de uso nao deixa trava orfa, e arquivo torto escrito a mao nao derruba nada
//   6. o ELO com um no do desenho (issue #8): entra pelo comando, chega ao browser,
//      aguenta lixo no campo, e ligar/mudar de status nao mexe no workspace.json
//   7. o PLANO aprovado (issue #9): `from-plan` tira a lista do fluxograma revisado
//      pelo usuario (so as etapas aprovadas, na ordem do fluxo, ja ligadas ao no),
//      reconcilia sem perder andamento, e o `start` recusa etapa nao aprovada
//
// Uso: node scripts/verifica-tasks.mjs      (exit 1 se algo falhar)
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-tasks-'));
const projectPath = path.join(tempRoot, 'projeto');
const dataDir = path.join(projectPath, '.flowforge');
fs.mkdirSync(path.join(projectPath, 'src', 'fundo'), { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLI = path.join(ROOT, 'adapters', 'tasks.js');
// ambiente limpo: o palpite de "quem sou eu" nao pode depender de onde o teste roda
const envLimpo = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|OPENCODE|CODEX|FLOWFORGE_TASKS)/.test(k)));
// `timeout` nao e luxo: um percurso de fluxo com laco que rodasse pra sempre
// penduraria o verificador inteiro em vez de acusar a falha.
const tasks = (args, { cwd = projectPath, env = {}, timeout = 20000 } = {}) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...envLimpo, ...env }, encoding: 'utf8', timeout });

// ---- o plano desenhado numa sessao (issue #9) ------------------------------
// O plano nao tem formato proprio: e o modelo `process`, com as etapas de trabalho
// levando o veredito que o usuario deu no browser.
const no = (id, label, kind, status, texto) => ({
  id, label, kind, status,
  comments: texto ? [{ author: 'user', kind: status === 'rejected' ? 'reject' : 'question', text: texto, ts: 1 }] : [],
});
const seta = (id, source, target, label) => ({ id, source, target, label: label || '', status: 'proposed' });

function escrevePlano(dataDir, slug, nodes, edges) {
  const dir = path.join(dataDir, slug);
  fs.mkdirSync(dir, { recursive: true });
  const t = 'Plano ' + slug;
  fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify({
    title: t,
    process: { type: 'flowchart', title: t, rev: 1, updatedBy: 'agent', lanes: [], nodes, edges },
    state: { type: 'flowchart', title: t, rev: 0, updatedBy: 'user', lanes: [], nodes: [], edges: [] },
    er: { type: 'er', title: t, rev: 0, updatedBy: 'user', lanes: [], nodes: [], edges: [] },
    // uma ideia solta no mapa mental: e o no de OUTRA lente, que a trava nao pode travar
    mind: { type: 'mindmap', title: t, rev: 0, updatedBy: 'user', lanes: [], nodes: [no('m1', 'ideia solta', 'idea', 'proposed')], edges: [] },
    seq: { participants: [], messages: [] },
    rev: 1, updatedBy: 'agent',
  }, null, 2));
}

// O desenho do plano: inicio, uma decisao com caminho principal (n4) e desvio (n5),
// um laco de volta (e8) e uma anotacao solta. So `task` e `subprocess` sao trabalho.
const planoNos = (statusN4, statusN6) => [
  no('n1', 'Inicio', 'start', 'approved'),
  no('n2', 'ler o codigo', 'task', 'approved'),
  no('n3', 'passou?', 'decision', 'approved'),
  no('n4', 'escrever o teste', 'task', statusN4, statusN4 === 'questioned' ? 'e o refresh do token?' : ''),
  no('n5', 'trocar a lib', 'task', 'rejected', 'nao quero dependencia nova'),
  no('n6', 'refatorar o handler', 'subprocess', statusN6),
  no('n7', 'nota de rodape', 'annotation', 'approved'),
  no('n8', 'Fim', 'end', 'approved'),
];
const planoSetas = [
  seta('e1', 'n1', 'n2'), seta('e2', 'n2', 'n3'),
  seta('e3', 'n3', 'n4', 'sim'), seta('e4', 'n3', 'n5', 'nao'),
  seta('e5', 'n4', 'n6'), seta('e6', 'n6', 'n8'), seta('e7', 'n5', 'n8'),
  seta('e8', 'n4', 'n3'), // laco de volta: o percurso tem de terminar mesmo assim
];

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function openBrowser(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.tasks = null;
    ws.state = null;
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'tasks') ws.tasks = m.tasks;
      if (m.type === 'state') ws.state = m;
    });
    ws.until = async (pred, what, timeout = 5000) => {
      const t0 = Date.now();
      while (!(ws.tasks && pred(ws.tasks))) {
        if (Date.now() - t0 > timeout) throw new Error('timeout esperando ' + what + ' — ultimo: ' + JSON.stringify(ws.tasks));
        await sleep(40);
      }
      return ws.tasks;
    };
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

async function main() {
  const port = await freePort();
  const server = spawn(process.execPath, ['server/index.js', '--port', String(port), '--data-dir', dataDir], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  server.stdout.on('data', (c) => { out += c; });
  server.stderr.on('data', (c) => { out += c; });
  const casos = [];
  const ok = (nome, cond) => casos.push([nome, !!cond]);

  try {
    for (let i = 0; i < 50 && !out.includes('FlowForge server em'); i++) await sleep(100);
    assert.ok(out.includes('FlowForge server em'), 'servidor nao subiu:\n' + out);

    // ---- 1. conexao ----
    const a = await openBrowser(`ws://127.0.0.1:${port}/ws?session=desenho-a`);
    const b = await openBrowser(`ws://127.0.0.1:${port}/ws?session=desenho-b`);
    await a.until(() => true, 'tarefas iniciais');
    ok('browser recebe as tarefas ao conectar, mesmo sem arquivo', a.tasks.rev === 0 && a.tasks.lists.length === 0);
    for (let i = 0; i < 50 && !a.state; i++) await sleep(40);
    const revDesenho = a.state.workspace.rev;

    // ---- 2. o agente publica, de uma SUBPASTA do projeto ----
    const plan = tasks(['plan', 'Migrar o login', 'ler o codigo', 'escrever o teste', 'trocar a lib'], { cwd: path.join(projectPath, 'src', 'fundo'), env: { CLAUDECODE: '1' } });
    ok('plan roda e acha o .flowforge subindo da subpasta', plan.status === 0 && fs.existsSync(path.join(dataDir, 'tasks.json')));
    const t1 = await a.until((t) => t.lists.length === 1, 'plano no browser A');
    ok('plano chega ao browser com publicador, objetivo e 3 pendentes', t1.lists[0].id === 'claude-code' && t1.lists[0].label === 'Claude Code'
      && t1.lists[0].title === 'Migrar o login' && t1.lists[0].tasks.every((t) => t.status === 'pending') && t1.lists[0].tasks.length === 3);
    await b.until((t) => t.lists.length === 1, 'plano no browser B');
    ok('tarefas sao do PROJETO: chegam tambem a outra sessao de desenho', b.tasks.lists[0].title === 'Migrar o login');

    tasks(['start', '1', 'lendo auth.ts'], { env: { CLAUDECODE: '1' } });
    const t2 = await a.until((t) => t.lists[0]?.tasks[0].status === 'in_progress', 'start');
    ok('start marca em andamento com a nota', t2.lists[0].tasks[0].note === 'lendo auth.ts');

    tasks(['done', '1'], { env: { CLAUDECODE: '1' } });
    tasks(['block', 't2', 'falta decidir o framework'], { env: { CLAUDECODE: '1' } });
    const t3 = await a.until((t) => t.lists[0]?.tasks[1].status === 'blocked', 'done + block');
    ok('done conclui e limpa a nota de andamento', t3.lists[0].tasks[0].status === 'completed' && t3.lists[0].tasks[0].note === undefined);
    ok('block aceita o id da tarefa e guarda o motivo', t3.lists[0].tasks[1].note === 'falta decidir o framework');

    tasks(['add', 'avisar o time'], { env: { CLAUDECODE: '1' } });
    const t4 = await a.until((t) => t.lists[0]?.tasks.length === 4, 'add');
    ok('add acrescenta no fim com id novo', t4.lists[0].tasks[3].id === 't4' && t4.lists[0].tasks[3].status === 'pending');
    ok('o rev do tasks.json sobe a cada escrita', t4.rev === 5);

    // ---- 3. segundo publicador, e escrita simultanea ----
    tasks(['plan', 'Revisar o PR', 'ler o diff'], { env: { CODEX_THREAD_ID: 'x' } });
    const t5 = await a.until((t) => t.lists.length === 2, 'segunda lista');
    ok('segundo harness ganha lista propria; a primeira fica intacta', t5.lists[1].id === 'codex' && t5.lists[0].tasks.length === 4);

    const N = 12;
    await Promise.all(Array.from({ length: N }, (_, i) => new Promise((res) => {
      const p = spawn(process.execPath, [CLI, 'add', 'paralela ' + i, '--list', i % 2 ? 'par-a' : 'par-b'], { cwd: projectPath, env: envLimpo });
      p.on('close', res);
    })));
    const t6 = await a.until((t) => t.lists.filter((l) => l.id.startsWith('par-')).reduce((s, l) => s + l.tasks.length, 0) === N, N + ' escritas simultaneas', 8000);
    ok(N + ' escritas simultaneas: nenhuma se perde (trava do arquivo)', t6.lists.length === 4);
    ok('nenhuma trava ou temporario sobra na raiz', !fs.readdirSync(dataDir).some((f) => /\.(lock|tmp)$/.test(f)));

    // ---- 3b. quem publica, quando um harness e aberto de dentro do terminal de outro ----
    {
      const { whoAmI } = await import(pathToFileURL(path.join(ROOT, 'adapters', 'project.js')).href).then((m) => m.default ?? m);
      const quem = (env, chain) => whoAmI(env, () => chain).id;
      const dois = { CLAUDECODE: '1', OPENCODE: '1', OPENCODE_PID: '50' };
      ok('publicador: um harness so e reconhecido pelo ambiente', quem({ CLAUDECODE: '1' }, []) === 'claude-code'
        && quem({ OPENCODE: '1', OPENCODE_PID: '50' }, []) === 'opencode' && quem({}, []) === 'cli');
      ok('publicador: OpenCode aberto DENTRO do Claude Code publica como OpenCode',
        quem(dois, [{ pid: 70, name: 'bash.exe' }, { pid: 50, name: 'node.exe' }, { pid: 30, name: 'claude.exe' }]) === 'opencode');
      ok('publicador: Claude Code aberto DENTRO do OpenCode publica como Claude Code',
        quem(dois, [{ pid: 70, name: 'bash.exe' }, { pid: 60, name: 'claude.exe' }, { pid: 50, name: 'node.exe' }]) === 'claude-code');
      ok('publicador: FLOWFORGE_TASKS_LIST manda em tudo', quem({ ...dois, FLOWFORGE_TASKS_LIST: 'meu' }, []) === 'meu');
    }

    // ---- 3c. o ELO com um no do desenho (issue #8) ----
    // A sessao 'desenho-a' existe (o browser A a abriu); 'desenho-z' nunca foi aberta.
    const wsPath = path.join(dataDir, 'desenho-a', 'workspace.json');
    {
      const semSessao = tasks(['link', '3', 'desenho-z/n1'], { env: { CLAUDECODE: '1' } });
      ok('link aceita sessao que ainda nao existe (da pra planejar antes de desenhar), mas AVISA',
        semSessao.status === 0 && /aviso/.test(semSessao.stdout) && /desenho-z/.test(semSessao.stdout));
      const e1 = await a.until((t) => !!t.lists[0]?.tasks[2]?.node, 'elo no browser');
      ok('o elo chega ao browser com sessao e id', e1.lists[0].tasks[2].node.session === 'desenho-z' && e1.lists[0].tasks[2].node.id === 'n1');
      ok('link NAO mexe no status da tarefa', e1.lists[0].tasks[2].status === 'pending');
      ok('tarefa sem elo continua sem `node`', e1.lists[0].tasks[3].node === undefined && e1.lists[0].tasks[0].node === undefined);

      const comNo = tasks(['start', '3', '--node', 'desenho-a/n7'], { env: { CLAUDECODE: '1' } });
      ok('start --node nao avisa quando a sessao existe', comNo.status === 0 && !/aviso/.test(comNo.stdout));
      const e2 = await a.until((t) => t.lists[0]?.tasks[2]?.node?.id === 'n7', 'start --node');
      ok('start --node marca em andamento E liga ao no (um gesto so)', e2.lists[0].tasks[2].status === 'in_progress');

      tasks(['add', 'desenhar o retorno', '--node', 'desenho-a/n8'], { env: { CLAUDECODE: '1' } });
      const e3 = await a.until((t) => t.lists[0]?.tasks.length === 5, 'add --node');
      ok('add --node ja nasce ligada, e pendente', e3.lists[0].tasks[4].node.id === 'n8' && e3.lists[0].tasks[4].status === 'pending');

      ok('elo sem "/" e recusado com exit 2', tasks(['link', '3', 'desenho-a'], { env: { CLAUDECODE: '1' } }).status === 2);
      ok('link sem o elo e recusado', tasks(['link', '3'], { env: { CLAUDECODE: '1' } }).status === 2);
      ok('--node fora de add/start e recusado (para isso existe o link)',
        tasks(['done', '3', '--node', 'desenho-a/n7'], { env: { CLAUDECODE: '1' } }).status === 2);

      // o realce e DERIVADO: a tarefa ligada muda de status e o desenho nao e tocado
      const revAntes = JSON.parse(fs.readFileSync(wsPath, 'utf8')).rev;
      tasks(['block', '3', 'esperando decisao'], { env: { CLAUDECODE: '1' } });
      const e4 = await a.until((t) => t.lists[0]?.tasks[2]?.status === 'blocked', 'block da tarefa ligada');
      ok('tarefa ligada que trava mantem o elo', e4.lists[0].tasks[2].node.id === 'n7');
      tasks(['done', '3'], { env: { CLAUDECODE: '1' } });
      await a.until((t) => t.lists[0]?.tasks[2]?.status === 'completed', 'done da tarefa ligada');
      const depois = JSON.parse(fs.readFileSync(wsPath, 'utf8'));
      ok('tarefa LIGADA mudando de status NAO mexe no workspace.json (nem rev, nem campo novo)',
        depois.rev === revAntes && !('tasks' in depois) && !JSON.stringify(depois).includes('n7'));

      tasks(['unlink', '3'], { env: { CLAUDECODE: '1' } });
      const e5 = await a.until((t) => !t.lists[0]?.tasks[2]?.node, 'unlink');
      ok('unlink desfaz o elo e deixa o resto da tarefa em paz', e5.lists[0].tasks[2].status === 'completed');
    }

    // ---- 3d. o PLANO aprovado no canvas antes de executar (issue #9) ----
    {
      const LP = ['--list', 'plano', '--label', 'Plano'];
      const lp = (t) => t.lists.find((l) => l.id === 'plano');
      const wsPlano = path.join(dataDir, 'plano-x', 'workspace.json');

      // --- da revisao no canvas para a lista de tarefas ---
      escrevePlano(dataDir, 'plano-x', planoNos('approved', 'proposed'), planoSetas);
      const fp1 = tasks(['from-plan', 'plano-x', 'Levar o login', ...LP]);
      const p1 = await a.until((t) => lp(t)?.tasks.length === 2, 'plano no browser');
      const t1p = lp(p1).tasks;
      ok('from-plan cria UMA tarefa por etapa aprovada, com o label do no e o objetivo dado',
        fp1.status === 0 && lp(p1).title === 'Levar o login'
        && t1p[0].title === 'ler o codigo' && t1p[1].title === 'escrever o teste');
      ok('as tarefas do plano ja nascem ligadas ao no (session + id) e pendentes',
        t1p.every((t) => t.node?.session === 'plano-x' && t.status === 'pending')
        && t1p[0].node.id === 'n2' && t1p[1].node.id === 'n4');
      ok('inicio, fim, decisao e anotacao NAO viram tarefa',
        !t1p.some((t) => ['n1', 'n3', 'n7', 'n8'].includes(t.node.id)));
      ok('etapa reprovada e etapa ainda proposta ficam de fora da lista',
        !t1p.some((t) => ['n5', 'n6'].includes(t.node.id)));
      ok('from-plan imprime o que ficou de fora e POR QUE',
        /trocar a lib/.test(fp1.stdout) && /reprovada/.test(fp1.stdout)
        && /refatorar o handler/.test(fp1.stdout) && /ainda proposta/.test(fp1.stdout));

      // --- o andamento, e uma tarefa que o agente acrescentou a mao ---
      ok('start numa etapa APROVADA passa direto', tasks(['start', '1', 'lendo auth.ts', ...LP]).status === 0);
      tasks(['add', 'avisar o time', ...LP]);
      await a.until((t) => lp(t)?.tasks.length === 3, 'add manual');

      // --- o usuario revisa de novo: questiona a n4 e aprova a n6 ---
      escrevePlano(dataDir, 'plano-x', planoNos('questioned', 'approved'), planoSetas);
      const wsIntacto = fs.readFileSync(wsPlano, 'utf8');
      const fp2 = tasks(['from-plan', 'plano-x', ...LP]);
      const p2 = await a.until((t) => lp(t)?.tasks.length === 4, 'reconciliacao');
      const t2p = lp(p2).tasks;
      ok('rodar de novo preserva o andamento e a nota da etapa que continua aprovada',
        fp2.status === 0 && t2p[0].node.id === 'n2' && t2p[0].status === 'in_progress' && t2p[0].note === 'lendo auth.ts');
      ok('etapa que virou questionada vira `blocked` com o motivo (o comentario do usuario), em vez de sumir',
        t2p[1].node.id === 'n4' && t2p[1].status === 'blocked' && t2p[1].note === 'etapa questionada: e o refresh do token?');
      ok('etapa nova aprovada entra no lugar certo da ordem do fluxo',
        t2p[2].node.id === 'n6' && t2p[2].title === 'refatorar o handler' && t2p[2].status === 'pending');
      ok('tarefa que o agente acrescentou a mao (sem elo) e preservada',
        t2p[3].title === 'avisar o time' && t2p[3].node === undefined);
      // a ordem sai do GRAFO, nao do array: no `nodes[]` a n5 (desvio) vem antes da n6
      // (continuacao do caminho principal), e o percurso inverte as duas. E o laco
      // e8 (n4 -> n3) prova de quebra que o percurso termina em vez de rodar pra sempre.
      ok('a ordem sai do percurso do fluxo (principal antes do desvio), e o laco nao vira loop infinito',
        fp1.status === 0 && fp2.status === 0
        && fp1.stdout.indexOf('refatorar o handler') < fp1.stdout.indexOf('trocar a lib'));

      // --- a trava: so se executa o que o usuario aprovou ---
      const trava = tasks(['start', '2', ...LP]);
      ok('start numa etapa NAO aprovada e recusado com exit 2, dizendo o status e o que fazer',
        trava.status === 2 && /questioned/.test(trava.stderr) && /from-plan plano-x/.test(trava.stderr) && /--force/.test(trava.stderr));
      ok('a recusa nao mexe na tarefa nem deixa trava orfa',
        lp(a.tasks).tasks[1].status === 'blocked' && !fs.existsSync(path.join(dataDir, 'tasks.json.lock')));
      ok('--force executa assim mesmo (o usuario mandou seguir)', tasks(['start', '2', '--force', ...LP]).status === 0);
      await a.until((t) => lp(t)?.tasks[1].status === 'in_progress', 'start forcado');

      ok('start numa tarefa SEM elo nao e travado', tasks(['start', '4', ...LP]).status === 0);
      tasks(['link', '4', 'plano-x/m1', ...LP]);
      ok('start numa tarefa ligada a no de MAPA MENTAL nao e travado (a trava e do plano)',
        tasks(['start', '4', ...LP]).status === 0);
      tasks(['link', '4', 'nem-existe/n1', ...LP]);
      ok('sessao inexistente nao trava o start (continua so o aviso)', tasks(['start', '4', ...LP]).status === 0);

      // --- recusas do from-plan: sempre com a lista INTACTA ---
      const listaAntes = fs.readFileSync(path.join(dataDir, 'tasks.json'), 'utf8');
      const semSessao = tasks(['from-plan', 'nem-existe', ...LP]);
      ok('from-plan de sessao inexistente: exit 2 e mensagem clara',
        semSessao.status === 2 && /nao existe/.test(semSessao.stderr));
      escrevePlano(dataDir, 'plano-vazio', [], []);
      const vazio = tasks(['from-plan', 'plano-vazio', ...LP]);
      ok('sessao sem `process` desenhado: exit 2, mandando desenhar o plano antes',
        vazio.status === 2 && /process/.test(vazio.stderr) && /desenhe/.test(vazio.stderr));
      escrevePlano(dataDir, 'plano-so-fluxo',
        [no('n1', 'Inicio', 'start', 'approved'), no('n2', 'deu certo?', 'decision', 'approved'), no('n3', 'Fim', 'end', 'approved')],
        [seta('e1', 'n1', 'n2'), seta('e2', 'n2', 'n3')]);
      const soFluxo = tasks(['from-plan', 'plano-so-fluxo', ...LP]);
      ok('fluxo so com inicio, decisao e fim: exit 2, dizendo que nao ha etapa de trabalho',
        soFluxo.status === 2 && /etapa de trabalho/.test(soFluxo.stderr));
      escrevePlano(dataDir, 'plano-cru',
        [no('n1', 'Inicio', 'start', 'approved'), no('n2', 'pensar', 'task', 'proposed'), no('n3', 'Fim', 'end', 'approved')],
        [seta('e1', 'n1', 'n2'), seta('e2', 'n2', 'n3')]);
      const cru = tasks(['from-plan', 'plano-cru', ...LP]);
      ok('nenhuma etapa aprovada: exit 2, com o motivo de cada uma e a lembranca de que aprovar e gesto do usuario',
        cru.status === 2 && /nenhuma/.test(cru.stderr) && /ainda proposta/.test(cru.stderr) && /gesto do usuario/.test(cru.stderr));
      ok('recusa do from-plan nao toca na lista que ja existe',
        fs.readFileSync(path.join(dataDir, 'tasks.json'), 'utf8') === listaAntes);

      // --- e o desenho nunca e escrito por estes comandos ---
      ok('from-plan, start e a trava NUNCA escrevem no workspace.json (arquivo intacto byte a byte)',
        fs.readFileSync(wsPlano, 'utf8') === wsIntacto && JSON.parse(wsIntacto).rev === 1);

      tasks(['clear', ...LP]);
      await a.until((t) => !lp(t), 'clear do plano');
    }

    // ---- 4. nao toca no desenho ----
    const ws = JSON.parse(fs.readFileSync(path.join(dataDir, 'desenho-a', 'workspace.json'), 'utf8'));
    ok('as tarefas NAO sobem o rev do workspace', ws.rev === revDesenho && !('tasks' in ws));
    const sessions = await (await fetch(`http://127.0.0.1:${port}/api/sessions`)).json();
    ok('tasks.json na raiz nao vira sessao', !sessions.sessions.some((s) => /tasks/.test(s)));

    // ---- 5. erros ----
    const ruim = tasks(['start', '99'], { env: { CLAUDECODE: '1' } });
    ok('tarefa inexistente: exit 2, mensagem clara e SEM trava orfa', ruim.status === 2 && /nao existe/.test(ruim.stderr) && !fs.existsSync(path.join(dataDir, 'tasks.json.lock')));
    ok('block sem motivo e recusado', tasks(['block', '1'], { env: { CLAUDECODE: '1' } }).status === 2);

    fs.writeFileSync(path.join(dataDir, 'tasks.json'), JSON.stringify({ rev: 'x', lists: [{ id: 'mao', tasks: [{ title: 'so titulo', status: 'inventado' }, 7] }, { semId: true }] }));
    const t7 = await a.until((t) => t.lists.length === 1 && t.lists[0].id === 'mao', 'arquivo escrito a mao');
    ok('arquivo torto escrito a mao e normalizado, nao derruba o canvas', t7.rev === 0 && t7.lists[0].label === 'mao'
      && t7.lists[0].tasks.length === 1 && t7.lists[0].tasks[0].status === 'pending' && t7.lists[0].tasks[0].id === 't1');

    tasks(['clear', '--list', 'mao']);
    const t8 = await a.until((t) => t.lists.length === 0, 'clear');
    ok('clear tira a lista do canvas', t8.lists.length === 0);

    // elo torto escrito a mao: meio elo e lixo e some, o elo bom sobrevive, e a
    // tarefa continua chegando inteira — um `node` errado nao pode apagar tarefa
    fs.writeFileSync(path.join(dataDir, 'tasks.json'), JSON.stringify({ rev: 9, lists: [{ id: 'mao', label: 'Mao', updatedAt: 1, tasks: [
      { id: 'a', title: 'so a sessao', status: 'in_progress', node: { session: 'desenho-a' } },
      { id: 'b', title: 'so o id', status: 'in_progress', node: { id: 'n1' } },
      { id: 'c', title: 'elo como texto', status: 'in_progress', node: 'desenho-a/n1' },
      { id: 'd', title: 'elo em branco', status: 'in_progress', node: { session: '  ', id: 'n1' } },
      { id: 'e', title: 'elo bom', status: 'in_progress', node: { session: 'desenho-a', id: 'n1', lente: 'inventada' } },
    ] }] }));
    const t9 = await a.until((t) => t.lists.length === 1 && t.lists[0].tasks.length === 5, 'elos tortos');
    const porId = Object.fromEntries(t9.lists[0].tasks.map((t) => [t.id, t]));
    ok('meio elo (so sessao, so id, texto, em branco) e descartado na leitura',
      !porId.a.node && !porId.b.node && !porId.c.node && !porId.d.node);
    ok('o elo bom sobrevive, e so com os dois campos do contrato',
      porId.e.node.session === 'desenho-a' && porId.e.node.id === 'n1' && Object.keys(porId.e.node).length === 2);
    ok('elo torto nao derruba a tarefa: as 5 continuam no canvas', t9.lists[0].tasks.every((t) => t.title));
    tasks(['clear', '--list', 'mao']);
    await a.until((t) => t.lists.length === 0, 'clear final');

    a.close(); b.close();
  } finally {
    server.kill();
    await sleep(200);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  let falhas = 0;
  for (const [nome, passou] of casos) {
    console.log((passou ? '   ok    ' : '   FALHA ') + nome);
    if (!passou) falhas++;
  }
  console.log(falhas ? `\nVEREDITO: FALHA — ${falhas} de ${casos.length}` : `\nVEREDITO: OK — ${casos.length} casos`);
  process.exit(falhas ? 1 : 0);
}

main().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
