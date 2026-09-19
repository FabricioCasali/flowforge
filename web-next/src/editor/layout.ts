// ============================================================================
// layout.ts — posicionamento + roteamento por lente.
//  • layoutDiagram  → elk `layered` ortogonal (Fluxograma, Máq. estados, ER)
//  • swimlaneLayout → colunas do elk + bandas por raia (ator×ação)
//  • mindLayout     → árvore horizontal de dois lados (Mind map)
//  • radialLayout   → anéis (arranjo alternativo do Mind map)
// Coordenadas = coords do React Flow. edgePoints alimentam a aresta custom.
//
// LEI 2 (arquivo é a verdade) aplicada à geometria: **quem tem `x`/`y` no
// arquivo manda**. O elk só calcula quem não tem — e o que ele calcular é
// transladado para o referencial do desenho salvo, senão o nó novo do agente
// aparece a mil pixels do diagrama que o usuário arrastou. Ver `anchorToSaved`.
//
// A Swimlane é a exceção declarada (`savesPos: false` em `lenses.ts`): ela
// recalcula sempre, porque divide o `process` — e o par `x`/`y` — com o
// Fluxograma. Decisão de projeto de 06/08/2026.
// ============================================================================

import type { Diagram, DNode, Pt, Side } from '../types.js'
import { EVENT_SIZE, GATE_SIZE, shapeOf, type FlowShape } from './shapes.js'

/**
 * O elk é ~1,4 MB e só é preciso quando algum nó NÃO tem posição no arquivo — o
 * desenho inteiro salvo nem o chama (ver `layoutDiagram`). Carregado sob demanda
 * ele sai do bundle inicial e vira um chunk que a maioria das aberturas não baixa.
 */
type ElkInstance = InstanceType<typeof import('elkjs/lib/elk.bundled.js').default>
let elkPromise: Promise<ElkInstance> | null = null
function getElk(): Promise<ElkInstance> {
  return (elkPromise ??= import('elkjs/lib/elk.bundled.js').then((m) => new m.default()))
}

export interface LaneBand {
  id: string
  label: string
  y: number
  height: number
}
export interface LayoutResult {
  positions: Record<string, Pt>
  sizes: Record<string, Size>
  edgePoints: Record<string, Pt[]>
  lanes?: LaneBand[]
  /** Swimlane pedida num diagrama sem `lanes` — a UI avisa em vez de fingir uma raia. */
  noLanes?: boolean
  /**
   * Ids que o layout MOVEU para desfazer sobreposição. Quem chama grava essas
   * posições no arquivo — é a exceção da lei 4, e a única vez que um nó anda sem
   * o usuário pedir. Vazio na esmagadora maioria das aberturas.
   */
  ajustados?: string[]
}

export type { Pt }
type Size = { width: number; height: number }

/**
 * Tamanho da caixa por FORMA (lei 8). A forma vem de `shapes.ts` — a mesma
 * tabela que o FlowNode usa para desenhar, para os dois não divergirem.
 *
 * Evento e gateway têm medida FIXA porque o rótulo deles fica FORA da forma:
 * o texto não empurra a caixa. Todo o resto cresce com o rótulo.
 */
export function nodeSize(n: DNode): Size {
  const len = (n.label || '').length
  switch (shapeOf(n.kind)) {
    case 'entity': {
      const rows = n.fields?.length ?? 0
      return { width: 224, height: 36 + rows * 22 + 8 }
    }
    case 'event':
      return { width: EVENT_SIZE, height: EVENT_SIZE }
    case 'gate':
      return { width: GATE_SIZE, height: GATE_SIZE }
    // losango clássico — rótulo DENTRO, então precisa de área. Só ~metade da
    // largura (e da altura) do losango é útil pro texto, daí os fatores: caixa
    // fixa de 168×104 deixava rótulo de 50 letras vazando por cima e por baixo.
    case 'diamond': {
      const width = len <= 18 ? 168 : Math.min(300, 168 + (len - 18) * 4)
      const linhas = Math.max(1, Math.ceil((len * 6.8) / (width * 0.58)))
      return { width, height: Math.max(104, 56 + linhas * 26) }
    }
    case 'data': {
      // mesmo problema do losango: 128×72 fixo não segura uma frase
      const width = len <= 14 ? 128 : Math.min(220, 128 + (len - 14) * 3)
      const linhas = Math.max(1, Math.ceil((len * 6.8) / (width - 48)))
      return { width, height: Math.max(72, 30 + linhas * 16) }
    }
    case 'annotation': {
      // a anotação É o texto: quebra em ~2 linhas antes de crescer na largura
      const width = Math.max(150, Math.min(280, 40 + len * 6.2))
      const linhas = Math.max(1, Math.ceil((len * 6.2) / Math.max(1, width - 34)))
      return { width, height: Math.max(44, 22 + linhas * 16) }
    }
    case 'pill':
      return { width: Math.max(120, Math.min(230, 44 + len * 7.2)), height: 46 }
    case 'idea': {
      const width = Math.max(96, Math.min(210, 44 + len * 7.6))
      // a elipse come os cantos: o texto só tem ~70% da largura
      const linhas = Math.max(1, Math.ceil((len * 6.8) / (width * 0.7)))
      return { width, height: Math.max(40, 22 + linhas * 17) }
    }
    default: {
      // Retângulo (task/subprocess/state): cabeçalho + corpo mono.
      // 92 e não 82: o cabeçalho come ~35px e as 2 linhas do corpo ~48px com a
      // JetBrains Mono de verdade carregada (antes do FF-003 o fallback do
      // sistema era mais baixo, e a segunda linha saía cortada no meio).
      // O `+118` paga o que NÃO é o rótulo dentro do cabeçalho: o ponto de
      // status, os paddings e principalmente o badge ("APROVADO" tem ~62px).
      // Com a conta antiga o rótulo quebrava em duas linhas, o cabeçalho crescia
      // e a descrição era espremida pra fora.
      const width = Math.max(210, Math.min(330, 118 + len * 7))
      const hasDesc = !!(n.description && n.description.trim())
      return { width, height: hasDesc ? 92 : 42 }
    }
  }
}

function sizesOf(diagram: Diagram): LayoutResult['sizes'] {
  const sizes: LayoutResult['sizes'] = {}
  for (const n of diagram.nodes) sizes[n.id] = nodeSize(n)
  return sizes
}

// ---------------------------------------------------------------------------
// Tamanho no MAPA MENTAL
//
// O nó do mind map não é o desenho do fluxograma: é a pílula do `MindNode` —
// ponto, rótulo, e mais nada (sem cabeçalho, sem badge, sem descrição). Medi-lo
// pelo `nodeSize` genérico dava caixa estreita demais — a forma `idea` tem teto
// de 210px de largura — e rótulo como "Arquivos tocados ligados ao nó" perdia o
// fim. Aqui o rótulo pode QUEBRAR EM ATÉ 3 LINHAS, e a altura calculada conta
// essas linhas: o `mindLayout` empilha irmãos pela ALTURA do nó, então caixa que
// cresce só no desenho volta a sobrepor o vizinho de baixo.
//
// Os números são os mesmos do `.mind` no `editor.css` — se um lado mudar, o
// outro tem de mudar junto (é o espírito da lei 8: uma medida só, em um lugar).
// ---------------------------------------------------------------------------

/** Largura máxima do TEXTO antes de quebrar linha. */
const MIND_TEXTO_MAX = 214
/** O que no `.mind` não é texto: padding 2×13, o ponto (7) + gap (7), bordas 2×1,5. */
const MIND_CHROME = 43
/** `line-height` do `.mind-label`. */
const MIND_LINHA = 16
/** Altura da pílula de uma linha (o resto é o respiro de cima e de baixo). */
const MIND_ALTURA_1 = 40
/** Teto de linhas — o mesmo `-webkit-line-clamp` do CSS. */
const MIND_MAX_LINHAS = 3

/**
 * Tamanho do nó na lente Mind map. `raiz` só muda a fonte (13px contra 12px).
 */
export function mindNodeSize(n: DNode, raiz = false): Size {
  // largura média do caractere na Space Grotesk semibold do `.mind`
  const texto = (n.label || '').length * (raiz ? 7.6 : 7)
  const linhas = Math.min(MIND_MAX_LINHAS, Math.max(1, Math.ceil(texto / MIND_TEXTO_MAX)))
  const util = Math.max(60, Math.min(MIND_TEXTO_MAX, texto))
  return { width: Math.round(util + MIND_CHROME), height: MIND_ALTURA_1 + (linhas - 1) * MIND_LINHA }
}

/** As medidas dos dois arranjos do mind map (`mindLayout` e `radialLayout`). */
function sizesMind(diagram: Diagram, rootId?: string): LayoutResult['sizes'] {
  const sizes: LayoutResult['sizes'] = {}
  for (const n of diagram.nodes) sizes[n.id] = mindNodeSize(n, n.id === rootId)
  return sizes
}

// ---------------------------------------------------------------------------
// Posições do arquivo
// ---------------------------------------------------------------------------

/**
 * O que o arquivo já define, convertido para o referencial do React Flow.
 *
 * ATENÇÃO — os dois editores ancoram o nó em pontos DIFERENTES: o `x`/`y` do
 * arquivo é o CENTRO do nó (é o que `position` significa no Cytoscape, e é o que
 * o `web/` antigo gravou em todos os diagramas reais), enquanto o React Flow
 * posiciona pelo canto superior-esquerdo. Ler um como o outro entorta o desenho:
 * cada nó desce e anda para a direita metade do próprio tamanho, e como o
 * tamanho varia por `kind`, o que estava alinhado deixa de estar.
 *
 * A prova está nos dados: no `teste-vivo` o `x` é 319 numa pílula estreita, numa
 * task larga e num losango — só fecha se 319 for o meio de cada um.
 *
 * A conversão mora AQUI e em `toSavedPoint` (o caminho de volta). O arquivo
 * continua na semântica antiga de propósito: o `web/` antigo ainda roda em `/`
 * (lei 1) e lê os mesmos diagramas.
 *
 * Nó sem `x`/`y` (recém-nascido do agente) fica fora.
 */
export function savedPositions(diagram: Diagram, sizes: Record<string, Size>): Record<string, Pt> {
  const out: Record<string, Pt> = {}
  for (const n of diagram.nodes) {
    if (typeof n.x === 'number' && Number.isFinite(n.x) && typeof n.y === 'number' && Number.isFinite(n.y)) {
      const s = sizes[n.id] ?? nodeSize(n)
      out[n.id] = { x: n.x - s.width / 2, y: n.y - s.height / 2 }
    }
  }
  return out
}

/** O caminho de volta: canto do React Flow → centro, que é o que vai pro arquivo. */
export function toSavedPoint(topLeft: Pt, size: Size): Pt {
  return { x: Math.round(topLeft.x + size.width / 2), y: Math.round(topLeft.y + size.height / 2) }
}

function overlaps(a: Pt, as: Size, b: Pt, bs: Size, gap: number): boolean {
  return (
    a.x < b.x + bs.width + gap &&
    a.x + as.width + gap > b.x &&
    a.y < b.y + bs.height + gap &&
    a.y + as.height + gap > b.y
  )
}

