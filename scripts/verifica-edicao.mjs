#!/usr/bin/env node
// =============================================================================
// verifica-edicao.mjs — a PROVA do caminho de ESCRITA (fase 2 do porte).
//
// Todo card de edicao (FF-004 inspector, FF-005 criar/ligar, FF-006 aresta/ER/
// raias) termina no mesmo lugar: um patch lens-aware que o servidor grava com
// `writeWorkspaceLens`. Se esse caminho perder campo ou errar o rev, o loop vivo
// quebra e o Fabricio perde trabalho — entao ele e testado aqui, com os
// diagramas REAIS, e nao so na mao.
//
// O que este script prova, por diagrama:
//   1. a edicao chega     — o campo alterado esta no arquivo
//   2. o rev sobe UM      — lei 6: o servidor e a autoridade do rev
//   3. `updatedBy` bate   — user na escrita do browser, claude na do Claude
//   4. o resto nao mexe   — os outros 4 modelos ficam identicos, e o no editado
//                           preserva x/y, comments, fields e lane
//   5. o diagram.json fica intacto — lei 5, migracao nao destrutiva
//
// Nao toca nos dados reais: tudo sobre copia.
//
// Uso:
//   node scripts/verifica-edicao.mjs
//   node scripts/verifica-edicao.mjs --autoteste   # prova que sabe FALHAR
// =============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, '..');
const S = require(path.join(RAIZ, 'server', 'state.js'));

const RAIZES = [
  { rotulo: 'flowforge/sessions', dir: 'C:/desenv/particular/flowforge/sessions' },
  { rotulo: 'flowforge', dir: 'C:/desenv/particular/flowforge/.flowforge' },
  { rotulo: 'context_builder', dir: 'C:/desenv/particular/context_builder/.flowforge' },
  { rotulo: 'poe2', dir: 'C:/desenv/particular/poe2 - overlay + pob/.flowforge' },
  { rotulo: 'th_framework', dir: 'C:/desenv/thealth_projects/th_framework/.flowforge' },
];

const OUTROS_MODELOS = { process: ['state', 'er', 'mind', 'seq'], er: ['process', 'state', 'mind', 'seq'], mind: ['process', 'state', 'er', 'seq'] };

function sha(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
function clone(o) { return JSON.parse(JSON.stringify(o)); }

function listarDiagramas() {
  const achados = [];
  const usados = new Set();
  for (const { rotulo, dir } of RAIZES) {
    let entradas = [];
    try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entradas) {
      if (!e.isDirectory()) continue;
      // Sessao vale se tem QUALQUER um dos dois arquivos-verdade. Antes so o
      // diagram.json contava — e depois do FF-008 sessao nova nao tem mais esse
      // arquivo, entao ela nasceria INVISIVEL pro teste e a cobertura degradaria
      // sozinha com o tempo.
      const diag = path.join(dir, e.name, 'diagram.json');
      const wsp = path.join(dir, e.name, 'workspace.json');
      if (!fs.existsSync(diag) && !fs.existsSync(wsp)) continue;
      let slug = e.name;
      while (usados.has(slug)) slug = `${rotulo.replace(/[^a-z0-9]+/gi, '-')}-${slug}`;
      usados.add(slug);
      achados.push({ rotulo, sessao: e.name, slug, origem: path.join(dir, e.name), diagramaOrigem: diag });
    }
  }
  return achados;
}

/** Qual modelo do workspace tem conteudo (e onde a edicao vai bater). */
function modeloComConteudo(ws) {
  for (const k of ['process', 'er', 'mind', 'state']) {
    if (ws[k] && (ws[k].nodes || []).length) return k;
  }
  return null;
}

// ---------------------------------------------------------------------------
// a prova
// ---------------------------------------------------------------------------

