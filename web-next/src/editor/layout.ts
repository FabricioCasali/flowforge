// ============================================================================
// layout.ts — posicionamento + roteamento por lente.
//  • layoutDiagram  → elk `layered` ortogonal (Fluxograma, Máq. estados, ER)
//  • swimlaneLayout → colunas do elk + bandas por raia (ator×ação)
//  • radialLayout   → árvore radial (Mind map)
// Coordenadas = coords do React Flow. edgePoints alimentam a aresta custom.
//
// LEI 2 (arquivo é a verdade) aplicada à geometria: **quem tem `x`/`y` no
// arquivo manda**. O elk só calcula quem não tem — e o que ele calcular é
// transladado para o referencial do desenho salvo, senão o nó novo do Claude
// aparece a mil pixels do diagrama que o Fabricio arrastou. Ver `anchorToSaved`.
//
// A Swimlane é a exceção declarada (`savesPos: false` em `lenses.ts`): ela
// recalcula sempre, porque divide o `process` — e o par `x`/`y` — com o
// Fluxograma. Decisão do Fabricio em 06/08/2026.
// ============================================================================

import ELK from 'elkjs/lib/elk.bundled.js'
import type { Diagram, DNode, Pt, Side } from '../types.js'
import { EVENT_SIZE, GATE_SIZE, shapeOf } from './shapes.js'

const elk = new ELK()

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
    // losango clássico — rótulo DENTRO, então precisa de área
    case 'diamond':
      return { width: 168, height: 104 }
    case 'data':
      return { width: 128, height: 72 }
    case 'annotation': {
      // a anotação É o texto: quebra em ~2 linhas antes de crescer na largura
      const width = Math.max(150, Math.min(280, 40 + len * 6.2))
      const linhas = Math.max(1, Math.ceil((len * 6.2) / Math.max(1, width - 34)))
      return { width, height: Math.max(44, 22 + linhas * 16) }
    }
    case 'pill':
      return { width: Math.max(120, Math.min(230, 44 + len * 7.2)), height: 46 }
    case 'idea':
      return { width: Math.max(96, Math.min(210, 44 + len * 7.6)), height: 40 }
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
 * Nó sem `x`/`y` (recém-nascido do Claude) fica fora.
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
 * editor antigo, que é o que o Fabricio aprovou na fase 3. Sai pelo lado mais
 * curto e dobra na metade do caminho.
 */
export function orthRoute(sp: Pt, ss: Size, tp: Pt, ts: Size, sourceSide?: Side, targetSide?: Side): Pt[] {
  const sc = { x: sp.x + ss.width / 2, y: sp.y + ss.height / 2 }
  const tc = { x: tp.x + ts.width / 2, y: tp.y + ts.height / 2 }
  const dx = tc.x - sc.x
  const dy = tc.y - sc.y

  // Lado ancorado no arquivo manda (54 pontas dos diagramas reais usam isto).
  // Sem lado, a geometria decide — que é o comportamento de sempre.
  if (sourceSide || targetSide) {
    const sSide = sourceSide ?? autoSide(dx, dy, false)
    const tSide = targetSide ?? autoSide(dx, dy, true)
    const sa = anchorOn(sp, ss, sSide)
    const ta = anchorOn(tp, ts, tSide)
    const s1 = pushOut(sa, sSide, STUB)
    const t1 = pushOut(ta, tSide, STUB)
    return dedup([sa, ...miolo(s1, t1, sSide, tSide, sp, ss, tp, ts), ta])
  }

  if (Math.abs(dy) >= Math.abs(dx)) {
    const sa = { x: sc.x, y: dy > 0 ? sp.y + ss.height : sp.y }
    const ta = { x: tc.x, y: dy > 0 ? tp.y : tp.y + ts.height }
    const my = (sa.y + ta.y) / 2
    return [sa, { x: sa.x, y: my }, { x: ta.x, y: my }, ta]
  }
  const sa = { x: dx > 0 ? sp.x + ss.width : sp.x, y: sc.y }
  const ta = { x: dx > 0 ? tp.x : tp.x + ts.width, y: tc.y }
  const mx = (sa.x + ta.x) / 2
  return [sa, { x: mx, y: sa.y }, { x: mx, y: ta.y }, ta]
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
  if (okA || okB) return null

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
 * mesma, que o Fabricio viu — é que a dobra tem de estar ao mesmo tempo:
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
  porFora(sv)
  porFora(!sv)
  return out
}

function vertical(s: Side): boolean {
  return s === 'top' || s === 'bottom'
}