/**
 * Afasta nós que se sobrepõem — a EXCEÇÃO da lei 4, e a única vez que o editor
 * move um nó sem ninguém pedir.
 *
 * Existe porque o porte causou o problema: o editor antigo desenhava caixa fixa
 * de 162×54 e o novo calcula pelo conteúdo (até 330×92). As coordenadas foram
 * preservadas fielmente, e as caixas engordaram em cima delas — 25 pares
 * sobrepostos nos diagramas reais, 6 envolvendo anotação.
 *
 * Três garantias, porque isto reescreve o desenho do usuário:
 *   · DETERMINÍSTICO — varre em ordem de posição, então a mesma entrada dá
 *     sempre a mesma saída (senão o arquivo mudaria a cada abertura);
 *   · MÍNIMO — empurra só pra baixo, e só o quanto falta pra descolar;
 *   · CONVERGE — quem foi empurrado só compara com quem já está colocado, e o
 *     próximo da fila resolve o que sobrou. Uma segunda abertura não move nada.
 */
function desempilhar(
  ordem: string[],
  positions: Record<string, Pt>,
  sizes: Record<string, Size>,
  folga = 14,
  /**
   * Por qual eixo empurrar. Na Swimlane tem de ser `x`: o `y` ali é a banda da
   * raia, e empurrar pra baixo tiraria o nó do ator dele — o desenho ficaria sem
   * sobreposição e MENTINDO, que é pior.
   */
  eixo: 'y' | 'x' = 'y'
): { positions: Record<string, Pt>; ajustados: string[] } {
  const out: Record<string, Pt> = { ...positions }
  const ajustados: string[] = []
  const postos: { id: string; p: Pt; s: Size }[] = []

  for (const id of ordem) {
    const p0 = out[id]
    const s = sizes[id]
    if (!p0 || !s) continue
    const p = { ...p0 }
    for (let guarda = 0; guarda < 400; guarda++) {
      const bate = postos.find((q) => overlaps(p, s, q.p, q.s, folga))
      if (!bate) break
      if (eixo === 'y') p.y = bate.p.y + bate.s.height + folga
      else p.x = bate.p.x + bate.s.width + folga
    }
    if (p.y !== p0.y || p.x !== p0.x) {
      out[id] = { x: Math.round(p.x), y: Math.round(p.y) }
      ajustados.push(id)
    }
    postos.push({ id, p: out[id]!, s })
  }
  return { positions: out, ajustados }
}

/** Ordem estável de varredura: de cima pra baixo, esquerda pra direita. */
function ordemPorPosicao(positions: Record<string, Pt>): string[] {
  return Object.keys(positions).sort((a, b) => {
    const pa = positions[a]!
    const pb = positions[b]!
    return pa.y - pb.y || pa.x - pb.x || a.localeCompare(b)
  })
}

/**
 * Casa o desenho salvo com o que o elk calculou.
 *
 * Quem tem posição no arquivo fica EXATAMENTE onde está. Quem não tem entra pela
 * posição do elk, deslocada pela translação média entre os dois referenciais —
 * assim o nó novo nasce perto de onde o elk quis pô-lo *em relação aos vizinhos*,
 * e não na origem do canvas. Se ainda assim cair em cima de alguém, desce até
 * achar espaço (o desempilhamento é burro de propósito: previsível > ótimo).
 */
function anchorToSaved(
  diagram: Diagram,
  saved: Record<string, Pt>,
  computed: Record<string, Pt>,
  sizes: Record<string, Size>
): Record<string, Pt> {
  let dx = 0
  let dy = 0
  let n = 0
  for (const id of Object.keys(saved)) {
    const c = computed[id]
    if (!c) continue
    dx += saved[id]!.x - c.x
    dy += saved[id]!.y - c.y
    n++
  }
  if (n > 0) {
    dx /= n
    dy /= n
  }

  const out: Record<string, Pt> = {}
  const placed: { p: Pt; s: Size }[] = []
  for (const [id, p] of Object.entries(saved)) {
    out[id] = p
    placed.push({ p, s: sizes[id]! })
  }

  const GAP = 22
  const STEP = 26
  for (const node of diagram.nodes) {
    if (out[node.id]) continue
    const s = sizes[node.id]!
    const c = computed[node.id] ?? { x: 0, y: 0 }
    const p = { x: Math.round(c.x + dx), y: Math.round(c.y + dy) }
    for (let guard = 0; guard < 200; guard++) {
      const hit = placed.find((q) => overlaps(p, s, q.p, q.s, GAP))
      if (!hit) break
      p.y = hit.p.y + hit.s.height + GAP + (STEP - GAP)
    }
    out[node.id] = p
    placed.push({ p, s })
  }
  return out
}

// ---------------------------------------------------------------------------
// Roteamento
// ---------------------------------------------------------------------------

/**
 * Traço ortogonal L/Z entre dois nós — o mesmo desenho do `curve-style: taxi` do
 * editor antigo, que é o que o usuário aprovou na fase 3. Sai pelo lado mais
 * curto e dobra na metade do caminho.
 */
export function orthRoute(
  sp: Pt,
  ss: Size,
  tp: Pt,
  ts: Size,
  sourceSide?: Side,
  targetSide?: Side,
  /** Deslocamento da âncora AO LONGO do lado, a partir do meio (ver `distribuirAncoras`). */
  sOff = 0,
  tOff = 0,
  /** Existe a seta de VOLTA entre os mesmos dois nós — ver `ladosDe`. */
  temVolta = false
): Pt[] {
  // Lado ancorado no arquivo manda — ENQUANTO fizer sentido (ver `ladosDe`).
  const lados = ladosDe(sp, ss, tp, ts, sourceSide, targetSide, temVolta)
  if (lados.ancorada) return tracoAncorado(sp, ss, tp, ts, lados.sSide, lados.tSide, sOff, tOff)
  return tracoLivre(sp, ss, tp, ts, sOff, tOff)
}

/** O traço de uma aresta cujos lados já foram resolvidos (`distribuirAncoras`). */
function tracar(sp: Pt, ss: Size, tp: Pt, ts: Size, p: Pontas): Pt[] {
  return p.ancorada
    ? tracoAncorado(sp, ss, tp, ts, p.sSide, p.tSide, p.sOff, p.tOff)
    : tracoLivre(sp, ss, tp, ts, p.sOff, p.tOff)
}

/** Traço com as duas pontas presas num lado: stub reto, miolo, stub reto. */
function tracoAncorado(sp: Pt, ss: Size, tp: Pt, ts: Size, sSide: Side, tSide: Side, sOff = 0, tOff = 0): Pt[] {
  const sa = anchorOn(sp, ss, sSide, sOff)
  const ta = anchorOn(tp, ts, tSide, tOff)
  // lados opostos e quase alinhados (bottom→top, left→right): traço RETO
  const opostos = (sSide === 'bottom' && tSide === 'top') || (sSide === 'top' && tSide === 'bottom')
    ? 'x'
    : (sSide === 'right' && tSide === 'left') || (sSide === 'left' && tSide === 'right')
      ? 'y'
      : null
  if (opostos) {
    const reto = alinhar(sa, ta, opostos)
    if (reto) return reto
  }
  const s1 = pushOut(sa, sSide, STUB)
  const t1 = pushOut(ta, tSide, STUB)
  return dedup([sa, ...miolo(s1, t1, sSide, tSide, sp, ss, tp, ts), ta])
}

/** Desalinhamento que ainda vale a pena ENGOLIR pra desenhar reto. */
const QUASE_ALINHADO = 14

/**
 * Duas pontas quase na mesma coluna (ou linha) viram uma reta, e não um Z com
 * um degrau de 4px no meio — que é o que aparecia entre "3. Descer até a rua" e
 * "Está chovendo?": o elk deixa os centros alguns pixels fora de prumo, e o L/Z
 * desenhava a diferença fielmente. Cada ponta anda metade do desvio ao longo do
 * próprio lado; ninguém percebe 7px de deslocamento na borda de um nó, mas todo
 * mundo percebe o degrau.
 */
function alinhar(sa: Pt, ta: Pt, eixo: 'x' | 'y'): Pt[] | null {
  const delta = eixo === 'x' ? ta.x - sa.x : ta.y - sa.y
  if (delta === 0 || Math.abs(delta) > QUASE_ALINHADO) return null
  const meio = eixo === 'x' ? (sa.x + ta.x) / 2 : (sa.y + ta.y) / 2
  return eixo === 'x' ? [{ x: meio, y: sa.y }, { x: meio, y: ta.y }] : [{ x: sa.x, y: meio }, { x: ta.x, y: meio }]
}

/** O L/Z de sempre: sai pelo lado mais curto e dobra na metade do caminho. */
function tracoLivre(sp: Pt, ss: Size, tp: Pt, ts: Size, sOff = 0, tOff = 0): Pt[] {
  const sc = { x: sp.x + ss.width / 2, y: sp.y + ss.height / 2 }
  const tc = { x: tp.x + ts.width / 2, y: tp.y + ts.height / 2 }
  const dx = tc.x - sc.x
  const dy = tc.y - sc.y
  if (eixoLivre(sp, ss, tp, ts) === 'v') {
    const sa = { x: sc.x + sOff, y: dy > 0 ? sp.y + ss.height : sp.y }
    const ta = { x: tc.x + tOff, y: dy > 0 ? tp.y : tp.y + ts.height }
    const reto = alinhar(sa, ta, 'x')
    if (reto) return reto
    const my = (sa.y + ta.y) / 2
    return dedup([sa, { x: sa.x, y: my }, { x: ta.x, y: my }, ta])
  }
  const sa = { x: dx > 0 ? sp.x + ss.width : sp.x, y: sc.y + sOff }
  const ta = { x: dx > 0 ? tp.x : tp.x + ts.width, y: tc.y + tOff }
  const reto = alinhar(sa, ta, 'y')
  if (reto) return reto
  const mx = (sa.x + ta.x) / 2
  return dedup([sa, { x: mx, y: sa.y }, { x: mx, y: ta.y }, ta])
}

// ---------------------------------------------------------------------------
// Desvio de obstáculo (FF-011) — porte do `routeOrthogonal` de `app.js:196`.
//
// O L/Z acima é barato e resolve a maioria dos casos, mas atravessa qualquer nó
// que esteja no caminho. Aqui a aresta CONTORNA: monta uma grade de visibilidade
// com as bordas dos nós e roda um A* ortogonal por cima, penalizando curva pra
// o traço sair com o menor número de dobras.
//
// Só é chamado quando o L/Z não serve — desviar custa caro e a maioria das
// arestas não precisa.
// ---------------------------------------------------------------------------

export interface Rect {
  x1: number
  y1: number
  x2: number
  y2: number
  cx: number
  cy: number
}

export function toRect(p: Pt, s: Size, inflar = 0): Rect {
  return {
    x1: p.x - inflar,
    y1: p.y - inflar,
    x2: p.x + s.width + inflar,
    y2: p.y + s.height + inflar,
    cx: p.x + s.width / 2,
    cy: p.y + s.height / 2
  }
}

const EPS = 1e-6
/** Limite da grade: acima disso o A* não paga o que custa (o antigo usa o mesmo). */
const MAX_CELULAS = 2600

function bloqueado(x1: number, y1: number, x2: number, y2: number, obs: Rect[]): boolean {
  for (const o of obs) {
    if (Math.abs(y1 - y2) < EPS) {
      const y = y1
      if (y > o.y1 + EPS && y < o.y2 - EPS) {
        const a = Math.min(x1, x2)
        const b = Math.max(x1, x2)
        if (a < o.x2 - EPS && b > o.x1 + EPS) return true
      }
    } else if (Math.abs(x1 - x2) < EPS) {
      const x = x1
      if (x > o.x1 + EPS && x < o.x2 - EPS) {
        const a = Math.min(y1, y2)
        const b = Math.max(y1, y2)
        if (a < o.y2 - EPS && b > o.y1 + EPS) return true
      }
    }
  }
  return false
}

