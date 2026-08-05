// ============================================================================
// layout.ts — posicionamento + roteamento por lente.
//  • layoutDiagram  → elk `layered` ortogonal (Fluxograma, Máq. estados, ER)
//  • swimlaneLayout → colunas do elk + bandas por raia (ator×ação)
//  • radialLayout   → árvore radial (Mind map)
// Coordenadas = coords do React Flow. edgePoints alimentam a aresta custom.
// ============================================================================

import ELK from 'elkjs/lib/elk.bundled.js'
import type { Diagram, DNode } from '../types.js'

const elk = new ELK()

export interface LaneBand {
  id: string
  label: string
  y: number
  height: number
}
export interface LayoutResult {
  positions: Record<string, { x: number; y: number }>
  sizes: Record<string, { width: number; height: number }>
  edgePoints: Record<string, { x: number; y: number }[]>
  lanes?: LaneBand[]
}

export function nodeSize(n: DNode): { width: number; height: number } {
  const len = (n.label || '').length
  const kind = n.kind
  if (kind === 'entity') {
    const rows = n.fields?.length ?? 0
    return { width: 224, height: 36 + rows * 22 + 8 }
  }
  if (kind === 'decision' || kind === 'gateway-exclusive' || kind === 'gateway-parallel')
    return { width: 168, height: 104 }
  if (kind === 'start' || kind === 'end' || kind === 'event-start' || kind === 'event-end' || kind === 'event-intermediate')
    return { width: Math.max(120, Math.min(230, 44 + len * 7.2)), height: 46 }
  if (kind === 'idea') return { width: Math.max(96, Math.min(210, 44 + len * 7.6)), height: 40 }
  // retângulo (task/subprocess/state): cabeçalho + corpo mono
  const width = Math.max(190, Math.min(300, 66 + len * 7))
  const hasDesc = !!(n.description && n.description.trim())
  return { width, height: hasDesc ? 82 : 42 }
}

function sizesOf(diagram: Diagram): LayoutResult['sizes'] {
  const sizes: LayoutResult['sizes'] = {}
  for (const n of diagram.nodes) sizes[n.id] = nodeSize(n)
  return sizes
}

/** elk `layered` ortogonal. direction DOWN (fluxo/estado) ou RIGHT (ER). */
export async function layoutDiagram(
  diagram: Diagram,
  direction: 'DOWN' | 'RIGHT' = 'DOWN',
  gapLayers = 70
): Promise<LayoutResult> {
  const sizes = sizesOf(diagram)
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
  const positions: LayoutResult['positions'] = {}
  for (const c of res.children ?? []) positions[c.id] = { x: c.x ?? 0, y: c.y ?? 0 }
  const edgePoints: LayoutResult['edgePoints'] = {}
  for (const e of res.edges ?? []) {
    const sec = e.sections?.[0]
    if (!sec) continue
    edgePoints[e.id] = [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint].filter(Boolean) as {
      x: number
      y: number
    }[]
  }
  return { positions, sizes, edgePoints }
}

/** Swimlane: x pelas colunas do elk (RIGHT); y por banda de raia (ator). */
export async function swimlaneLayout(diagram: Diagram): Promise<LayoutResult> {
  const base = await layoutDiagram(diagram, 'RIGHT', 90)
  const sizes = base.sizes
  const lanesDef = [...(diagram.lanes ?? [])].sort((a, b) => a.order - b.order)
  const laneIds = lanesDef.length ? lanesDef.map((l) => l.id) : ['_']

  // altura de cada banda = maior nó da raia + folga (mín 120)
  const bandHeight: Record<string, number> = {}
  for (const id of laneIds) bandHeight[id] = 120
  for (const n of diagram.nodes) {
    const lane = n.lane && bandHeight[n.lane] != null ? n.lane : laneIds[0]!
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
    const lane = n.lane && bandY[n.lane] != null ? n.lane : laneIds[0]!
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

/** Mind map: árvore radial a partir da raiz (nó sem arestas de entrada). */
export function radialLayout(diagram: Diagram): LayoutResult {
  const sizes = sizesOf(diagram)
  const targets = new Set(diagram.edges.map((e) => e.target))
  const root = diagram.nodes.find((n) => !targets.has(n.id)) ?? diagram.nodes[0]
  const positions: LayoutResult['positions'] = {}
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
    positions[id] = { x: Math.cos(mid) * r - s.width / 2, y: Math.sin(mid) * r - s.height / 2 }
    const ch = children[id] ?? []
    let a = a0
    for (const c of ch) {
      const span = ((a1 - a0) * leaves[c]!) / (leaves[id] || 1)
      place(c, depth + 1, a, a + span)
      a += span
    }
  }
  if (root) place(root.id, 0, -Math.PI, Math.PI)

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
