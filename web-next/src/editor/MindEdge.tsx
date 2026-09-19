import { BaseEdge, type EdgeProps } from '@xyflow/react'

const BRANCH = ['--br-a', '--br-b', '--br-c', '--br-d']

export interface MindEdgeData {
  points?: { x: number; y: number }[]
  branch: number
  [key: string]: unknown
}

/**
 * Aresta do mind map: bézier suave da lateral do pai à do filho (`mindEdgePoints`),
 * cor do ramo, sem seta.
 *
 * Lê o PRIMEIRO e o ÚLTIMO ponto, nunca `points[1]`: se um dia chegar uma rota com
 * quebras, a curva ainda liga os dois nós em vez de parar na primeira quebra.
 */
export function MindEdge(props: EdgeProps): JSX.Element {
  const { sourceX, sourceY, targetX, targetY } = props
  const data = props.data as MindEdgeData | undefined
  const pts = data?.points
  const a = pts?.[0] ?? { x: sourceX, y: sourceY }
  const b = (pts && pts.length >= 2 ? pts[pts.length - 1] : undefined) ?? { x: targetX, y: targetY }
  const bc = `var(${BRANCH[(data?.branch ?? 0) % BRANCH.length]})`
  // tangente horizontal NO SENTIDO do filho: com `abs`, o ramo da esquerda saía
  // pra direita e voltava num laço
  const dx = (b.x >= a.x ? 1 : -1) * Math.max(Math.abs(b.x - a.x) * 0.5, 28)
  const d = `M ${a.x} ${a.y} C ${a.x + dx} ${a.y} ${b.x - dx} ${b.y} ${b.x} ${b.y}`
  return <BaseEdge path={d} style={{ stroke: bc, strokeWidth: 2, opacity: 0.8 }} />
}