function dentro(px: number, py: number, obs: Rect[]): boolean {
  for (const o of obs) if (px > o.x1 + EPS && px < o.x2 - EPS && py > o.y1 + EPS && py < o.y2 - EPS) return true
  return false
}

function unicos(arr: number[]): number[] {
  const s = [...arr].sort((a, b) => a - b)
  const r: number[] = []
  for (const v of s) if (!r.length || v - r[r.length - 1]! > 1) r.push(v)
  return r
}

/**
 * Caminho ortogonal de `s` até `t` desviando de `obs`.
 * Devolve o traço COMPLETO (com as duas pontas) ou `null` se não valeu a pena —
 * aí quem chamou usa o L/Z.
 */
export function routeAvoiding(sa: Pt, ta: Pt, s: Rect, t: Rect, obs: Rect[]): Pt[] | null {
  if (!obs.length) return null
  // O L/Z já resolve? Então nem monta grade.
  const lA = { x: sa.x, y: ta.y }
  const lB = { x: ta.x, y: sa.y }
  const okA = !bloqueado(sa.x, sa.y, lA.x, lA.y, obs) && !bloqueado(lA.x, lA.y, ta.x, ta.y, obs)
  const okB = !bloqueado(sa.x, sa.y, lB.x, lB.y, obs) && !bloqueado(lB.x, lB.y, ta.x, ta.y, obs)
  // O chamador só chega aqui depois de provar que a rota-base cruza um nó. Se
  // um dos dois cotovelos simples está livre, ele É o desvio; devolver null
  // faria routeAll reutilizar justamente a rota inválida que trouxe a chamada.
  if (okA) return dedup([sa, lA, ta])
  if (okB) return dedup([sa, lB, ta])

  let xs = [s.x1, s.x2, s.cx, t.x1, t.x2, t.cx, sa.x, ta.x]
  let ys = [s.y1, s.y2, s.cy, t.y1, t.y2, t.cy, sa.y, ta.y]
  for (const o of obs) {
    xs.push(o.x1, o.x2)
    ys.push(o.y1, o.y2)
  }
  xs = unicos(xs)
  ys = unicos(ys)
  if (xs.length * ys.length > MAX_CELULAS) return null

  const bloq = xs.map((x) => ys.map((y) => dentro(x, y, obs)))
  const encaixa = (px: number, py: number): { i: number; j: number } => {
    let melhor = Infinity
    let bi = 0
    let bj = 0
    for (let i = 0; i < xs.length; i++) {
      for (let j = 0; j < ys.length; j++) {
        if (bloq[i]![j]) continue
        const d = Math.abs(xs[i]! - px) + Math.abs(ys[j]! - py)
        if (d < melhor) {
          melhor = d
          bi = i
          bj = j
        }
      }
    }
    return { i: bi, j: bj }
  }

  const ini = encaixa(sa.x, sa.y)
  const fim = encaixa(ta.x, ta.y)
  const chave = (i: number, j: number): string => i + ',' + j
  const aberto = new Set([chave(ini.i, ini.j)])
  const veio = new Map<string, string>()
  const g = new Map<string, number>([[chave(ini.i, ini.j), 0]])
  const f = new Map<string, number>([[chave(ini.i, ini.j), 0]])
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1]
  ]
  const alvo = chave(fim.i, fim.j)
  let achou = false

  while (aberto.size) {
    let atual = ''
    let bf = Infinity
    for (const k of aberto) {
      const v = f.get(k) ?? Infinity
      if (v < bf) {
        bf = v
        atual = k
      }
    }
    if (atual === alvo) {
      achou = true
      break
    }
    aberto.delete(atual)
    const [ci, cj] = atual.split(',').map(Number) as [number, number]
    const ant = veio.get(atual)
    for (const [di, dj] of dirs) {
      const ni = ci + di!
      const nj = cj + dj!
      if (ni < 0 || nj < 0 || ni >= xs.length || nj >= ys.length || bloq[ni]![nj]) continue
      if (bloqueado(xs[ci]!, ys[cj]!, xs[ni]!, ys[nj]!, obs)) continue
      const nk = chave(ni, nj)
      // penaliza DOBRA: entre dois caminhos de mesmo comprimento, o com menos
      // curvas é o que parece desenhado por gente
      let curva = 0
      if (ant) {
        const [pi, pj] = ant.split(',').map(Number) as [number, number]
        if (ci - pi !== di || cj - pj !== dj) curva = 12
      }
      const ng = (g.get(atual) ?? 0) + Math.abs(xs[ni]! - xs[ci]!) + Math.abs(ys[nj]! - ys[cj]!) + curva
      if (ng < (g.get(nk) ?? Infinity)) {
        veio.set(nk, atual)
        g.set(nk, ng)
        f.set(nk, ng + Math.abs(xs[ni]! - xs[fim.i]!) + Math.abs(ys[nj]! - ys[fim.j]!))
        aberto.add(nk)
      }
    }
  }
  if (!achou) return null

  const caminho: Pt[] = []
  let k = alvo
  while (k !== chave(ini.i, ini.j)) {
    const [i, j] = k.split(',').map(Number) as [number, number]
    caminho.unshift({ x: xs[i]!, y: ys[j]! })
    const p = veio.get(k)
    if (p === undefined) return null
    k = p
  }
  caminho.unshift({ x: xs[ini.i]!, y: ys[ini.j]! })

  // tira os colineares e costura as pontas reais
  const limpo: Pt[] = []
  for (let i = 0; i < caminho.length; i++) {
    if (i === 0 || i === caminho.length - 1) {
      limpo.push(caminho[i]!)
      continue
    }
    const a = caminho[i - 1]!
    const b = caminho[i]!
    const c = caminho[i + 1]!
    if (!((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y))) limpo.push(b)
  }
  return dedup([sa, ...limpo, ta])
}

/** Quanto a aresta anda reto ao sair da borda antes de dobrar. */
const STUB = 18
/** Folga do contorno quando a linha precisa dar a volta por fora dos dois nós. */
const VOLTA = 26

/**
 * O miolo do traço entre os dois "stubs", quando as pontas estão ANCORADAS num
 * lado. Devolve de `s1` a `t1`, inclusive.
 *
 * A regra que faltava aqui — e que produzia a linha voltando em cima de si
 * mesma, que o usuário viu — é que a dobra tem de estar ao mesmo tempo:
 *   · À FRENTE da saída (na direção pra onde o stub aponta), e
 *   · ATRÁS da entrada (a linha precisa chegar em `t1` pelo lado certo).
 *
 * Com a média simples entre os dois stubs, essas duas condições eram ignoradas.
 * No `arquitetura-flowforge` isso dava dois traços absurdos: um saía 18px pra
 * esquerda e voltava atravessando o próprio nó de origem; o outro atravessava o
 * nó de destino inteiro, passava 18px além e voltava pra entrar pela direita.
 *
 * Quando as duas condições não podem valer juntas, não existe dobra possível: aí
 * o caminho é dar a VOLTA por fora dos dois nós, que é o que uma pessoa
 * desenharia.
 */
function miolo(s1: Pt, t1: Pt, sSide: Side, tSide: Side, sp: Pt, ss: Size, tp: Pt, ts: Size): Pt[] {
  const sa = pushOut(s1, sSide, -STUB)
  const ta = pushOut(t1, tSide, -STUB)
  // Tenta os traçados em ordem de preferência e fica com o primeiro que não se
  // dobra sobre si. Enumerar caso a caso não deu conta: nós SOBREPOSTOS na mesma
  // altura fazem a dobra degenerar num ponto, e aí o traço "de ida" e o "de
  // volta" viram a mesma linha. Verificar o resultado cobre o que a enumeração
  // não previu — inclusive o que eu ainda não imaginei.
  for (const cand of candidatos(s1, t1, sSide, tSide, sp, ss, tp, ts)) {
    if (!voltaSobreSi(dedup([sa, ...cand, ta]))) return cand
  }
  return [s1, t1]
}

/** Dois trechos seguidos na mesma orientação e em sentidos opostos: a linha anda e desanda. */
function voltaSobreSi(pts: Pt[]): boolean {
  for (let i = 2; i < pts.length; i++) {
    const a = pts[i - 2]!
    const b = pts[i - 1]!
    const c = pts[i]!
    if (Math.abs(a.y - b.y) < 0.5 && Math.abs(b.y - c.y) < 0.5 && Math.sign(b.x - a.x) * Math.sign(c.x - b.x) < 0) return true
    if (Math.abs(a.x - b.x) < 0.5 && Math.abs(b.x - c.x) < 0.5 && Math.sign(b.y - a.y) * Math.sign(c.y - b.y) < 0) return true
  }
  return false
}

/** Traçados possíveis entre os dois stubs, do mais direto ao mais rodeado. */
function candidatos(s1: Pt, t1: Pt, sSide: Side, tSide: Side, sp: Pt, ss: Size, tp: Pt, ts: Size): Pt[][] {
  const sv = vertical(sSide)
  const tv = vertical(tSide)
  // caixa que engloba os dois nós, com folga — por onde a volta passa
  const fx1 = Math.min(sp.x, tp.x) - VOLTA
  const fx2 = Math.max(sp.x + ss.width, tp.x + ts.width) + VOLTA
  const fy1 = Math.min(sp.y, tp.y) - VOLTA
  const fy2 = Math.max(sp.y + ss.height, tp.y + ts.height) + VOLTA

  const out: Pt[][] = []
  // dois contornos possíveis por eixo, o mais perto primeiro
  const porFora = (horizontal: boolean): void => {
    const eixos = horizontal
      ? (Math.abs(s1.y - fy1) <= Math.abs(fy2 - s1.y) ? [fy1, fy2] : [fy2, fy1])
      : (Math.abs(s1.x - fx1) <= Math.abs(fx2 - s1.x) ? [fx1, fx2] : [fx2, fx1])
    for (const m of eixos) {
      out.push(horizontal
        ? [s1, { x: s1.x, y: m }, { x: t1.x, y: m }, t1]
        : [s1, { x: m, y: s1.y }, { x: m, y: t1.y }, t1])
    }
  }

  if (!sv && !tv) {
    // as duas pontas na horizontal (left/right): a dobra é uma coluna `mx` que
    // precisa estar à frente da saída E do lado por onde a entrada aceita
    const dS = sSide === 'right' ? 1 : -1
    const dT = tSide === 'right' ? 1 : -1
    const lo = Math.max(dS > 0 ? s1.x : -Infinity, dT > 0 ? t1.x : -Infinity)
    const hi = Math.min(dS > 0 ? Infinity : s1.x, dT > 0 ? Infinity : t1.x)
    if (lo <= hi) {
      const mx = Number.isFinite(lo) && Number.isFinite(hi) ? (lo + hi) / 2 : Number.isFinite(lo) ? lo : hi
      out.push([s1, { x: mx, y: s1.y }, { x: mx, y: t1.y }, t1])
    }
    porFora(true)
    return out
  }

  if (sv && tv) {
    // as duas na vertical (top/bottom) — espelho do caso acima
    const dS = sSide === 'bottom' ? 1 : -1
    const dT = tSide === 'bottom' ? 1 : -1
    const lo = Math.max(dS > 0 ? s1.y : -Infinity, dT > 0 ? t1.y : -Infinity)
    const hi = Math.min(dS > 0 ? Infinity : s1.y, dT > 0 ? Infinity : t1.y)
    if (lo <= hi) {
      const my = Number.isFinite(lo) && Number.isFinite(hi) ? (lo + hi) / 2 : Number.isFinite(lo) ? lo : hi
      out.push([s1, { x: s1.x, y: my }, { x: t1.x, y: my }, t1])
    }
    porFora(false)
    return out
  }

  // uma ponta vertical e a outra horizontal: um cotovelo resolve, se ele cair à
  // frente da saída e atrás da entrada
  const cotovelo = sv ? { x: t1.x, y: s1.y } : { x: s1.x, y: t1.y }
  const frenteDaSaida = sv
    ? sSide === 'bottom' ? cotovelo.y >= s1.y : cotovelo.y <= s1.y
    : sSide === 'right' ? cotovelo.x >= s1.x : cotovelo.x <= s1.x
  const atrasDaEntrada = tv
    ? tSide === 'bottom' ? cotovelo.y >= t1.y : cotovelo.y <= t1.y
    : tSide === 'right' ? cotovelo.x >= t1.x : cotovelo.x <= t1.x
  if (frenteDaSaida && atrasDaEntrada) out.push([s1, cotovelo, t1])
  // Saída lateral, chegada por cima/baixo, e os dois nós em colunas separadas: o
  // caminho de gente é o CORREDOR entre elas, não a volta por fora de tudo.
  if (!sv && tv) {
    const vao = sSide === 'right' ? [sp.x + ss.width, tp.x] : [tp.x + ts.width, sp.x]
    const meio = (vao[0]! + vao[1]!) / 2
    const cabe = vao[1]! - vao[0]! >= STUB * 2 && (sSide === 'right' ? meio >= s1.x : meio <= s1.x)
    if (cabe) out.push([s1, { x: meio, y: s1.y }, { x: meio, y: t1.y }, t1])
  }
  porFora(sv)
  porFora(!sv)
  return out
}