function avalia(alvo, raizCopia) {
  const problemas = [];
  // Sessao nascida depois do FF-008 nao tem diagram.json — e isso e o normal.
  const temLegado = fs.existsSync(alvo.diagramaOrigem);
  const bruto = temLegado ? fs.readFileSync(alvo.diagramaOrigem) : null;
  const hashDiagramaAntes = temLegado ? sha(bruto) : null;

  const destino = path.join(raizCopia, alvo.slug);
  fs.mkdirSync(destino, { recursive: true });
  if (temLegado) fs.writeFileSync(path.join(destino, 'diagram.json'), bruto);

  // Sessao que NASCEU no /v2 tem o conteudo no workspace.json e um diagram.json
  // esqueleto (o servidor cria um pro editor antigo). Copiar o workspace faz o
  // teste valer pra esse caso — que vira o normal depois do FF-008.
  const wsOrigem = path.join(alvo.origem, 'workspace.json');
  if (fs.existsSync(wsOrigem)) fs.copyFileSync(wsOrigem, path.join(destino, 'workspace.json'));

  S.setDataDir(raizCopia);
  S.ensureSession(alvo.slug);

  const antes = S.readWorkspace(alvo.slug);
  const lens = modeloComConteudo(antes);
  if (!lens) return { alvo, problemas: [{ msg: 'workspace migrou sem nenhum modelo com conteudo' }], lens: null };

  const revAntes = Number(antes.rev) || 0;
  const noAlvo = antes[lens].nodes[0];
  const idAlvo = noAlvo.id;
  const vizinho = antes[lens].nodes[1] || null;

  // ---- a edicao, exatamente como o NodeCard monta o patch ----
  const modelo = clone(antes[lens]);
  modelo.nodes = modelo.nodes.map((n) => (n.id === idAlvo
    ? { ...n, label: 'ROTULO EDITADO PELO TESTE', description: 'descricao nova', comments: [...(n.comments || []), { author: 'user', kind: 'note', text: 'nota do teste', ts: 1 }] }
    : n));

  const depois = S.writeWorkspaceLens(alvo.slug, lens, modelo, 'user');
  if (!depois) return { alvo, problemas: [{ msg: `writeWorkspaceLens recusou a lente '${lens}'` }], lens };

  const noDepois = depois[lens].nodes.find((n) => n.id === idAlvo);

  // 1) a edicao chegou
  if (!noDepois) problemas.push({ msg: `o no editado '${idAlvo}' sumiu do arquivo` });
  else {
    if (noDepois.label !== 'ROTULO EDITADO PELO TESTE') problemas.push({ msg: `label nao gravou: '${noDepois.label}'` });
    if (noDepois.description !== 'descricao nova') problemas.push({ msg: `description nao gravou: '${noDepois.description}'` });
    if ((noDepois.comments || []).length !== (noAlvo.comments || []).length + 1) {
      problemas.push({ msg: `comments: esperava ${(noAlvo.comments || []).length + 1}, veio ${(noDepois.comments || []).length}` });
    }
    // 4a) o que NAO foi editado tem de sobreviver no mesmo no
    for (const campo of ['x', 'y', 'kind', 'status', 'lane', 'fields']) {
      const a = JSON.stringify(noAlvo[campo]);
      const b = JSON.stringify(noDepois[campo]);
      if (a !== b) problemas.push({ msg: `no editado perdeu/alterou '${campo}': ${a} -> ${b}` });
    }
  }

  // 2) rev subiu exatamente um  (lei 6)
  if ((Number(depois.rev) || 0) !== revAntes + 1) {
    problemas.push({ msg: `rev deveria ir de ${revAntes} para ${revAntes + 1} e foi para ${depois.rev}` });
  }
  // 3) updatedBy
  if (depois.updatedBy !== 'user') problemas.push({ msg: `updatedBy deveria ser 'user' e veio '${depois.updatedBy}'` });
  if (depois[lens].rev !== depois.rev) problemas.push({ msg: 'o modelo tocado nao espelhou o rev do workspace' });

  // 4b) nenhum vizinho mudou
  if (vizinho) {
    const vDepois = depois[lens].nodes.find((n) => n.id === vizinho.id);
    if (JSON.stringify(vizinho) !== JSON.stringify(vDepois)) {
      problemas.push({ msg: `o no vizinho '${vizinho.id}' mudou sem ninguem pedir` });
    }
  }
  // 4c) as outras lentes ficaram intactas
  for (const outro of (OUTROS_MODELOS[lens] || [])) {
    if (JSON.stringify(antes[outro]) !== JSON.stringify(depois[outro])) {
      problemas.push({ msg: `a lente '${outro}' mudou numa escrita de '${lens}'` });
    }
  }

  // 5) onde existe legado, ele nao pode ter sido tocado — nem na copia, nem no real (lei 5)
  if (temLegado) {
    if (sha(fs.readFileSync(path.join(destino, 'diagram.json'))) !== hashDiagramaAntes) {
      problemas.push({ msg: 'a escrita alterou o diagram.json da copia (lei 5)' });
    }
    if (sha(fs.readFileSync(alvo.diagramaOrigem)) !== hashDiagramaAntes) {
      problemas.push({ msg: 'o diagram.json REAL do usuario foi tocado — bug do proprio teste' });
    }
  }

  // 6) a escrita do Claude marca autoria diferente e continua subindo o rev
  const doClaude = S.writeWorkspaceLens(alvo.slug, lens, clone(depois[lens]), 'claude');
  if (doClaude.updatedBy !== 'claude') problemas.push({ msg: `escrita do Claude marcou updatedBy '${doClaude.updatedBy}'` });
  if ((Number(doClaude.rev) || 0) !== (Number(depois.rev) || 0) + 1) {
    problemas.push({ msg: 'escrita do Claude nao incrementou o rev' });
  }

  return { alvo, problemas, lens, revAntes, revDepois: doClaude.rev, nos: depois[lens].nodes.length };
}

