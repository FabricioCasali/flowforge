#!/usr/bin/env node
// =============================================================================
// verifica-migracao.mjs — a PROVA da lei 5 (migracao lazy e NAO destrutiva).
//
// Pega TODOS os diagram.json reais do Fabricio (sessions/ + os .flowforge/ dos
// projetos), copia cada um para uma pasta temporaria, roda a migracao DE VERDADE
// (o ensureSession do server/state.js, o mesmo caminho que roda em producao) e
// confere que NADA se perdeu no caminho.
//
// Nao toca nos dados reais: tudo acontece sobre COPIA. O diagram.json original
// e lido e nunca reescrito.
//
// Uso:
//   node scripts/verifica-migracao.mjs            # roda e apaga a copia
//   node scripts/verifica-migracao.mjs --keep     # mantem a copia pra inspecao
//   node scripts/verifica-migracao.mjs --autoteste  # prova que o teste sabe FALHAR
//
// Saida: uma tabela por diagrama + o veredito. Exit code 1 se houve QUALQUER
// perda — perda de campo e FALHA, nao aviso.
// =============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, '..');
const S = require(path.join(RAIZ, 'server', 'state.js'));

const MANTER_COPIA = process.argv.includes('--keep');

// Onde moram os diagramas reais. Cada entrada e uma raiz de sessoes: dentro dela
// cada subpasta e uma sessao com seu diagram.json.
const RAIZES = [
  { rotulo: 'flowforge/sessions', dir: 'C:/desenv/particular/flowforge/sessions' },
  { rotulo: 'flowforge', dir: 'C:/desenv/particular/flowforge/.flowforge' },
  { rotulo: 'context_builder', dir: 'C:/desenv/particular/context_builder/.flowforge' },
  { rotulo: 'poe2', dir: 'C:/desenv/particular/poe2 - overlay + pob/.flowforge' },
  { rotulo: 'th_framework', dir: 'C:/desenv/thealth_projects/th_framework/.flowforge' },
];

// Campos que a lei 5 nomeia por escrito. Perder qualquer um deles e falha grave.
// (O teste real e mais duro que esta lista: compara o diagrama INTEIRO campo a
// campo. Esta lista existe pra a tabela dizer "quantos tinha / quantos sobraram"
// e nomear o culpado quando algo some.)
const CAMPOS_NO = ['x', 'y', 'comments', 'description', 'fields', 'lane', 'kind', 'status', 'label'];
const CAMPOS_ARESTA = ['sourceSide', 'targetSide', 'sourceCard', 'targetCard', 'label', 'status', 'routing'];

// Mapa esperado: type do diagrama antigo -> em qual modelo do workspace ele cai.
const TIPO_PARA_MODELO = {
  flowchart: 'process', bpm: 'process', swimlane: 'process',
  er: 'er', mindmap: 'mind',
};
const TODOS_MODELOS = ['process', 'state', 'er', 'mind', 'seq'];

// ---------------------------------------------------------------------------
// utilidades
// ---------------------------------------------------------------------------

function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// Comparacao estrutural profunda que devolve o CAMINHO exato da divergencia.
// Nao basta saber que perdeu: a lei manda dizer QUAL campo, em QUAL diagrama.
function diferencas(esperado, obtido, caminho = '', saida = []) {
  if (esperado === obtido) return saida;

  const tEsp = esperado === null ? 'null' : Array.isArray(esperado) ? 'array' : typeof esperado;
  const tObt = obtido === null ? 'null' : Array.isArray(obtido) ? 'array' : typeof obtido;

  if (tEsp !== tObt) {
    saida.push({ caminho: caminho || '(raiz)', motivo: `tipo mudou: ${tEsp} -> ${tObt}`, de: esperado, para: obtido });
    return saida;
  }

  if (tEsp === 'array') {
    if (esperado.length !== obtido.length) {
      saida.push({ caminho: caminho || '(raiz)', motivo: `tamanho do array mudou: ${esperado.length} -> ${obtido.length}` });
    }
    const n = Math.min(esperado.length, obtido.length);
    for (let i = 0; i < n; i++) diferencas(esperado[i], obtido[i], `${caminho}[${i}]`, saida);
    return saida;
  }

  if (tEsp === 'object') {
    for (const k of Object.keys(esperado)) {
      if (!(k in obtido)) {
        saida.push({ caminho: `${caminho}.${k}`, motivo: 'CAMPO PERDIDO', de: esperado[k] });
        continue;
      }
      diferencas(esperado[k], obtido[k], `${caminho}.${k}`, saida);
    }
    // campo que apareceu do nada tambem e desvio do contrato — reporta, mas
    // separado (ver classificacao em avalia()).
    for (const k of Object.keys(obtido)) {
      if (!(k in esperado)) saida.push({ caminho: `${caminho}.${k}`, motivo: 'CAMPO ACRESCENTADO', para: obtido[k] });
    }
    return saida;
  }

  saida.push({ caminho: caminho || '(raiz)', motivo: 'VALOR ALTERADO', de: esperado, para: obtido });
  return saida;
}