function vertical(s: Side): boolean {
  return s === 'top' || s === 'bottom'
}

/**
 * Os lados por onde a seta sai e chega DE FATO — a fonte única pro traço
 * (`orthRoute`), pro desvio (`routeAll`) e pras âncoras (`distribuirAncoras`),
 * que precisam concordar ou a seta é espalhada num lado e desenhada noutro.
 *
 *   · lado gravado manda, a não ser que esteja de costas (`deCostas`);
 *   · sem lado, a geometria decide — com UMA exceção, a seta CONTRA A CORRENTE:
 *     o destino está noutra coluna e ACIMA (é o que acontece quando o fluxo
 *     comprido quebra em colunas: do pé de uma pro topo da seguinte). Pela
 *     geometria pura ela sairia por cima e subiria por dentro da própria coluna,
 *     colada no caminho principal. Aqui ela sai pelo LADO, sobe pelo corredor
 *     entre as colunas e entra POR CIMA — como todo mundo que chega naquele nó.
 */
function ladosDe(
  sp: Pt,
  ss: Size,
  tp: Pt,
  ts: Size,
  sourceSide?: Side,
  targetSide?: Side,
  temVolta = false
): { sSide: Side; tSide: Side; ancorada: boolean } {
  const dx = tp.x + ts.width / 2 - (sp.x + ss.width / 2)
  const dy = tp.y + ts.height / 2 - (sp.y + ss.height / 2)
  let s = deCostas(sourceSide, sp, ss, tp, ts) ? undefined : sourceSide
  let t = deCostas(targetSide, tp, ts, sp, ss) ? undefined : targetSide
  // ÂNCORA VELHA. O lado é gravado pra UMA geometria — o gesto de ligar, ou o
  // agente compondo o desenho. Quando os nós mudam de lugar ele pode passar a
  // custar uma volta inteira: sair pela esquerda, contornar por cima e chegar na
  // direita de quem agora está logo ali embaixo (foi o que o usuário mostrou).
  // Se obedecer custa MUITO mais traço que o caminho natural, a âncora não vale.
  // A exceção é o par de ida-e-volta (A→B e B→A): ali o desvio é DE PROPÓSITO,
  // pra seta de volta não deitar em cima da de ida.
  if ((s || t) && !temVolta) {
    const comAncora = comprimento(tracoAncorado(sp, ss, tp, ts, s ?? autoSide(sp, ss, tp, ts, false), t ?? autoSide(sp, ss, tp, ts, true)))
    const natural = comprimento(tracoLivre(sp, ss, tp, ts))
    if (comAncora > natural * 1.8 + 120) {
      s = undefined
      t = undefined
    }
  }
  if (!s && !t) {
    const outraColuna = tp.x >= sp.x + ss.width || tp.x + ts.width <= sp.x
    const acima = tp.y + ts.height <= sp.y
    if (outraColuna && acima && Math.abs(dy) >= Math.abs(dx)) {
      return { sSide: dx > 0 ? 'right' : 'left', tSide: 'top', ancorada: true }
    }
    return { sSide: autoSide(sp, ss, tp, ts, false), tSide: autoSide(sp, ss, tp, ts, true), ancorada: false }
  }
  return { sSide: s ?? autoSide(sp, ss, tp, ts, false), tSide: t ?? autoSide(sp, ss, tp, ts, true), ancorada: true }
}

function comprimento(pts: Pt[]): number {
  let total = 0
  for (let i = 1; i < pts.length; i++) total += Math.abs(pts[i]!.x - pts[i - 1]!.x) + Math.abs(pts[i]!.y - pts[i - 1]!.y)
  return total
}

/** Pares `origem>destino` que têm a seta de volta (`destino>origem`) no diagrama. */
function paresComVolta(diagram: Diagram): Set<string> {
  const todas = new Set(diagram.edges.map((e) => e.source + '>' + e.target))
  const out = new Set<string>()
  for (const e of diagram.edges) if (todas.has(e.target + '>' + e.source)) out.add(e.source + '>' + e.target)
  return out
}

/**
 * O lado `side` do nó `a` está de costas pro nó `b`? Só quando `b` fica INTEIRO
 * do lado oposto — é de propósito conservador: laço que sai pela direita e volta
 * pra um nó logo acima (o "não, espera" de um sinal fechado) continua valendo,
 * porque ali `b` não está inteiro à esquerda.
 */
export function deCostas(side: Side | undefined, a: Pt, as: Size, b: Pt, bs: Size): boolean {
  switch (side) {
    case 'left':
      return b.x >= a.x + as.width
    case 'right':
      return b.x + bs.width <= a.x
    case 'top':
      return b.y >= a.y + as.height
    case 'bottom':
      return b.y + bs.height <= a.y
    default:
      return false
  }
}

/** Ponto no lado pedido: o meio, mais `off` ao longo do lado. */
function anchorOn(p: Pt, s: Size, side: Side, off = 0): Pt {
  switch (side) {
    case 'top':
      return { x: p.x + s.width / 2 + off, y: p.y }
    case 'bottom':
      return { x: p.x + s.width / 2 + off, y: p.y + s.height }
    case 'left':
      return { x: p.x, y: p.y + s.height / 2 + off }
    default:
      return { x: p.x + s.width, y: p.y + s.height / 2 + off }
  }
}

function pushOut(p: Pt, side: Side, d: number): Pt {
  switch (side) {
    case 'top':
      return { x: p.x, y: p.y - d }
    case 'bottom':
      return { x: p.x, y: p.y + d }
    case 'left':
      return { x: p.x - d, y: p.y }
    default:
      return { x: p.x + d, y: p.y }
  }
}

/**
 * Por qual EIXO a seta livre viaja: 'v' sai por cima/baixo, 'h' pelos lados.
 *
 * Era só "a maior distância manda", e isso fazia uma decisão sair pelos LADOS do
 * losango pra chegar num nó logo abaixo, só porque o nó estava um pouco deslocado
 * — a seta partia da ponta lateral, voltava por baixo do losango e parecia sair
 * de trás dele. Caixas que se SOBREPÕEM em X estão uma sobre a outra: a seta vai
 * na vertical. Sobrepostas em Y estão lado a lado: vai na horizontal. Só quando
 * não há sobreposição nenhuma (diagonal limpa) a distância decide.
 */
function eixoLivre(sp: Pt, ss: Size, tp: Pt, ts: Size): 'v' | 'h' {
  const sobreX = Math.min(sp.x + ss.width, tp.x + ts.width) - Math.max(sp.x, tp.x) > 0
  const sobreY = Math.min(sp.y + ss.height, tp.y + ts.height) - Math.max(sp.y, tp.y) > 0
  if (sobreX && !sobreY) return 'v'
  if (sobreY && !sobreX) return 'h'
  const dx = tp.x + ts.width / 2 - (sp.x + ss.width / 2)
  const dy = tp.y + ts.height / 2 - (sp.y + ss.height / 2)
  return Math.abs(dy) >= Math.abs(dx) ? 'v' : 'h'
}

/** Lado que a geometria escolheria — usado quando só uma ponta está ancorada. */
function autoSide(sp: Pt, ss: Size, tp: Pt, ts: Size, isTarget: boolean): Side {
  const dx = tp.x + ts.width / 2 - (sp.x + ss.width / 2)
  const dy = tp.y + ts.height / 2 - (sp.y + ss.height / 2)
  if (eixoLivre(sp, ss, tp, ts) === 'v') {
    if (dy > 0) return isTarget ? 'top' : 'bottom'
    return isTarget ? 'bottom' : 'top'
  }
  if (dx > 0) return isTarget ? 'left' : 'right'
  return isTarget ? 'right' : 'left'
}

/** Tira pontos repetidos — eles viram cantos fantasmas no traço. */
function dedup(pts: Pt[]): Pt[] {
  return pts.filter((p, i) => i === 0 || Math.abs(p.x - pts[i - 1]!.x) > 0.5 || Math.abs(p.y - pts[i - 1]!.y) > 0.5)
}

/** Re-roteia TODAS as arestas — usado sempre que as posições não são as do elk. */
/** Ponto na borda do retângulo virado para `alvo` — a saída natural da aresta. */
export function anchorTowards(p: Pt, s: Size, alvo: Pt): Pt {
  const cx = p.x + s.width / 2
  const cy = p.y + s.height / 2
  const dx = alvo.x - cx
  const dy = alvo.y - cy
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? { x: p.x + s.width, y: cy } : { x: p.x, y: cy }
  return dy > 0 ? { x: cx, y: p.y + s.height } : { x: cx, y: p.y }
}

/** Algum trecho do traço atravessa o interior de um obstáculo? */
function caminhoCruza(pts: Pt[], obs: Rect[]): boolean {
  for (let i = 1; i < pts.length; i++) {
    if (bloqueado(pts[i - 1]!.x, pts[i - 1]!.y, pts[i]!.x, pts[i]!.y, obs)) return true
  }
  return false
}

/** Folga em volta do nó pra a aresta não passar raspando na borda. */
const FOLGA_OBSTACULO = 10

// ---------------------------------------------------------------------------
// Âncoras distribuídas
//
// Toda aresta saía e chegava no MEIO do lado. Três setas entrando no mesmo nó
// viravam um tronco só, com as pontas empilhadas — não dava pra contar quantas
// eram nem seguir uma delas. Aqui as pontas que dividem o mesmo lado do mesmo nó
// se espalham ao longo dele, na ordem de quem está do outro lado (o que vem da
// esquerda entra pela esquerda), que é o que evita cruzamento na chegada.
// ---------------------------------------------------------------------------

/** Distância ideal entre duas âncoras vizinhas no mesmo lado. */
const PASSO_ANCORA = 20
/** Quanto de cada ponta do lado fica sem âncora (canto arredondado, canto cortado). */
const MARGEM_LADO = 14

/**
 * Formas cujo contorno É a caixa — só nelas uma âncora fora do meio ainda
 * encosta na borda. No losango, no círculo e na elipse o meio do lado é o único
 * ponto que toca a forma; deslocar dali deixaria a seta flutuando no vazio.
 */