// ---------------------------------------------------------------------------
// autoteste: o detector precisa saber acusar
// ---------------------------------------------------------------------------

function autoteste(raizCopia) {
  const casos = [];
  const slug = 'autoteste-edicao';
  const dir = path.join(raizCopia, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'diagram.json'), JSON.stringify({
    type: 'flowchart', title: 'T', rev: 7, updatedBy: 'user', lanes: [],
    nodes: [
      { id: 'a', label: 'A', kind: 'task', status: 'proposed', comments: [], description: 'd', x: 10, y: 20 },
      { id: 'b', label: 'B', kind: 'task', status: 'proposed', comments: [], x: 30, y: 40 },
    ],
    edges: [{ id: 'e1', source: 'a', target: 'b', label: '', status: 'proposed' }],
  }));
  S.setDataDir(raizCopia);
  S.ensureSession(slug);

  const ws = S.readWorkspace(slug);
  casos.push(['o rev do diagrama antigo e herdado na migracao', (Number(ws.rev) || 0) === 7]);

  // edicao normal
  const m = clone(ws.process);
  m.nodes[0].label = 'novo';
  const d1 = S.writeWorkspaceLens(slug, 'process', m, 'user');
  casos.push(['editar o label sobe o rev em 1', d1.rev === 8]);
  casos.push(['editar o label preserva x/y do no', d1.process.nodes[0].x === 10 && d1.process.nodes[0].y === 20]);
  casos.push(['editar um no nao mexe no outro', d1.process.nodes[1].label === 'B' && d1.process.nodes[1].x === 30]);
  casos.push(['editar `process` deixa `er` vazio como estava', (d1.er.nodes || []).length === 0]);

  // lente invalida tem de ser recusada, nao gravada em silencio
  casos.push(['lente invalida e recusada', S.writeWorkspaceLens(slug, 'inexistente', m, 'user') === null]);

  // arrastar (so x/y) nao pode mexer no texto
  const m2 = clone(d1.process);
  m2.nodes[0].x = 999; m2.nodes[0].y = 888;
  const d2 = S.writeWorkspaceLens(slug, 'process', m2, 'user');
  casos.push(['gravar posicao nao mexe no label nem na descricao',
    d2.process.nodes[0].label === 'novo' && d2.process.nodes[0].description === 'd' && d2.process.nodes[0].x === 999]);

  // e o detector sabe ACUSAR? forco uma perda e confiro que a comparacao pega
  const mutilado = clone(d2.process);
  delete mutilado.nodes[0].x;
  const d3 = S.writeWorkspaceLens(slug, 'process', mutilado, 'user');
  casos.push(['a checagem ACUSA um patch que veio sem x', d3.process.nodes[0].x === undefined]);

  // ---- FF-005: criar, ligar e deletar ----

  // criar um no (o que o drop da paleta manda)
  const m4 = clone(d3.process);
  m4.nodes.push({ id: 'novo1', label: 'nova tarefa', kind: 'task', status: 'proposed', comments: [], description: '', x: 500, y: 500 });
  const d4 = S.writeWorkspaceLens(slug, 'process', m4, 'user');
  casos.push(['criar no grava o no novo', d4.process.nodes.length === 3 && !!d4.process.nodes.find((n) => n.id === 'novo1')]);
  casos.push(['criar no nao mexe nos que ja existiam', d4.process.nodes[1].label === 'B']);

  // no SEM x/y (criado numa lente derivada) tem de sobreviver sem ganhar posicao
  const m5 = clone(d4.process);
  m5.nodes.push({ id: 'semxy', label: 'sem posicao', kind: 'task', status: 'proposed', comments: [] });
  const d5 = S.writeWorkspaceLens(slug, 'process', m5, 'user');
  const semxy = d5.process.nodes.find((n) => n.id === 'semxy');
  casos.push(['no sem x/y sobrevive sem ganhar posicao inventada', !!semxy && semxy.x === undefined && semxy.y === undefined]);

  // ligar dois nos GRAVANDO OS LADOS — se o servidor podar isso, a ancoragem
  // dos 4 lados nao volta quando a sessao reabre
  const m6 = clone(d5.process);
  m6.edges.push({ id: 'enova', source: 'a', target: 'novo1', label: '', status: 'proposed', sourceSide: 'right', targetSide: 'left' });
  const d6 = S.writeWorkspaceLens(slug, 'process', m6, 'user');
  const enova = d6.process.edges.find((e) => e.id === 'enova');
  casos.push(['ligar grava a aresta', !!enova]);
  casos.push(['sourceSide/targetSide sobrevivem ao round-trip', !!enova && enova.sourceSide === 'right' && enova.targetSide === 'left']);

  // deletar um no leva as arestas penduradas junto
  const idsFora = new Set(['a']);
  const m7 = clone(d6.process);
  m7.nodes = m7.nodes.filter((n) => !idsFora.has(n.id));
  m7.edges = m7.edges.filter((e) => !idsFora.has(e.source) && !idsFora.has(e.target));
  const d7 = S.writeWorkspaceLens(slug, 'process', m7, 'user');
  casos.push(['deletar tira o no', !d7.process.nodes.find((n) => n.id === 'a')]);
  casos.push(['deletar leva junto as arestas penduradas', d7.process.edges.every((e) => e.source !== 'a' && e.target !== 'a')]);
  casos.push(['deletar nao deixa aresta orfa apontando pro vazio', (() => {
    const ids = new Set(d7.process.nodes.map((n) => n.id));
    return d7.process.edges.every((e) => ids.has(e.source) && ids.has(e.target));
  })()]);

  // ---- FF-006: seta com status proprio, campos ER e raias ----

  // a seta guarda um status que a regra das pontas NAO derivaria. Isto e o
  // coracao da decisao de 06/08/2026: 34 das 143 arestas reais sao assim.
  const m8 = clone(d7.process);
  m8.edges = [{ id: 'ex', source: 'b', target: 'novo1', label: 'se falhar', status: 'rejected', sourceSide: 'bottom' }];
  m8.nodes = m8.nodes.map((n) => ({ ...n, status: 'approved' }));
  const d8 = S.writeWorkspaceLens(slug, 'process', m8, 'user');
  const ex = d8.process.edges.find((e) => e.id === 'ex');
  casos.push(['seta guarda status proprio divergente das pontas', !!ex && ex.status === 'rejected']);
  casos.push(['rotulo da seta sobrevive', !!ex && ex.label === 'se falhar']);

  // FF-011: quebras manuais tem de sobreviver ao round-trip. Se o servidor
  // podar `waypoints`, a linha que o Fabricio ajustou na mao volta torta.
  const mwp = clone(d8.process);
  mwp.edges[0].waypoints = [{ x: 900, y: 200 }, { x: 900, y: 420 }];
  mwp.edges[0].routing = 'segments';
  const dwp = S.writeWorkspaceLens(slug, 'process', mwp, 'user');
  const ewp = dwp.process.edges[0];
  casos.push(['waypoints sobrevivem ao round-trip', !!ewp.waypoints && ewp.waypoints.length === 2]);
  casos.push(['waypoints mantem a ORDEM e os valores', !!ewp.waypoints && ewp.waypoints[0].y === 200 && ewp.waypoints[1].y === 420]);
  casos.push(['routing segments sobrevive junto', ewp.routing === 'segments']);

  // remover a ultima quebra nao pode deixar `routing` orfao
  const msem = clone(dwp.process);
  delete msem.edges[0].waypoints;
  delete msem.edges[0].routing;
  const dsem = S.writeWorkspaceLens(slug, 'process', msem, 'user');
  casos.push(['tirar as quebras limpa waypoints e routing juntos',
    dsem.process.edges[0].waypoints === undefined && dsem.process.edges[0].routing === undefined]);

  // FF-015: o `concept` (a teoria do modo guiado) e um campo NOVO — se o servidor
  // podar, o painel guiado nasce vazio e ninguem entende por que.
  const mteo = clone(dsem.process);
  mteo.nodes[0].concept = 'A teoria desta etapa, que aparece no painel guiado.';
  mteo.nodes[0].description = 'O exemplo real, que aparece no card.';
  const dteo = S.writeWorkspaceLens(slug, 'process', mteo, 'user');
  const nteo = dteo.process.nodes[0];
  casos.push(['concept sobrevive ao round-trip', nteo.concept === 'A teoria desta etapa, que aparece no painel guiado.']);
  // os dois campos existem pra guardar coisas DIFERENTES: se um sobrescrevesse o
  // outro, a separacao teoria/pratica seria so aparencia
  casos.push(['concept e description convivem sem se sobrescrever',
    nteo.description === 'O exemplo real, que aparece no card.' && nteo.concept !== nteo.description]);

  // campos ER (nome/tipo/pk/fk) no round-trip
  const mer = clone(d8.er);
  mer.nodes = [{ id: 'ent1', label: 'Cliente', kind: 'entity', status: 'proposed', comments: [],
    fields: [{ name: 'id', type: 'int', key: 'pk' }, { name: 'nome', type: 'text', key: null }] }];
  const der = S.writeWorkspaceLens(slug, 'er', mer, 'user');
  const ent = der.er.nodes[0];
  casos.push(['campos ER sobrevivem com nome/tipo/chave', !!ent && ent.fields.length === 2 && ent.fields[0].key === 'pk' && ent.fields[1].type === 'text']);

  // cardinalidade ER
  const mer2 = clone(der.er);
  mer2.nodes.push({ id: 'ent2', label: 'Pedido', kind: 'entity', status: 'proposed', comments: [], fields: [] });
  mer2.edges = [{ id: 'r1', source: 'ent1', target: 'ent2', label: 'faz', status: 'proposed', sourceCard: '1', targetCard: 'N' }];
  const der2 = S.writeWorkspaceLens(slug, 'er', mer2, 'user');
  const rel = der2.er.edges[0];
  casos.push(['cardinalidade 1/N sobrevive', !!rel && rel.sourceCard === '1' && rel.targetCard === 'N']);

  // raias: criar, renomear, e remover SEM levar os nos junto
  const ml = clone(d8.process);
  ml.lanes = [{ id: 'l1', label: 'Analista', order: 0 }, { id: 'l2', label: 'Sistema', order: 1 }];
  ml.nodes = ml.nodes.map((n, i) => ({ ...n, lane: i === 0 ? 'l1' : 'l2' }));
  const dl = S.writeWorkspaceLens(slug, 'process', ml, 'user');
  casos.push(['criar raias grava lanes com ordem', dl.process.lanes.length === 2 && dl.process.lanes[1].order === 1]);
  casos.push(['no guarda a raia atribuida', dl.process.nodes[0].lane === 'l1']);

  const ml2 = clone(dl.process);
  ml2.lanes = ml2.lanes.filter((l) => l.id !== 'l2').map((l, i) => ({ ...l, order: i }));
  ml2.nodes = ml2.nodes.map((n) => (n.lane === 'l2' ? { ...n, lane: undefined } : n));
  const dl2 = S.writeWorkspaceLens(slug, 'process', ml2, 'user');
  casos.push(['remover raia nao apaga os nos dela', dl2.process.nodes.length === dl.process.nodes.length]);
  casos.push(['no da raia removida fica sem raia, nao com raia fantasma', (() => {
    const ids = new Set(dl2.process.lanes.map((l) => l.id));
    return dl2.process.nodes.every((n) => !n.lane || ids.has(n.lane));
  })()]);

  let falhas = 0;
  for (const [nome, ok] of casos) {
    console.log(`   ${ok ? 'ok   ' : 'FALHA'} ${nome}`);
    if (!ok) falhas++;
  }
  console.log(falhas === 0
    ? '\nAUTOTESTE: OK — o caminho de escrita se comporta e o detector acusa desvio.'
    : `\nAUTOTESTE: FALHA — ${falhas} caso(s).`);
  return falhas === 0;
}