// Conta em quantos itens cada campo aparece (e nao e undefined).
function contaCampos(itens, campos) {
  const c = {};
  for (const campo of campos) {
    c[campo] = (itens || []).filter((it) => it && it[campo] !== undefined).length;
  }
  return c;
}

function listarDiagramas() {
  const achados = [];
  const usados = new Set();
  for (const { rotulo, dir } of RAIZES) {
    let entradas = [];
    try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entradas) {
      if (!e.isDirectory()) continue;
      const origem = path.join(dir, e.name);
      const diag = path.join(origem, 'diagram.json');
      if (!fs.existsSync(diag)) continue;
      // slug unico dentro da copia (dois projetos podem ter sessao de mesmo nome)
      let slug = e.name;
      while (usados.has(slug)) slug = `${rotulo.replace(/[^a-z0-9]+/gi, '-')}-${slug}`;
      usados.add(slug);
      achados.push({ rotulo, sessao: e.name, slug, origem, diagramaOrigem: diag });
    }
  }
  return achados;
}

// ---------------------------------------------------------------------------
// a prova, um diagrama de cada vez
// ---------------------------------------------------------------------------

function avalia(alvo, raizCopia) {
  const bruto = fs.readFileSync(alvo.diagramaOrigem);
  const hashAntes = sha(bruto);
  const original = JSON.parse(bruto.toString('utf8'));

  // Sessao que NASCEU no /v2 (conteudo no workspace.json, diagram.json e so o
  // esqueleto que o servidor cria pro editor antigo): nao ha migracao a provar.
  // Pular e o certo — mas em voz alta, senao a tabela finge cobertura que nao tem.
  if (!(original.nodes || []).length && fs.existsSync(path.join(alvo.origem, 'workspace.json'))) {
    return { alvo, original, problemas: [], notas: [], modelo: null, tabela: null, pulado: 'nasceu no /v2' };
  }

  // 1) copia para a area temporaria (nada acontece sobre o dado real)
  const destino = path.join(raizCopia, alvo.slug);
  fs.mkdirSync(destino, { recursive: true });
  fs.writeFileSync(path.join(destino, 'diagram.json'), bruto);
  const threadOrigem = path.join(alvo.origem, 'thread.json');
  if (fs.existsSync(threadOrigem)) fs.copyFileSync(threadOrigem, path.join(destino, 'thread.json'));

  // 2) roda a migracao REAL: o mesmo ensureSession que o servidor chama quando
  //    o browser abre a sessao. Nao e uma reimplementacao do teste.
  S.setDataDir(raizCopia);
  S.ensureSession(alvo.slug);

  const wsPath = path.join(destino, 'workspace.json');
  const problemas = [];
  const notas = [];

  if (!fs.existsSync(wsPath)) {
    problemas.push({ caminho: '(workspace.json)', motivo: 'MIGRACAO NAO PRODUZIU workspace.json' });
    return { alvo, original, problemas, notas, modelo: null, tabela: null };
  }
  const ws = JSON.parse(fs.readFileSync(wsPath, 'utf8'));

  // 3) lei 5, parte "nao destrutiva": o diagram.json tem de sair EXATAMENTE como
  //    entrou. Byte a byte, na copia; e o arquivo real nem foi aberto pra escrita.
  const hashDepoisCopia = sha(fs.readFileSync(path.join(destino, 'diagram.json')));
  if (hashDepoisCopia !== hashAntes) {
    problemas.push({ caminho: '(diagram.json)', motivo: 'diagram.json FOI ALTERADO pela migracao (lei 5)' });
  }
  const hashRealDepois = sha(fs.readFileSync(alvo.diagramaOrigem));
  if (hashRealDepois !== hashAntes) {
    problemas.push({ caminho: '(diagram.json REAL)', motivo: 'o arquivo REAL do usuario foi tocado — bug do proprio teste' });
  }

  // 4) foi para o modelo certo?
  const tipo = String(original.type || 'flowchart');
  const modeloEsperado = TIPO_PARA_MODELO[tipo] || 'process';
  const alvoModelo = ws[modeloEsperado];
  if (!alvoModelo) {
    problemas.push({ caminho: `workspace.${modeloEsperado}`, motivo: 'modelo de destino ausente no workspace' });
    return { alvo, original, problemas, notas, modelo: modeloEsperado, tabela: null };
  }

  // 5) o coracao: o diagrama inteiro sobreviveu? Compara o original contra o
  //    modelo de destino campo a campo, em profundidade. Isso cobre x, y,
  //    comments, description, fields, lanes, lane, sourceSide/targetSide,
  //    sourceCard/targetCard E qualquer campo que ninguem listou (ex: routing).
  const difs = diferencas(original, alvoModelo);
  for (const d of difs) {
    // A normalizacao tem licenca para CRIAR o que faltava (lanes: [] num diagrama
    // sem raias, por exemplo). Criar nao e perder — vira nota, nao falha.
    if (d.motivo === 'CAMPO ACRESCENTADO') {
      const vazio = Array.isArray(d.para) && d.para.length === 0;
      if (vazio) { notas.push(`${d.caminho}: campo criado vazio pela normalizacao (nao ha perda)`); continue; }
      problemas.push({ ...d, motivo: 'CAMPO ACRESCENTADO com conteudo (contaminacao)' });
      continue;
    }
    problemas.push(d);
  }

  // 6) o 'type' interno — e ele que mantem as formas BPM e as raias depois da
  //    migracao. Checagem explicita porque e a que mais dói se quebrar.
  if (alvoModelo.type !== tipo) {
    problemas.push({ caminho: `workspace.${modeloEsperado}.type`, motivo: `TYPE INTERNO PERDIDO: '${tipo}' -> '${alvoModelo.type}'` });
  }

  // 7) nenhum outro modelo pode ter recebido conteudo (o diagrama vai pra UM so)
  for (const m of TODOS_MODELOS) {
    if (m === modeloEsperado) continue;
    const outro = ws[m];
    if (!outro) { problemas.push({ caminho: `workspace.${m}`, motivo: 'modelo ausente no workspace' }); continue; }
    if (m === 'seq') {
      if ((outro.participants || []).length || (outro.messages || []).length) {
        problemas.push({ caminho: `workspace.seq`, motivo: 'seq deveria nascer vazio e veio com conteudo' });
      }
      continue;
    }
    if ((outro.nodes || []).length || (outro.edges || []).length) {
      problemas.push({ caminho: `workspace.${m}`, motivo: `modelo '${m}' deveria nascer vazio e veio com ${outro.nodes.length} nos / ${outro.edges.length} arestas` });
    }
  }

  // 8) continuidade do rev do workspace (nao pode voltar no tempo)
  if ((Number(ws.rev) || 0) !== (Number(original.rev) || 0)) {
    problemas.push({ caminho: 'workspace.rev', motivo: `rev do workspace nao herdou o do diagrama: ${original.rev} -> ${ws.rev}` });
  }

  // 9) tabela por campo: quantos tinha antes, quantos tem depois
  const noAntes = contaCampos(original.nodes, CAMPOS_NO);
  const noDepois = contaCampos(alvoModelo.nodes, CAMPOS_NO);
  const arAntes = contaCampos(original.edges, CAMPOS_ARESTA);
  const arDepois = contaCampos(alvoModelo.edges, CAMPOS_ARESTA);
  for (const c of CAMPOS_NO) {
    if (noAntes[c] !== noDepois[c]) problemas.push({ caminho: `nodes[].${c}`, motivo: `contagem caiu: ${noAntes[c]} -> ${noDepois[c]}` });
  }
  for (const c of CAMPOS_ARESTA) {
    if (arAntes[c] !== arDepois[c]) problemas.push({ caminho: `edges[].${c}`, motivo: `contagem caiu: ${arAntes[c]} -> ${arDepois[c]}` });
  }

  const tabela = {
    tipo,
    modelo: modeloEsperado,
    typeInterno: alvoModelo.type,
    nos: `${(original.nodes || []).length}/${(alvoModelo.nodes || []).length}`,
    arestas: `${(original.edges || []).length}/${(alvoModelo.edges || []).length}`,
    lanes: `${(original.lanes || []).length}/${(alvoModelo.lanes || []).length}`,
    xy: `${noAntes.x}/${noDepois.x}`,
    comments: `${noAntes.comments}/${noDepois.comments}`,
    description: `${noAntes.description}/${noDepois.description}`,
    fields: `${noAntes.fields}/${noDepois.fields}`,
    lane: `${noAntes.lane}/${noDepois.lane}`,
    sides: `${arAntes.sourceSide + arAntes.targetSide}/${arDepois.sourceSide + arDepois.targetSide}`,
    cards: `${arAntes.sourceCard + arAntes.targetCard}/${arDepois.sourceCard + arDepois.targetCard}`,
  };

  return { alvo, original, problemas, notas, modelo: modeloEsperado, tabela };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

// Auto-teste do proprio verificador. Um teste que so sabe dizer "OK" nao prova
// nada: aqui a gente MUTILA um diagrama de proposito e confere que o detector
// aponta o campo exato. Se este bloco passar sem acusar, a tabela toda e mentira.
function autoteste() {
  const base = {
    type: 'swimlane', title: 'T', rev: 3, updatedBy: 'user',
    lanes: [{ id: 'l1', label: 'Raia' }],
    nodes: [{ id: 'n1', label: 'A', kind: 'task', x: 10, y: 20, comments: ['c'], description: 'd', lane: 'l1' }],
    edges: [{ id: 'e1', source: 'n1', target: 'n1', sourceSide: 'r', targetSide: 'l', sourceCard: '1', targetCard: 'N' }],
  };
  const casos = [
    ['perde nodes[].x', (d) => { delete d.nodes[0].x; }, '.nodes[0].x'],
    ['perde nodes[].comments', (d) => { delete d.nodes[0].comments; }, '.nodes[0].comments'],
    ['perde nodes[].lane', (d) => { delete d.nodes[0].lane; }, '.nodes[0].lane'],
    ['perde edges[].sourceSide', (d) => { delete d.edges[0].sourceSide; }, '.edges[0].sourceSide'],
    ['perde edges[].targetCard', (d) => { delete d.edges[0].targetCard; }, '.edges[0].targetCard'],
    ['perde lanes', (d) => { d.lanes = []; }, '.lanes'],
    ['type interno vira flowchart', (d) => { d.type = 'flowchart'; }, '.type'],
    ['some um no', (d) => { d.nodes = []; }, '.nodes'],
    ['x muda de valor', (d) => { d.nodes[0].x = 999; }, '.nodes[0].x'],
  ];
  let falhas = 0;
  for (const [nome, mutila, caminhoEsperado] of casos) {
    const mutilado = JSON.parse(JSON.stringify(base));
    mutila(mutilado);
    const difs = diferencas(base, mutilado);
    const pegou = difs.some((d) => d.caminho === caminhoEsperado && d.motivo !== 'CAMPO ACRESCENTADO');
    console.log(`   ${pegou ? 'pega ' : 'PASSOU BATIDO'} ${nome} -> ${difs.map((d) => d.caminho + ':' + d.motivo).join(' ; ') || '(nada)'}`);
    if (!pegou) falhas++;
  }
  // e o contrario: identico tem de dar zero
  const zero = diferencas(base, JSON.parse(JSON.stringify(base)));
  console.log(`   ${zero.length === 0 ? 'pega ' : 'FALSO POSITIVO'} copia identica -> ${zero.length} divergencias`);
  if (zero.length !== 0) falhas++;

  console.log(falhas === 0
    ? '\nAUTOTESTE: OK — o detector acusa toda perda injetada e nao inventa falha.'
    : `\nAUTOTESTE: FALHA — ${falhas} caso(s) passaram batido. A tabela nao e confiavel.`);
  process.exit(falhas === 0 ? 0 : 1);
}

function main() {
  if (process.argv.includes('--autoteste')) return autoteste();
  const alvos = listarDiagramas();
  if (!alvos.length) {
    console.error('Nenhum diagram.json encontrado nas raizes configuradas.');
    process.exit(2);
  }

  const raizCopia = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-verifica-migracao-'));
  console.log(`Copia de trabalho: ${raizCopia}`);
  console.log(`Diagramas reais encontrados: ${alvos.length}\n`);

  const todos = alvos.map((a) => avalia(a, raizCopia));
  const pulados = todos.filter((r) => r.pulado);
  const resultados = todos.filter((r) => !r.pulado);
  for (const p of pulados) console.log(`(pulado) ${p.alvo.rotulo}/${p.alvo.sessao}: ${p.pulado} — nao ha migracao a provar`);
  if (pulados.length) console.log('');

  // ---- tabela ----
  const cab = ['sessao', 'origem', 'type', 'modelo', 'type-int', 'nos', 'arestas', 'lanes', 'x/y', 'comm', 'descr', 'fields', 'lane', 'sides', 'cards', 'veredito'];
  const linhas = resultados.map((r) => {
    const t = r.tabela || {};
    return [
      r.alvo.sessao, r.alvo.rotulo, t.tipo || '?', t.modelo || '?', t.typeInterno || '?',
      t.nos || '-', t.arestas || '-', t.lanes || '-', t.xy || '-', t.comments || '-',
      t.description || '-', t.fields || '-', t.lane || '-', t.sides || '-', t.cards || '-',
      r.problemas.length ? `FALHA(${r.problemas.length})` : 'OK',
    ];
  });
  const larguras = cab.map((c, i) => Math.max(c.length, ...linhas.map((l) => String(l[i]).length)));
  const fmt = (l) => l.map((v, i) => String(v).padEnd(larguras[i])).join(' | ');
  console.log(fmt(cab));
  console.log(larguras.map((w) => '-'.repeat(w)).join('-+-'));
  for (const l of linhas) console.log(fmt(l));
  console.log('\n(cada par e "antes/depois": quantos itens tinham o campo antes da migracao / depois)\n');

  // ---- detalhe das falhas ----
  const comFalha = resultados.filter((r) => r.problemas.length);
  for (const r of comFalha) {
    console.log(`FALHA em ${r.alvo.rotulo}/${r.alvo.sessao} (${r.alvo.diagramaOrigem}):`);
    for (const p of r.problemas.slice(0, 40)) {
      const de = p.de !== undefined ? ` | antes=${JSON.stringify(p.de)}` : '';
      const para = p.para !== undefined ? ` | depois=${JSON.stringify(p.para)}` : '';
      console.log(`   - ${p.caminho}: ${p.motivo}${de}${para}`);
    }
    if (r.problemas.length > 40) console.log(`   ... e mais ${r.problemas.length - 40}`);
    console.log('');
  }

  const notas = resultados.flatMap((r) => r.notas.map((n) => `${r.alvo.sessao}: ${n}`));
  if (notas.length) {
    console.log('Notas (mudanca sem perda):');
    for (const n of [...new Set(notas)]) console.log('   . ' + n);
    console.log('');
  }

  if (!MANTER_COPIA) fs.rmSync(raizCopia, { recursive: true, force: true });
  else console.log(`Copia mantida em ${raizCopia}\n`);

  const ok = comFalha.length === 0;
  console.log(ok
    ? `VEREDITO: OK — ${resultados.length}/${resultados.length} diagramas migraram sem perda.`
    : `VEREDITO: FALHA — ${comFalha.length}/${resultados.length} diagramas perderam informacao.`);
  process.exit(ok ? 0 : 1);
}

main();
