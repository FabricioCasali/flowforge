import { BaseEdge, type EdgeProps } from '@xyflow/react'

const BRANCH = ['--br-a', '--br-b', '--br-c', '--br-d']

export interface MindEdgeData {
  points?: { x: number; y: number }[]
  branch: number
  [key: string]: unknown
}

/** Aresta do mind map: bézier suave entre centros, cor do ramo, sem seta. */
export function MindEdge(props: EdgeProps): JSX.Element {
  const { sourceX, sourceY, targetX, targetY } = props
  const data = props.data as MindEdgeData | undefined
  const a = data?.points?.[0] ?? { x: sourceX, y: sourceY }
  const b = data?.points?.[1] ?? { x: targetX, y: targetY }
  const bc = `var(${BRANCH[(data?.branch ?? 0) % BRANCH.length]})`
  const dx = Math.abs(b.x - a.x) * 0.5
  const d = `M ${a.x} ${a.y} C ${a.x + dx} ${a.y} ${b.x - dx} ${b.y} ${b.x} ${b.y}`
  return <BaseEdge path={d} style={{ stroke: bc, strokeWidth: 2, opacity: 0.8 }} />
}