/** Ponto no meio do lado pedido. */
function anchorOn(p: Pt, s: Size, side: Side): Pt {
  switch (side) {
    case 'top':
      return { x: p.x + s.width / 2, y: p.y }
    case 'bottom':
      return { x: p.x + s.width / 2, y: p.y + s.height }
    case 'left':
      return { x: p.x, y: p.y + s.height / 2 }
    default:
      return { x: p.x + s.width, y: p.y + s.height / 2 }
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

/** Lado que a geometria escolheria — usado quando só uma ponta está ancorada. */
function autoSide(dx: number, dy: number, isTarget: boolean): Side {
  if (Math.abs(dy) >= Math.abs(dx)) {
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

/**
 * Traça TODAS as arestas. A ordem de precedência é a regra do FF-011:
 *   1. quebras manuais (`waypoints`) — quem desenhou na mão manda, ponto final
 *   2. L/Z limpo, se não cruzar ninguém — é o traço mais legível e o mais barato
 *   3. desvio A*, só quando o L/Z passaria por cima de um nó
 */
function routeAll(diagram: Diagram, positions: Record<string, Pt>, sizes: Record<string, Size>): Record<string, Pt[]> {
  const out: Record<string, Pt[]> = {}
  const rects: Record<string, Rect> = {}
  for (const n of diagram.nodes) {
    const p = positions[n.id]
    const s = sizes[n.id]
    if (p && s) rects[n.id] = toRect(p, s, FOLGA_OBSTACULO)
  }

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

    const base = orthRoute(s, ss, t, ts, e.sourceSide, e.targetSide)
    const obs: Rect[] = []
    for (const n of diagram.nodes) {
      if (n.id === e.source || n.id === e.target) continue
      const r = rects[n.id]
      if (r) obs.push(r)
    }

    // 2) o traço limpo já serve?
    if (!caminhoCruza(base, obs)) {
      out[e.id] = base
      continue
    }
    // 3) contorna
    const desvio = routeAvoiding(base[0]!, base[base.length - 1]!, rects[e.source]!, rects[e.target]!, obs)
    out[e.id] = desvio ?? base
  }
  return out
}

// ---------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------

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
  honorSaved = true
): Promise<LayoutResult> {
  const sizes = sizesOf(diagram)
  const saved = honorSaved ? savedPositions(diagram, sizes) : {}
  const savedCount = Object.keys(saved).length

  // Desenho inteiro salvo: o arquivo manda sozinho e o elk nem roda.
  if (savedCount > 0 && savedCount === diagram.nodes.length) {
    return { positions: saved, sizes, edgePoints: routeAll(diagram, saved, sizes) }
  }

  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': direction,
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.spacing.nodeNodeBetweenLayers': String(gapLayers),
      'elk.spacing.nodeNode': '48',
      'elk.layered.spacing.edgeNodeBetweenLayers': '28',
      'elk.layered.mergeEdges': 'true',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX'
    },
    children: diagram.nodes.map((n) => ({ id: n.id, width: sizes[n.id]!.width, height: sizes[n.id]!.height })),
    edges: diagram.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] }))
  }
  const res = await elk.layout(graph)
  const computed: Record<string, Pt> = {}
  for (const c of res.children ?? []) computed[c.id] = { x: c.x ?? 0, y: c.y ?? 0 }

  // Nada salvo: o elk manda inteiro, inclusive no roteamento (mais bonito que o
  // nosso L/Z, porque ele desvia dos nós).
  if (savedCount === 0) {
    const edgePoints: LayoutResult['edgePoints'] = {}
    for (const e of res.edges ?? []) {
      const sec = e.sections?.[0]
      if (!sec) continue
      edgePoints[e.id] = [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint].filter(Boolean) as Pt[]
    }
    return { positions: computed, sizes, edgePoints }
  }

  // Misto: as arestas do elk não valem mais (os nós saíram do lugar) → re-rota.
  const positions = anchorToSaved(diagram, saved, computed, sizes)
  return { positions, sizes, edgePoints: routeAll(diagram, positions, sizes) }
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
  const base = await layoutDiagram(diagram, 'RIGHT', 90, false)
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
  const totalH = acc

  const positions: LayoutResult['positions'] = {}
  for (const n of diagram.nodes) {
    const lane = laneOf(n)
    const x = base.positions[n.id]?.x ?? 0
    const h = sizes[n.id]!.height
    positions[n.id] = { x: x + 150, y: bandY[lane]! + (bandHeight[lane]! - h) / 2 }
  }

  // roteamento ortogonal manual (fluxo horizontal cruzando raias)
  const edgePoints: LayoutResult['edgePoints'] = {}
  for (const e of diagram.edges) {
    const s = positions[e.source]
    const t = positions[e.target]
    if (!s || !t) continue
    const ss = sizes[e.source]!
    const ts = sizes[e.target]!
    const sr = { x: s.x + ss.width, y: s.y + ss.height / 2 }
    const tl = { x: t.x, y: t.y + ts.height / 2 }
    if (tl.x > sr.x + 8) {
      const mx = (sr.x + tl.x) / 2
      edgePoints[e.id] = [sr, { x: mx, y: sr.y }, { x: mx, y: tl.y }, tl]
    } else {
      // aresta "de volta": desce abaixo das raias e retorna
      const below = totalH + 30
      const sb = { x: s.x + ss.width / 2, y: s.y + ss.height }
      const tb = { x: t.x + ts.width / 2, y: t.y + ts.height }
      edgePoints[e.id] = [sb, { x: sb.x, y: below }, { x: tb.x, y: below }, tb]
    }
  }
  return { positions, sizes, edgePoints, lanes }
}