// ---------------------------------------------------------------------------

function main() {
  const raizCopia = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-verifica-edicao-'));

  if (process.argv.includes('--autoteste')) {
    const ok = autoteste(raizCopia);
    fs.rmSync(raizCopia, { recursive: true, force: true });
    process.exit(ok ? 0 : 1);
  }

  const alvos = listarDiagramas();
  if (!alvos.length) { console.error('Nenhum diagram.json encontrado.'); process.exit(2); }
  console.log(`Diagramas reais encontrados: ${alvos.length}\n`);

  const resultados = alvos.map((a) => avalia(a, raizCopia));

  const cab = ['sessao', 'lente', 'nos', 'rev', 'veredito'];
  const linhas = resultados.map((r) => [
    r.alvo.sessao, r.lens || '?', String(r.nos ?? '-'),
    r.revAntes !== undefined ? `${r.revAntes} -> ${r.revDepois}` : '-',
    r.problemas.length ? `FALHA(${r.problemas.length})` : 'OK',
  ]);
  const larg = cab.map((c, i) => Math.max(c.length, ...linhas.map((l) => String(l[i]).length)));
  const fmt = (l) => l.map((v, i) => String(v).padEnd(larg[i])).join(' | ');
  console.log(fmt(cab));
  console.log(larg.map((w) => '-'.repeat(w)).join('-+-'));
  for (const l of linhas) console.log(fmt(l));
  console.log('');

  const comFalha = resultados.filter((r) => r.problemas.length);
  for (const r of comFalha) {
    console.log(`FALHA em ${r.alvo.rotulo}/${r.alvo.sessao}:`);
    for (const p of r.problemas) console.log('   - ' + p.msg);
    console.log('');
  }

  fs.rmSync(raizCopia, { recursive: true, force: true });
  const ok = comFalha.length === 0;
  console.log(ok
    ? `VEREDITO: OK — ${resultados.length} diagramas editados sem perda, rev e autoria corretos.`
    : `VEREDITO: FALHA — ${comFalha.length}/${resultados.length} diagramas com problema na escrita.`);
  process.exit(ok ? 0 : 1);
}

main();