const LADO_RETO = new Set<FlowShape>(['rect', 'subprocess', 'annotation', 'data', 'entity', 'pill'])

/** Comprimento útil do lado para espalhar âncoras (0 = não espalha). */
function ladoUtil(shape: FlowShape, size: Size, side: Side): number {
  if (!LADO_RETO.has(shape)) return 0
  const horizontal = side === 'top' || side === 'bottom'
  // a pílula só tem trecho reto em cima e embaixo, e ele perde um raio de cada ponta
  if (shape === 'pill') return horizontal ? Math.max(0, size.width - size.height - 8) : 0
  return Math.max(0, (horizontal ? size.width : size.height) - 2 * MARGEM_LADO)
}

interface Pontas {
  sSide: Side
  tSide: Side
  /** O traço sai/chega por lado DEFINIDO (arquivo, contra-corrente ou ramo de decisão). */
  ancorada: boolean
  sOff: number
  tOff: number
}

function distribuirAncoras(
  diagram: Diagram,
  positions: Record<string, Pt>,
  sizes: Record<string, Size>
): Record<string, Pontas> {
  const shape: Record<string, FlowShape> = {}
  for (const n of diagram.nodes) shape[n.id] = shapeOf(n.kind)
  const centro = (id: string): Pt => ({ x: positions[id]!.x + sizes[id]!.width / 2, y: positions[id]!.y + sizes[id]!.height / 2 })

  const out: Record<string, Pontas> = {}
  const volta = paresComVolta(diagram)
  // (nó:lado) → pontas que moram ali, com a coordenada de quem está do outro lado
  const grupos = new Map<string, { edge: string; ponta: 'sOff' | 'tOff'; outro: number }[]>()
  for (const e of diagram.edges) {
    if (e.waypoints?.length || !positions[e.source] || !positions[e.target] || e.source === e.target) continue
    if (!sizes[e.source] || !sizes[e.target]) continue
    // o mesmo lado EFETIVO que o `orthRoute` vai usar (âncora de costas não conta)
    const sp = positions[e.source]!
    const tp = positions[e.target]!
    const { sSide, tSide, ancorada } = ladosDe(sp, sizes[e.source]!, tp, sizes[e.target]!, e.sourceSide, e.targetSide, volta.has(e.source + '>' + e.target))
    out[e.id] = { sSide, tSide, ancorada, sOff: 0, tOff: 0 }
  }

  separarRamos(diagram, positions, sizes, shape, out)

  for (const e of diagram.edges) {
    const p = out[e.id]
    if (!p) continue
    const entra = (no: string, side: Side, ponta: 'sOff' | 'tOff', outro: Pt): void => {
      const chave = no + ':' + side
      const lista = grupos.get(chave) ?? []
      lista.push({ edge: e.id, ponta, outro: side === 'top' || side === 'bottom' ? outro.x : outro.y })
      grupos.set(chave, lista)
    }
    // Quem sai por um lado DEFINIDO (ramo de decisão pela ponta lateral) chega de
    // onde o toco aponta, não do centro do nó: mirar o centro fazia a seta sair
    // pela direita, descer e voltar pra esquerda pra entrar no destino.
    const deOnde = p.ancorada
      ? pushOut(anchorOn(positions[e.source]!, sizes[e.source]!, p.sSide), p.sSide, STUB)
      : centro(e.source)
    const praOnde = p.ancorada
      ? pushOut(anchorOn(positions[e.target]!, sizes[e.target]!, p.tSide), p.tSide, STUB)
      : centro(e.target)
    entra(e.source, p.sSide, 'sOff', praOnde)
    entra(e.target, p.tSide, 'tOff', deOnde)
  }

  for (const [chave, lista] of grupos) {
    const corte = chave.lastIndexOf(':')
    const no = chave.slice(0, corte)
    const side = chave.slice(corte + 1) as Side
    const util = ladoUtil(shape[no] ?? 'rect', sizes[no]!, side)
    if (util <= 0) continue
    // A âncora fica na PROJEÇÃO de quem está do outro lado, presa dentro do lado:
    // a seta que vem da direita entra pela parte direita do nó, e o trecho que
    // corria ao longo da borda pra chegar no meio some. Antes toda ponta ia pro
    // meio e só se espalhava quando dividia o lado com outra.
    const c = centro(no)
    const meioDoLado = side === 'top' || side === 'bottom' ? c.x : c.y
    const meta = lista.map((item) => Math.max(-util / 2, Math.min(util / 2, item.outro - meioDoLado)))
    // determinístico: mesma entrada → mesma ordem (o id desempata)
    const ordem = lista.map((item, i) => ({ item, meta: meta[i]! })).sort((a, b) => a.meta - b.meta || a.item.edge.localeCompare(b.item.edge))
    // vizinhas não podem ficar a menos de um passo: empurra pra frente e, se
    // estourar o lado, recua o conjunto
    const passo = Math.min(PASSO_ANCORA, util / Math.max(1, ordem.length - 1))
    const pos: number[] = []
    for (const o of ordem) pos.push(pos.length ? Math.max(o.meta, pos[pos.length - 1]! + passo) : o.meta)
    const estouro = pos[pos.length - 1]! - util / 2
    if (estouro > 0) for (let i = 0; i < pos.length; i++) pos[i] = pos[i]! - estouro
    ordem.forEach((o, i) => {
      out[o.item.edge]![o.item.ponta] = Math.round(Math.max(-util / 2, pos[i]!))
    })
  }

  // Espalhar cria um defeito novo: a seta que descia RETA ganha um degrau de
  // poucos pixels, porque só uma das pontas andou. Quando as duas pontas estão
  // em lados paralelos e quase alinhadas, a de chegada acompanha a de saída.
  const vert = (s: Side): boolean => s === 'top' || s === 'bottom'
  for (const e of diagram.edges) {
    const p = out[e.id]
    if (!p || vert(p.sSide) !== vert(p.tSide)) continue
    const sc = centro(e.source)
    const tc = centro(e.target)
    const delta = vert(p.sSide) ? sc.x + p.sOff - (tc.x + p.tOff) : sc.y + p.sOff - (tc.y + p.tOff)
    if (delta === 0 || Math.abs(delta) > PASSO_ANCORA * 1.5) continue
    const util = ladoUtil(shape[e.target] ?? 'rect', sizes[e.target]!, p.tSide)
    if (Math.abs(p.tOff + delta) <= util / 2) p.tOff += delta
  }
  return out
}

// ---------------------------------------------------------------------------
// Ramos de decisão
//
// O losango (como o gateway, o evento e a elipse) só encosta na seta pelas 4
// PONTAS — não dá pra espalhar âncoras ao longo de um lado, como no retângulo.
// Então quando o "sim" e o "não" apontam os dois pra baixo eles disputam a mesma
// ponta, descem colados, e a separação dos caminhos — que é a informação da
// decisão — só aparece lá embaixo, perto do destino.
//
// A convenção de fluxograma resolve: cada ramo sai por uma ponta.
//   · fica na ponta disputada o ramo de destino mais PRÓXIMO (o passo seguinte);
//   · os outros vão pra ponta lateral DO LADO do destino, se ela estiver livre —
//     dividir ponta com uma seta que CHEGA (sentido contrário) é pior que dividir
//     com outra que sai, então ponta ocupada não recebe ramo;
//   · só saídas: várias setas chegando na mesma ponta é junção, e junção lê bem;
//   · lado gravado no arquivo continua mandando.
// ---------------------------------------------------------------------------

function separarRamos(
  diagram: Diagram,
  positions: Record<string, Pt>,
  sizes: Record<string, Size>,
  shape: Record<string, FlowShape>,
  out: Record<string, Pontas>
): void {
  const centro = (id: string): Pt => ({ x: positions[id]!.x + sizes[id]!.width / 2, y: positions[id]!.y + sizes[id]!.height / 2 })
  // ocupação de cada ponta: quantas setas (entrando ou saindo) moram ali
  const ocupacao = new Map<string, number>()
  const soma = (no: string, side: Side, d: number): void => {
    ocupacao.set(no + ':' + side, (ocupacao.get(no + ':' + side) ?? 0) + d)
  }
  for (const e of diagram.edges) {
    const p = out[e.id]
    if (!p) continue
    soma(e.source, p.sSide, 1)
    soma(e.target, p.tSide, 1)
  }

  for (const n of diagram.nodes) {
    const forma = shape[n.id] ?? 'rect'
    if (LADO_RETO.has(forma) || !positions[n.id]) continue
    const c = centro(n.id)
    // saídas deste nó, por ponta — só as que o ARQUIVO não ancorou
    const porPonta = new Map<Side, DEdgeLike[]>()
    for (const e of diagram.edges) {
      if (e.source !== n.id || e.sourceSide || !out[e.id]) continue
      const side = out[e.id]!.sSide
      porPonta.set(side, [...(porPonta.get(side) ?? []), e])
    }
    for (const [side, saidas] of porPonta) {
      if (saidas.length < 2) continue
      const dist = (e: DEdgeLike): number => {
        const t = centro(e.target)
        return Math.abs(t.x - c.x) + Math.abs(t.y - c.y)
      }
      // o mais próximo fica; o id desempata pra ser determinístico
      const ordenadas = [...saidas].sort((a, b) => dist(a) - dist(b) || a.id.localeCompare(b.id))
      for (const e of ordenadas.slice(1)) {
        const t = centro(e.target)
        const vertical = side === 'top' || side === 'bottom'
        const lateral: Side = vertical ? (t.x < c.x ? 'left' : 'right') : t.y < c.y ? 'top' : 'bottom'
        if ((ocupacao.get(n.id + ':' + lateral) ?? 0) > 0) continue
        soma(n.id, side, -1)
        soma(n.id, lateral, 1)
        out[e.id] = { ...out[e.id]!, sSide: lateral, ancorada: true }
      }
    }
  }
}

type DEdgeLike = Diagram['edges'][number]

// ---------------------------------------------------------------------------
// Trechos sobrepostos
//
// Cada aresta é roteada sem saber das outras, então duas dobras na mesma altura
// desenham UMA linha onde existem duas. Aqui os trechos do MIOLO (nunca o que
// encosta no nó) que correm colados são afastados alguns pixels.
//
// O sentido do afastamento não é arbitrário — é o que evita trocar sobreposição
// por cruzamento: entre setas que SAEM do mesmo nó, a de alcance maior dobra mais
// perto da origem; entre setas que CHEGAM no mesmo nó, mais perto do destino.
// ---------------------------------------------------------------------------

const PASSO_TRECHO = 9

interface Trecho {
  edge: string
  /** O trecho vai de `pts[i]` a `pts[i + 1]`. */
  i: number
  horizontal: boolean
  /** `y` do trecho horizontal, ou `x` do vertical. */
  fixo: number
  a: number
  b: number
}

