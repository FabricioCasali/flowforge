import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from '@xyflow/react'
import type { DEdge, NodeStatus } from '../types.js'
import { EDGE_COLOR } from './status.js'
import { EdgeCard } from './EdgeCard.js'

export interface ErEdgeData {
  points?: { x: number; y: number }[]
  status: NodeStatus
  label?: string
  /** Centro do rótulo, já escolhido longe dos nós (`labelPoint`, em layout.ts). */
  labelAt?: { x: number; y: number }
  sourceCard?: string
  targetCard?: string
  edge?: DEdge
  busy?: boolean
  onEdgeEdit?: (id: string, patch: Partial<DEdge>) => void
  onEdgeDelete?: (id: string) => void
  [key: string]: unknown
}

/** Relacionamento ER: polilinha ortogonal + cardinalidade (1/N) nas pontas, sem seta. */
export function ErEdge(props: EdgeProps): JSX.Element {
  const { sourceX, sourceY, targetX, targetY, selected } = props
  const data = props.data as ErEdgeData | undefined
  const pts =
    data?.points && data.points.length >= 2
      ? data.points
      : [
          { x: sourceX, y: sourceY },
          { x: targetX, y: targetY }
        ]
  const sc = EDGE_COLOR[data?.status ?? 'proposed']
  const d = pts.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ')
  const a = pts[0]!
  const b = pts[pts.length - 1]!

  return (
    <>
      <BaseEdge path={d} style={{ stroke: selected ? 'var(--accent)' : sc, strokeWidth: selected ? 2.6 : 1.6 }} />
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
        <text
          className="orth-label"
          x={data.labelAt?.x ?? (a.x + b.x) / 2}
          y={data.labelAt?.y ?? (a.y + b.y) / 2 - 10}
          textAnchor="middle"
          dominantBaseline="central"
        >
          {data.label}
        </text>
      )}
      {selected && data?.edge && data.onEdgeEdit && data.onEdgeDelete && (
        <EdgeLabelRenderer>
          <div
            className="ecard-anchor"
            style={{ transform: `translate(-50%, -50%) translate(${(a.x + b.x) / 2}px, ${(a.y + b.y) / 2}px)` }}
          >
            <EdgeCard edge={data.edge} er busy={data.busy} onEdit={data.onEdgeEdit} onDelete={data.onEdgeDelete} />
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