/**
 * Layouts NOMEADOS (o menu "arranjo" do editor antigo, `app.js:1319`).
 *
 * Estes ignoram o `x`/`y` salvo de propósito: são o gesto de "reorganiza isso
 * pra mim". O resultado é gravado no arquivo pelo chamador — senão o desenho
 * voltaria ao antigo no próximo reload, que é justamente o que o FF-001 garante.
 */
export type LayoutNome = 'vertical' | 'horizontal' | 'arvore' | 'radial' | 'forca'

export const LAYOUTS: { nome: LayoutNome; label: string }[] = [
  { nome: 'vertical', label: 'Vertical' },
  { nome: 'horizontal', label: 'Horizontal' },
  { nome: 'arvore', label: 'Árvore' },
  { nome: 'radial', label: 'Radial' },
  { nome: 'forca', label: 'Força' }
]

export async function namedLayout(diagram: Diagram, nome: LayoutNome): Promise<LayoutResult> {
  if (nome === 'radial') return radialLayout(diagram, false)
  if (nome === 'vertical') return layoutDiagram(diagram, 'DOWN', 70, false)
  if (nome === 'horizontal') return layoutDiagram(diagram, 'RIGHT', 90, false)

  const sizes = sizesOf(diagram)
  const algoritmo = nome === 'arvore' ? 'mrtree' : 'force'
  const opts: Record<string, string> =
    nome === 'arvore'
      ? { 'elk.algorithm': 'mrtree', 'elk.spacing.nodeNode': '54', 'elk.mrtree.searchOrder': 'DFS' }
      : { 'elk.algorithm': 'force', 'elk.spacing.nodeNode': '96', 'elk.force.iterations': '300' }
  const res = await elk.layout({
    id: 'root',
    layoutOptions: { ...opts, 'elk.algorithm': algoritmo },
    children: diagram.nodes.map((n) => ({ id: n.id, width: sizes[n.id]!.width, height: sizes[n.id]!.height })),
    edges: diagram.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] }))
  })
  const positions: Record<string, Pt> = {}
  for (const c of res.children ?? []) positions[c.id] = { x: c.x ?? 0, y: c.y ?? 0 }
  return { positions, sizes, edgePoints: routeAll(diagram, positions, sizes) }
}

/** Mind map: árvore radial a partir da raiz (nó sem arestas de entrada). */
export function radialLayout(diagram: Diagram, honorSaved = true): LayoutResult {
  const sizes = sizesOf(diagram)
  const targets = new Set(diagram.edges.map((e) => e.target))
  const root = diagram.nodes.find((n) => !targets.has(n.id)) ?? diagram.nodes[0]
  const computed: Record<string, Pt> = {}
  const children: Record<string, string[]> = {}
  for (const e of diagram.edges) (children[e.source] ??= []).push(e.target)

  // conta folhas por subárvore → distribui setores angulares proporcionais
  const leaves: Record<string, number> = {}
  const countLeaves = (id: string): number => {
    const ch = children[id] ?? []
    if (!ch.length) return (leaves[id] = 1)
    return (leaves[id] = ch.reduce((s, c) => s + countLeaves(c), 0))
  }
  if (root) countLeaves(root.id)

  const RING = 230
  const place = (id: string, depth: number, a0: number, a1: number): void => {
    const mid = (a0 + a1) / 2
    const r = depth * RING
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

  // o arquivo manda também aqui (o Fabricio arruma o mapa na mão)
  const saved = honorSaved ? savedPositions(diagram, sizes) : {}
  const positions = Object.keys(saved).length ? anchorToSaved(diagram, saved, computed, sizes) : computed

  // arestas mind = bezier entre centros (a aresta custom desenha a curva)
  const edgePoints: LayoutResult['edgePoints'] = {}
  for (const e of diagram.edges) {
    const s = positions[e.source]
    const t = positions[e.target]
    if (!s || !t) continue
    const ss = sizes[e.source]!
    const ts = sizes[e.target]!
    edgePoints[e.id] = [
      { x: s.x + ss.width / 2, y: s.y + ss.height / 2 },
      { x: t.x + ts.width / 2, y: t.y + ts.height / 2 }
    ]
  }
  return { positions, sizes, edgePoints }
}
