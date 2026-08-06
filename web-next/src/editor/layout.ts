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
import type { Diagram, DNode, Side } from '../types.js'
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

export type Pt = { x: number; y: number }
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
      // retângulo (task/subprocess/state): cabeçalho + corpo mono
      const width = Math.max(190, Math.min(300, 66 + len * 7))
      const hasDesc = !!(n.description && n.description.trim())
      return { width, height: hasDesc ? 82 : 42 }
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
    const meio = vertical(sSide)
      ? [{ x: s1.x, y: (s1.y + t1.y) / 2 }, { x: t1.x, y: (s1.y + t1.y) / 2 }]
      : [{ x: (s1.x + t1.x) / 2, y: s1.y }, { x: (s1.x + t1.x) / 2, y: t1.y }]
    return dedup([sa, s1, ...meio, t1, ta])
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

/** Quanto a aresta anda reto ao sair da borda antes de dobrar. */
const STUB = 18

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
function routeAll(diagram: Diagram, positions: Record<string, Pt>, sizes: Record<string, Size>): Record<string, Pt[]> {
  const out: Record<string, Pt[]> = {}
  for (const e of diagram.edges) {
    const s = positions[e.source]
    const t = positions[e.target]
    if (!s || !t) continue
    out[e.id] = orthRoute(s, sizes[e.source]!, t, sizes[e.target]!, e.sourceSide, e.targetSide)
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