function afastarTrechos(
  diagram: Diagram,
  rotas: Record<string, Pt[]>,
  obsDe: (e: { source: string; target: string }) => Rect[]
): void {
  const porId = new Map(diagram.edges.map((e) => [e.id, e]))
  const trechos: Trecho[] = []
  for (const e of diagram.edges) {
    const pts = rotas[e.id]
    if (!pts || e.waypoints?.length) continue
    for (let i = 1; i + 2 < pts.length; i++) {
      const p = pts[i]!
      const q = pts[i + 1]!
      const horizontal = Math.abs(p.y - q.y) < 0.5
      if (!horizontal && Math.abs(p.x - q.x) >= 0.5) continue
      trechos.push({
        edge: e.id,
        i,
        horizontal,
        fixo: horizontal ? p.y : p.x,
        a: horizontal ? Math.min(p.x, q.x) : Math.min(p.y, q.y),
        b: horizontal ? Math.max(p.x, q.x) : Math.max(p.y, q.y)
      })
    }
  }

  const colados = (s: Trecho, t: Trecho): boolean =>
    s.edge !== t.edge &&
    s.horizontal === t.horizontal &&
    Math.abs(s.fixo - t.fixo) < 4 &&
    Math.min(s.b, t.b) - Math.max(s.a, t.a) > 10

  // agrupa por transitividade (A cola em B, B cola em C → um feixe só)
  const visto = new Set<number>()
  for (let k = 0; k < trechos.length; k++) {
    if (visto.has(k)) continue
    const feixe = [k]
    visto.add(k)
    for (let c = 0; c < feixe.length; c++) {
      for (let j = 0; j < trechos.length; j++) {
        if (!visto.has(j) && colados(trechos[feixe[c]!]!, trechos[j]!)) {
          visto.add(j)
          feixe.push(j)
        }
      }
    }
    if (feixe.length < 2) continue

    const membros = feixe.map((idx) => trechos[idx]!)
    const arestas = membros.map((m) => porId.get(m.edge)!)
    const mesmaOrigem = arestas.every((e) => e.source === arestas[0]!.source)
    const mesmoDestino = arestas.every((e) => e.target === arestas[0]!.target)
    // o mais comprido primeiro; o id desempata pra ser determinístico
    membros.sort((m, n) => n.b - n.a - (m.b - m.a) || m.edge.localeCompare(n.edge))

    membros.forEach((m, ordem) => {
      const pts = rotas[m.edge]!
      let desloca: number
      if (mesmaOrigem || mesmoDestino) {
        // o mais comprido anda mais, no sentido da ponta que o feixe divide
        const ref = mesmaOrigem ? pts[0]! : pts[pts.length - 1]!
        const sentido = Math.sign((m.horizontal ? ref.y : ref.x) - m.fixo) || 1
        desloca = sentido * (membros.length - 1 - ordem) * PASSO_TRECHO
      } else {
        desloca = Math.round((ordem - (membros.length - 1) / 2) * PASSO_TRECHO)
      }
      if (!desloca) return
      const novo = pts.map((p) => ({ ...p }))
      if (m.horizontal) {
        novo[m.i]!.y += desloca
        novo[m.i + 1]!.y += desloca
      } else {
        novo[m.i]!.x += desloca
        novo[m.i + 1]!.x += desloca
      }
      // só vale se o traço continuar ortogonal, sem laço e sem atropelar ninguém
      const limpo = dedup(novo)
      if (!ortogonal(limpo) || voltaSobreSi(limpo) || caminhoCruza(limpo, obsDe(porId.get(m.edge)!))) return
      rotas[m.edge] = limpo
    })
  }
}

function ortogonal(pts: Pt[]): boolean {
  for (let i = 1; i < pts.length; i++) {
    if (Math.abs(pts[i]!.x - pts[i - 1]!.x) >= 0.5 && Math.abs(pts[i]!.y - pts[i - 1]!.y) >= 0.5) return false
  }
  return true
}

/**
 * Roteamento BARATO pro meio de um arrasto: só as arestas dos nós em `movidos`,
 * só L/Z (sem A*, que a cada pixel fazia as linhas piscarem) — mas com as MESMAS
 * âncoras distribuídas do `routeAll`. Sem isso a seta seguia o mouse saindo do
 * meio do lado e pulava pra âncora dela na hora de soltar.
 */
export function routeMoved(
  diagram: Diagram,
  positions: Record<string, Pt>,
  sizes: Record<string, Size>,
  movidos: Set<string>,
  anteriores: Record<string, Pt[]>
): Record<string, Pt[]> {
  const out = { ...anteriores }
  const volta = paresComVolta(diagram)
  const pontas = distribuirAncoras(diagram, positions, sizes)
  for (const e of diagram.edges) {
    if (!movidos.has(e.source) && !movidos.has(e.target)) continue
    if (e.waypoints?.length) continue // quebra manual: o `routeAll` do soltar resolve
    const s = positions[e.source]
    const t = positions[e.target]
    const ss = sizes[e.source]
    const ts = sizes[e.target]
    if (!s || !t || !ss || !ts) continue
    const off = pontas[e.id]
    out[e.id] = off ? tracar(s, ss, t, ts, off) : orthRoute(s, ss, t, ts, e.sourceSide, e.targetSide, 0, 0, volta.has(e.source + '>' + e.target))
  }
  return out
}

// ---------------------------------------------------------------------------
// Rótulo da seta
// ---------------------------------------------------------------------------

/**
 * Onde o rótulo da seta mora. Devolve o CENTRO da caixa do texto.
 *
 * Antes o rótulo ia no ponto do meio da LISTA de pontos — que é uma quina do
 * traço, não o meio de um trecho — e ninguém conferia se caía em cima de um nó
 * (4 dos 10 rótulos do `conceito-model-view` caíam). Agora cada trecho oferece
 * posições candidatas (acima/abaixo do horizontal; em cima, à direita ou à
 * esquerda do vertical) e ganha a que menos INVADE o que já está desenhado.
 *
 * `ocupado` são os nós e os rótulos já postos: quem chama acrescenta ali a caixa
 * de cada rótulo colocado (`labelRect`), senão dois rótulos de setas vizinhas
 * caem um em cima do outro.
 */
export function labelPoint(pts: Pt[], texto: string, ocupado: Rect[]): Pt {
  const { w, h } = labelSize(texto)
  let melhor: { p: Pt; nota: number } | null = null
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!
    const b = pts[i]!
    const comp = Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
    if (comp < 1) continue
    const horizontal = Math.abs(a.y - b.y) < 0.5
    // A ordem é a preferência (em empate de nota, a primeira fica): o MEIO do
    // trecho antes dos quartos, que só entram quando o meio está tomado.
    const candidatos: Pt[] = []
    for (const t of [0.5, 0.25, 0.75]) {
      const mx = a.x + (b.x - a.x) * t
      const my = a.y + (b.y - a.y) * t
      if (horizontal) candidatos.push({ x: mx, y: my - 11 }, { x: mx, y: my + 11 })
      else candidatos.push({ x: mx, y: my }, { x: mx + w / 2 + 7, y: my }, { x: mx - w / 2 - 7, y: my })
    }
    const cabe = horizontal ? comp >= w + 8 : comp >= h + 12
    candidatos.forEach((p, ordem) => {
      let invade = 0
      for (const r of ocupado) {
        const ox = Math.min(p.x + w / 2, r.x2) - Math.max(p.x - w / 2, r.x1)
        const oy = Math.min(p.y + h / 2, r.y2) - Math.max(p.y - h / 2, r.y1)
        if (ox > 0 && oy > 0) invade += ox * oy
      }
      // invadir pesa mais que tudo; depois, trecho onde o texto CABE; por fim, o comprimento
      const nota = -invade * 40 - (invade > 0 ? 5000 : 0) + (cabe ? (horizontal ? 500 : 250) : 0) + Math.min(comp, 400) - ordem * 12
      if (!melhor || nota > melhor.nota) melhor = { p, nota }
    })
  }
  return (melhor as { p: Pt } | null)?.p ?? pts[Math.floor(pts.length / 2)] ?? { x: 0, y: 0 }
}

function labelSize(texto: string): { w: number; h: number } {
  return { w: texto.length * 6.7 + 10, h: 16 }
}

/** A caixa que um rótulo ocupa em `p` — pra entrar no `ocupado` do próximo. */
export function labelRect(p: Pt, texto: string): Rect {
  const { w, h } = labelSize(texto)
  return { x1: p.x - w / 2, y1: p.y - h / 2, x2: p.x + w / 2, y2: p.y + h / 2, cx: p.x, cy: p.y }
}

/**
 * Traça TODAS as arestas. A ordem de precedência é a regra do FF-011:
 *   1. quebras manuais (`waypoints`) — quem desenhou na mão manda, ponto final
 *   2. L/Z limpo, se não cruzar ninguém — é o traço mais legível e o mais barato
 *   3. desvio A*, só quando o L/Z passaria por cima de um nó
 * Por cima disso, duas passadas que olham o CONJUNTO: as pontas se espalham no
 * lado que dividem (`distribuirAncoras`) e os trechos colados se afastam
 * (`afastarTrechos`). Nenhuma das duas toca em aresta com quebra manual.
 */
export function routeAll(diagram: Diagram, positions: Record<string, Pt>, sizes: Record<string, Size>): Record<string, Pt[]> {
  const out: Record<string, Pt[]> = {}
  const rects: Record<string, Rect> = {}
  for (const n of diagram.nodes) {
    const p = positions[n.id]
    const s = sizes[n.id]
    if (p && s) rects[n.id] = toRect(p, s, FOLGA_OBSTACULO)
  }
  const obsDe = (e: { source: string; target: string }): Rect[] => {
    const obs: Rect[] = []
    for (const n of diagram.nodes) {
      if (n.id === e.source || n.id === e.target) continue
      const r = rects[n.id]
      if (r) obs.push(r)
    }
    return obs
  }
  const pontas = distribuirAncoras(diagram, positions, sizes)
  const volta = paresComVolta(diagram)

  for (const e of diagram.edges) {
    const s = positions[e.source]
    const t = positions[e.target]
    if (!s || !t) continue
    const ss = sizes[e.source]!
    const ts = sizes[e.target]!

    // 1) quebra manual manda
    if (e.waypoints?.length) {
      const sa = anchorTowards(s, ss, e.waypoints[0]!)
      const ta = anchorTowards(t, ts, e.waypoints[e.waypoints.length - 1]!)
      out[e.id] = dedup([sa, ...e.waypoints, ta])
      continue
    }

    const off = pontas[e.id]
    const temVolta = volta.has(e.source + '>' + e.target)
    let base: Pt[]
    try {
      base = off ? tracar(s, ss, t, ts, off) : orthRoute(s, ss, t, ts, e.sourceSide, e.targetSide, 0, 0, temVolta)
    } catch (err) {
      // Uma seta esquisita não pode apagar as outras 41: cai no L/Z cru e avisa.
      console.error('[flowforge] roteamento falhou na aresta', e.id, err)
      base = tracoLivre(s, ss, t, ts)
    }
    const obs = obsDe(e)

    // 2) o traço limpo já serve?
    if (!caminhoCruza(base, obs)) {
      out[e.id] = base
      continue
    }
    // 3) contorna
    // O A* parte SEMPRE de um toco de 18px perpendicular à borda, e os dois nós da
    // seta entram como obstáculo. Entregar a ponta crua ao A* deixava o desvio
    // dobrar já na borda e correr RENTE ao nó (a grade tem uma linha a 10px dele),
    // além de poder sair por uma direção diferente da gravada no arquivo.
    const lados = off ?? ladosDe(s, ss, t, ts, e.sourceSide, e.targetSide, temVolta)
    const sa = base[0]!
    const ta = base[base.length - 1]!
    const inicio = pushOut(sa, lados.sSide, STUB)
    const fim = pushOut(ta, lados.tSide, STUB)
    const desvio = routeAvoiding(inicio, fim, rects[e.source]!, rects[e.target]!, [...obs, rects[e.source]!, rects[e.target]!])
    let candidato = desvio ? dedup([sa, ...desvio, ta]) : null
    // Nem sempre dá: com nós colados o toco cai dentro da folga do vizinho e o A*
    // não acha caminho. Aí vale a tentativa antiga, das pontas cruas — correr
    // rente a um nó é feio, atravessar outro é errado.
    if (!candidato || voltaSobreSi(candidato) || caminhoCruza(candidato, obs)) {
      candidato = routeAvoiding(sa, ta, rects[e.source]!, rects[e.target]!, obs)
    }
    out[e.id] = candidato && !voltaSobreSi(candidato) && !caminhoCruza(candidato, obs)
      ? candidato
      : base
  }
  try {
    afastarTrechos(diagram, out, obsDe)
  } catch (err) {
    console.error('[flowforge] afastar trechos falhou; setas ficam sem o afastamento', err)
  }
  return out
}

