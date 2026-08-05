import { BaseEdge, type EdgeProps } from '@xyflow/react'
import type { NodeStatus } from '../types.js'
import { SC } from './VerdictPanel.js'

export interface ErEdgeData {
  points?: { x: number; y: number }[]
  status: NodeStatus
  label?: string
  sourceCard?: string
  targetCard?: string
  [key: string]: unknown
}

/** Relacionamento ER: polilinha ortogonal + cardinalidade (1/N) nas pontas, sem seta. */
export function ErEdge(props: EdgeProps): JSX.Element {
  const { sourceX, sourceY, targetX, targetY } = props
  const data = props.data as ErEdgeData | undefined
  const pts =
    data?.points && data.points.length >= 2
      ? data.points
      : [
          { x: sourceX, y: sourceY },
          { x: targetX, y: targetY }
        ]
  const sc = `var(${SC[data?.status ?? 'proposed']})`
  const d = pts.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ')
  const a = pts[0]!
  const b = pts[pts.length - 1]!

  return (
    <>
      <BaseEdge path={d} style={{ stroke: sc, strokeWidth: 1.6 }} />
      {data?.sourceCard && (
        <text className="er-card" x={a.x + 12} y={a.y - 6} fill={sc}>
          {data.sourceCard}
        </text>
      )}
      {data?.targetCard && (
        <text className="er-card" x={b.x - 12} y={b.y - 6} fill={sc}>
          {data.targetCard}
        </text>
      )}
      {data?.label && (
        <text className="orth-label" x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 5} textAnchor="middle">
          {data.label}
        </text>
      )}
    </>
  )
}