// ---------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// O FLUXO COMEÇA NO INÍCIO
//
// O `layered` monta camadas seguindo as setas, e todo laço de volta ("não pegou
// a carteira → tranca a porta de novo") é um CICLO que ele precisa quebrar
// invertendo alguma seta. Deixado por conta própria ele escolhe a que sai mais
// barata — e é assim que um desvio qualquer ia parar no topo do desenho, com o
// "início" perdido no meio. Três coisas amarram isso:
//   · o nó de início é preso na PRIMEIRA camada (`layerConstraint: FIRST`);
//   · o elk recebe os nós em ordem de leitura, com os inícios na frente, e é
//     mandado respeitar essa ordem (`considerModelOrder`);
//   · os ciclos são quebrados em profundidade a partir dessa ordem, então a seta
//     invertida é sempre a de VOLTA, nunca a do caminho principal.
// ---------------------------------------------------------------------------

const KINDS_INICIO = new Set(['start', 'event-start'])

/** Por onde a leitura começa: os `start`; sem eles, quem não tem seta entrando. */
export function iniciosDe(diagram: Diagram): string[] {
  const etapas = diagram.nodes.filter((n) => shapeOf(n.kind) !== 'annotation')
  const declarados = etapas.filter((n) => KINDS_INICIO.has(n.kind))
  if (declarados.length) return declarados.map((n) => n.id)
  const comEntrada = new Set(diagram.edges.map((e) => e.target))
  const temSaida = new Set(diagram.edges.map((e) => e.source))
  return etapas.filter((n) => !comEntrada.has(n.id) && temSaida.has(n.id)).map((n) => n.id)
}

function filhosEmOrdemDeLeitura(
  diagram: Diagram,
  sizes: Record<string, Size>
): { id: string; width: number; height: number; layoutOptions?: Record<string, string> }[] {
  const inicios = new Set(iniciosDe(diagram))
  const comEntrada = new Set(diagram.edges.filter((e) => e.source !== e.target).map((e) => e.target))
  const ordem = [...diagram.nodes.filter((n) => inicios.has(n.id)), ...diagram.nodes.filter((n) => !inicios.has(n.id))]
  return ordem.map((n) => ({
    id: n.id,
    width: sizes[n.id]!.width,
    height: sizes[n.id]!.height,
    // `FIRST` só em quem não tem seta ENTRANDO: o elk recusa (com exceção) prender
    // na primeira camada um nó que recebe seta — e há início que recebe, quando o
    // fluxo volta pro começo. Esse continua na frente pela ordem do modelo.
    ...(inicios.has(n.id) && !comEntrada.has(n.id)
      ? { layoutOptions: { 'elk.layered.layering.layerConstraint': 'FIRST' } }
      : {})
  }))
}

/**
 * Opções do elk que dizem respeito a LER o fluxo.
 *
 * `quebrar` liga o "wrapping" do layered: fluxo comprido deixa de ser uma tira
 * (35 nós davam 3.500×600px, enquadrados a 0,24× — ilegível) e passa a ocupar
 * blocos lado a lado, como texto que quebra em colunas. A proporção-alvo é a de
 * uma tela, que é onde o desenho vai ser lido.
 */
function elkFluxo(quebrar: boolean): Record<string, string> {
  return {
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.layered.cycleBreaking.strategy': 'DEPTH_FIRST',
    // Um layering SÓ. Por padrão o elk arruma cada pedaço desconectado à parte e
    // empacota os blocos por tamanho — e o bloco que contém o início podia ir
    // parar embaixo de um pedaço solto maior que ele.
    'elk.separateConnectedComponents': 'false',
    ...(quebrar
      ? {
          'elk.aspectRatio': '1.5',
          'elk.layered.wrapping.strategy': 'MULTI_EDGE',
          'elk.layered.wrapping.additionalEdgeSpacing': '36',
          'elk.layered.wrapping.correctionFactor': '1.0'
        }
      : {})
  }
}

/**
 * elk `layered` ortogonal. direction DOWN (fluxo/estado) ou RIGHT (ER).
 *
 * `honorSaved: false` ignora o `x`/`y` do arquivo — é o que a Swimlane usa para
 * pegar só a ORDEM do fluxo do elk, sem herdar o desenho do Fluxograma.
 */
export async function layoutDiagram(
  diagram: Diagram,
  direction: 'DOWN' | 'RIGHT' = 'DOWN',
  gapLayers = 70,
  honorSaved = true,
  /**
   * Deixa o fluxo comprido DAR A VOLTA em colunas (ver `elkFluxo`). A Swimlane
   * desliga: ela só aproveita o `x` do elk, e o `y` é a banda da raia — um fluxo
   * quebrado em blocos empilharia etapas diferentes no mesmo `x`.
   */
  quebrar = true
): Promise<LayoutResult> {
  const sizes = sizesOf(diagram)
  const saved = honorSaved ? savedPositions(diagram, sizes) : {}
  const savedCount = Object.keys(saved).length

  // Desenho inteiro salvo: o arquivo manda sozinho e o elk nem roda. Só passa
  // pelo desempilhamento — que na maioria das aberturas não move nada.
  if (savedCount > 0 && savedCount === diagram.nodes.length) {
    const { positions, ajustados } = desempilhar(ordemPorPosicao(saved), saved, sizes)
    return { positions, sizes, edgePoints: routeAll(diagram, positions, sizes), ajustados }
  }

  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.spacing.nodeNodeBetweenLayers': String(gapLayers),
      'elk.spacing.nodeNode': '72',
      'elk.layered.spacing.edgeNodeBetweenLayers': '40',
      // A Swimlane precisa distinguir cada ligação. Fundir arestas cria troncos
      // coincidentes que parecem uma única linha e dificulta seguir o fluxo.
      'elk.layered.mergeEdges': 'false',
      'elk.spacing.edgeEdge': '18',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '18',
      // BRANDES_KOEPF com `favorStraightEdges`: o caminho principal desce RETO e os
      // desvios abrem pro lado. O NETWORK_SIMPLEX empurrava o tronco um degrau pra
      // esquerda a cada decisão, e o fluxo virava uma escada em diagonal.
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.nodePlacement.favorStraightEdges': 'true',
      'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
      ...elkFluxo(quebrar)
    },
    children: filhosEmOrdemDeLeitura(diagram, sizes),
    edges: diagram.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] }))
  }
  const elk = await getElk()
  // Rede de segurança: o elk LANÇA quando uma restrição não fecha com o grafo (já
  // aconteceu com `layerConstraint`). Um diagrama esquisito tem de abrir mal
  // arrumado, nunca deixar o canvas vazio — então a segunda tentativa vai sem as
  // restrições de leitura, só com o básico.
  const res = await elk.layout(graph).catch(() =>
    elk.layout({
      ...graph,
      children: graph.children.map(({ id, width, height }) => ({ id, width, height }))
    })
  )
  const computed: Record<string, Pt> = {}
  for (const c of res.children ?? []) computed[c.id] = { x: c.x ?? 0, y: c.y ?? 0 }

  // Nada salvo: o elk manda nas POSIÇÕES — mas as setas são nossas (`routeAll`).
  // Já foram dele, e dava dois defeitos: (1) o elk enxerga todo nó como retângulo,
  // então no losango, no círculo e na elipse a seta parava na caixa invisível, sem
  // encostar na forma; (2) no primeiro arrasto as posições viram arquivo, o
  // `routeAll` assume, e o desenho inteiro das setas mudava de uma vez. Um
  // roteador só: o diagrama recém-aberto já é o que ele vai ser depois.
  if (savedCount === 0) {
    return { positions: computed, sizes, edgePoints: routeAll(diagram, computed, sizes) }
  }

  // Misto: as arestas do elk não valem mais (os nós saíram do lugar) → re-rota.
  const ancorado = anchorToSaved(diagram, saved, computed, sizes)
  const { positions, ajustados } = desempilhar(ordemPorPosicao(ancorado), ancorado, sizes)
  return { positions, sizes, edgePoints: routeAll(diagram, positions, sizes), ajustados }
}

/**
 * Swimlane: x pelas colunas do elk (RIGHT); y por banda de raia (ator).
 *
 * Lente DERIVADA — ignora o `x`/`y` do arquivo de propósito (ver cabeçalho).
 * Sem `lanes` no diagrama não existe raia nenhuma: em vez de inventar uma faixa
 * "_" e empilhar todo mundo dentro dela, devolve `noLanes` e deixa a UI dizer
 * isso em voz alta.
 */
export async function swimlaneLayout(diagram: Diagram): Promise<LayoutResult> {
  const base = await layoutDiagram(diagram, 'RIGHT', 90, false, false)
  const sizes = base.sizes
  const lanesDef = [...(diagram.lanes ?? [])].sort((a, b) => a.order - b.order)
  if (!lanesDef.length) return { ...base, noLanes: true }

  const laneIds = lanesDef.map((l) => l.id)
  const fallbackLane = laneIds[0]!
  const laneOf = (n: DNode): string => (n.lane && laneIds.includes(n.lane) ? n.lane : fallbackLane)

  // altura de cada banda = maior nó da raia + folga (mín 120)
  const bandHeight: Record<string, number> = {}
  for (const id of laneIds) bandHeight[id] = 120
  for (const n of diagram.nodes) {
    const lane = laneOf(n)
    bandHeight[lane] = Math.max(bandHeight[lane]!, sizes[n.id]!.height + 46)
  }
  const bandY: Record<string, number> = {}
  let acc = 0
  const lanes: LaneBand[] = []
  for (const id of laneIds) {
    bandY[id] = acc
    lanes.push({ id, label: lanesDef.find((l) => l.id === id)?.label ?? '', y: acc, height: bandHeight[id]! })
    acc += bandHeight[id]!
  }
  const positions: LayoutResult['positions'] = {}
  for (const n of diagram.nodes) {
    const lane = laneOf(n)
    const x = base.positions[n.id]?.x ?? 0
    const h = sizes[n.id]!.height
    positions[n.id] = { x: x + 150, y: bandY[lane]! + (bandHeight[lane]! - h) / 2 }
  }

  // Sobreposição também incomoda aqui, mas a Swimlane não grava posição (lente
  // derivada): empurra no eixo X, que é o livre, e não devolve `ajustados`.
  // As arestas só podem ser calculadas DEPOIS disto: antes, o nó mudava de x e
  // as pontas ficavam presas no lugar antigo, visualmente desligadas do nó.
  const semColisao = desempilhar(ordemPorPosicao(positions), positions, sizes, 48, 'x').positions
  return { positions: semColisao, sizes, edgePoints: routeAll(diagram, semColisao, sizes), lanes }
}

/**
 * Layouts NOMEADOS (o menu "arranjo" do editor antigo, `app.js:1319`).
 *
 * Estes ignoram o `x`/`y` salvo de propósito: são o gesto de "reorganiza isso
 * pra mim". O resultado é gravado no arquivo pelo chamador — senão o desenho
 * voltaria ao antigo no próximo reload, que é justamente o que o FF-001 garante.
 */
export type LayoutNome = 'vertical' | 'horizontal' | 'arvore' | 'radial' | 'forca' | 'mapa'

export const LAYOUTS: { nome: LayoutNome; label: string }[] = [
  { nome: 'vertical', label: 'Vertical' },
  { nome: 'horizontal', label: 'Horizontal' },
  { nome: 'arvore', label: 'Árvore' },
  { nome: 'radial', label: 'Radial' },
  { nome: 'forca', label: 'Força' }
]

/**
 * Os arranjos do Mind map. Os de grafo (elk layered/mrtree/force) não entendem
 * "raiz no centro": num mapa de 33 nós o Árvore dava uma tira de 6600px e o
 * Força, 57 cruzamentos. Na lente Mind map o menu oferece só estes.
 */
export const LAYOUTS_MIND: { nome: LayoutNome; label: string }[] = [
  { nome: 'mapa', label: 'Mapa (dois lados)' },
  { nome: 'radial', label: 'Radial' }
]

export async function namedLayout(diagram: Diagram, nome: LayoutNome): Promise<LayoutResult> {
  if (nome === 'mapa') return mindLayout(diagram, false)
  if (nome === 'radial') return radialLayout(diagram, false)
  if (nome === 'vertical') return layoutDiagram(diagram, 'DOWN', 70, false)
  if (nome === 'horizontal') return layoutDiagram(diagram, 'RIGHT', 90, false)

  const sizes = sizesOf(diagram)
  const algoritmo = nome === 'arvore' ? 'mrtree' : 'force'
  const opts: Record<string, string> =
    nome === 'arvore'
      ? { 'elk.algorithm': 'mrtree', 'elk.spacing.nodeNode': '54', 'elk.mrtree.searchOrder': 'DFS' }
      : { 'elk.algorithm': 'force', 'elk.spacing.nodeNode': '96', 'elk.force.iterations': '300' }
  const res = await (await getElk()).layout({
    id: 'root',
    layoutOptions: { ...opts, 'elk.algorithm': algoritmo },
    children: diagram.nodes.map((n) => ({ id: n.id, width: sizes[n.id]!.width, height: sizes[n.id]!.height })),
    edges: diagram.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] }))
  })
  const positions: Record<string, Pt> = {}
  for (const c of res.children ?? []) positions[c.id] = { x: c.x ?? 0, y: c.y ?? 0 }
  return { positions, sizes, edgePoints: routeAll(diagram, positions, sizes) }
}

/** Raiz (nó sem aresta de entrada) e filhos por nó, na ordem do arquivo. */
function arvoreDe(diagram: Diagram): { root: DNode | undefined; children: Record<string, string[]> } {
  const targets = new Set(diagram.edges.map((e) => e.target))
  const root = diagram.nodes.find((n) => !targets.has(n.id)) ?? diagram.nodes[0]
  const ids = new Set(diagram.nodes.map((n) => n.id))
  const children: Record<string, string[]> = {}
  const visto = new Set<string>(root ? [root.id] : [])
  // cada nó entra UMA vez (a primeira aresta que chega nele): ciclo ou pai duplo
  // no arquivo não pode virar recursão infinita nem nó desenhado duas vezes
  for (const e of diagram.edges) {
    if (!ids.has(e.source) || !ids.has(e.target) || visto.has(e.target)) continue
    visto.add(e.target)
    ;(children[e.source] ??= []).push(e.target)
  }
  return { root, children }
}

/**
 * O fim comum dos dois arranjos do mind map: o arquivo manda (o usuário arruma
 * o mapa na mão), quem sobrar em cima de alguém é afastado, e as arestas saem
 * de `mindEdgePoints`.
 */
function fechaMind(diagram: Diagram, computed: Record<string, Pt>, sizes: LayoutResult['sizes'], honorSaved: boolean): LayoutResult {
  // nó fora da árvore (solto, sem aresta) não pode ficar sem posição
  let yOrfao = Math.max(0, ...Object.keys(computed).map((id) => computed[id]!.y + sizes[id]!.height)) + 60
  for (const n of diagram.nodes) {
    if (computed[n.id]) continue
    computed[n.id] = { x: -sizes[n.id]!.width / 2, y: yOrfao }
    yOrfao += sizes[n.id]!.height + 20
  }
  const saved = honorSaved ? savedPositions(diagram, sizes) : {}
  const base = Object.keys(saved).length ? anchorToSaved(diagram, saved, computed, sizes) : computed
  const solto = desempilhar(ordemPorPosicao(base), base, sizes)
  return {
    positions: solto.positions,
    sizes,
    edgePoints: mindEdgePoints(diagram, solto.positions, sizes),
    ajustados: solto.ajustados
  }
}

/**
 * Aresta do mind map: DOIS pontos, da lateral do pai à lateral do filho, pelo
 * lado em que o filho está. A `MindEdge` desenha a bézier entre eles.
 *
 * É a ÚNICA fonte de pontos da lente Mind map — o editor chama esta função
 * também durante e depois do arrasto. O roteador ortogonal (`routeAll`) devolve
 * uma polilinha com quebras, e a bézier lida como "os dois primeiros pontos"
 * virava um toco reto solto no meio do canvas.
 */
export function mindEdgePoints(diagram: Diagram, positions: Record<string, Pt>, sizes: LayoutResult['sizes']): LayoutResult['edgePoints'] {
  const out: LayoutResult['edgePoints'] = {}
  for (const e of diagram.edges) {
    const s = positions[e.source]
    const t = positions[e.target]
    const ss = sizes[e.source]
    const ts = sizes[e.target]
    if (!s || !t || !ss || !ts) continue
    const direita = t.x + ts.width / 2 >= s.x + ss.width / 2
    out[e.id] = [
      { x: direita ? s.x + ss.width : s.x, y: s.y + ss.height / 2 },
      { x: direita ? t.x : t.x + ts.width, y: t.y + ts.height / 2 }
    ]
  }
  return out
}

/**
 * Mind map: árvore horizontal de dois lados — a raiz no centro, metade dos ramos
 * à direita e metade à esquerda, cada subárvore ocupando a altura das suas folhas.
 *
 * É o arranjo clássico de mapa mental (XMind, MindNode, markmap), e a razão é
 * geométrica: o texto é horizontal, então empilhar irmãos na vertical custa a
 * ALTURA de cada nó (~50px), enquanto o anel custa a LARGURA (~200px) em arco.
 * O radial de anel fixo não cabia: 26 folhas num anel de 460px de raio dá 111px
 * de arco por nó de até 210px — metade nascia sobreposta e o `desempilhar`
 * espalhava sem critério (visto em 18/09/2026, sessão `melhorias-flowforge`).
 */
export function mindLayout(diagram: Diagram, honorSaved = true): LayoutResult {
  const { root, children } = arvoreDe(diagram)
  const sizes = sizesMind(diagram, root?.id)
  const computed: Record<string, Pt> = {}
  if (!root) return fechaMind(diagram, computed, sizes, honorSaved)

  const HGAP = 72 // entre a lateral do pai e a do filho: espaço da curva
  const VGAP = 14 // entre irmãos
  const RAMO_GAP = 30 // entre ramos principais, pra cor não encostar em cor

  // altura do bloco da subárvore = o maior entre o nó e a pilha dos filhos
  const bloco: Record<string, number> = {}
  const mede = (id: string): number => {
    const ch = children[id] ?? []
    const pilha = ch.reduce((s, c) => s + mede(c), 0) + Math.max(0, ch.length - 1) * VGAP
    return (bloco[id] = Math.max(sizes[id]!.height, pilha))
  }
  mede(root.id)

  /** Empilha `ids` centrados em `cy`, encostados na lateral `borda` do pai. */
  const empilha = (ids: string[], borda: number, cy: number, lado: 1 | -1, gap: number): void => {
    const total = ids.reduce((s, c) => s + bloco[c]!, 0) + Math.max(0, ids.length - 1) * gap
    let y = cy - total / 2
    for (const id of ids) {
      const s = sizes[id]!
      const meio = y + bloco[id]! / 2
      const x = lado === 1 ? borda + HGAP : borda - HGAP - s.width
      computed[id] = { x, y: meio - s.height / 2 }
      empilha(children[id] ?? [], lado === 1 ? x + s.width : x, meio, lado, VGAP)
      y += bloco[id]! + gap
    }
  }

  const rs = sizes[root.id]!
  computed[root.id] = { x: -rs.width / 2, y: -rs.height / 2 }

  // ramos na ordem do arquivo: enche a direita até a metade da altura, o resto vai
  // pra esquerda. Até 2 ramos fica tudo à direita — mapa pequeno lê melhor assim.
  const ramos = children[root.id] ?? []
  const total = ramos.reduce((s, c) => s + bloco[c]!, 0)
  const direita: string[] = []
  const esquerda: string[] = []
  let acc = 0
  for (const c of ramos) {
    if (ramos.length <= 2 || acc < total / 2) direita.push(c)
    else esquerda.push(c)
    acc += bloco[c]!
  }
  empilha(direita, rs.width / 2, 0, 1, RAMO_GAP)
  empilha(esquerda, -rs.width / 2, 0, -1, RAMO_GAP)

  return fechaMind(diagram, computed, sizes, honorSaved)
}

/**
 * Mind map em anéis: alternativa do menu de arranjo. O raio de cada anel cresce
 * até caber quem mora nele — com anel fixo, mapa de mais de ~12 folhas nascia
 * sobreposto. Fica grande em mapa cheio; o padrão da lente é o `mindLayout`.
 */
export function radialLayout(diagram: Diagram, honorSaved = true): LayoutResult {
  const { root, children } = arvoreDe(diagram)
  const sizes = sizesMind(diagram, root?.id)
  const computed: Record<string, Pt> = {}

  // conta folhas por subárvore → distribui setores angulares proporcionais
  const leaves: Record<string, number> = {}
  const countLeaves = (id: string): number => {
    const ch = children[id] ?? []
    if (!ch.length) return (leaves[id] = 1)
    return (leaves[id] = ch.reduce((s, c) => s + countLeaves(c), 0))
  }
  if (root) countLeaves(root.id)

  // raio por profundidade: o menor setor do anel tem de comportar a diagonal do nó
  const RING = 230
  const pedido: number[] = []
  const medeAnel = (id: string, depth: number, span: number): void => {
    const s = sizes[id]!
    if (depth > 0) pedido[depth] = Math.max(pedido[depth] ?? 0, (Math.hypot(s.width, s.height) + 24) / Math.min(span, Math.PI))
    for (const c of children[id] ?? []) medeAnel(c, depth + 1, (span * leaves[c]!) / (leaves[id] || 1))
  }
  if (root) medeAnel(root.id, 0, 2 * Math.PI)
  const raio: number[] = [0]
  for (let d = 1; d < pedido.length; d++) raio[d] = Math.max(raio[d - 1]! + RING, pedido[d] ?? 0)

  const place = (id: string, depth: number, a0: number, a1: number): void => {
    const mid = (a0 + a1) / 2
    const r = raio[depth] ?? depth * RING
    const s = sizes[id]!
    computed[id] = { x: Math.cos(mid) * r - s.width / 2, y: Math.sin(mid) * r - s.height / 2 }
    const ch = children[id] ?? []
    let a = a0
    for (const c of ch) {
      const span = ((a1 - a0) * leaves[c]!) / (leaves[id] || 1)
      place(c, depth + 1, a, a + span)
      a += span
    }
  }
  if (root) place(root.id, 0, -Math.PI, Math.PI)

  return fechaMind(diagram, computed, sizes, honorSaved)
}
