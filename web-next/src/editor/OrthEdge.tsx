import { BaseEdge, type EdgeProps } from '@xyflow/react'
import type { NodeStatus } from '../types.js'

const SC: Record<NodeStatus, string> = {
  proposed: '--s-proposed',
  approved: '--s-approved',
  questioned: '--s-questioned',
  rejected: '--s-rejected'
}

export interface OrthEdgeData {
  points?: { x: number; y: number }[]
  status: NodeStatus
  label?: string
  [key: string]: unknown
}

/** Aresta ortogonal: desenha a polilinha roteada pelo elk (data.points) com
 *  cantos arredondados. Se faltar rota, cai num L simples source→target. */
export function OrthEdge(props: EdgeProps): JSX.Element {
  const { sourceX, sourceY, targetX, targetY, markerEnd } = props
  const data = props.data as OrthEdgeData | undefined
  const pts = data?.points && data.points.length >= 2 ? data.points : [
    { x: sourceX, y: sourceY },
    { x: targetX, y: targetY }
  ]
  const status = data?.status ?? 'proposed'
  const sc = `var(${SC[status]})`
  const path = roundedPath(pts, 8)
  const mid = pts[Math.floor(pts.length / 2)]

  return (
    <>
      <BaseEdge
        path={path}
        markerEnd={markerEnd}
        style={{ stroke: sc, strokeWidth: status === 'proposed' ? 1.4 : 1.9 }}
      />
      {data?.label && mid && (
        <text className="orth-label" x={mid.x} y={mid.y - 5} textAnchor="middle">
          {data.label}
        </text>
      )}
    </>
  )
}

/** Polilinha → path SVG com cantos arredondados (quadráticos). */
function roundedPath(points: { x: number; y: number }[], r: number): string {
  if (points.length < 2) return ''
  let d = `M ${points[0]!.x} ${points[0]!.y}`
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]!
    const prev = points[i - 1]!
    const next = points[i + 1]!
    const v1 = norm(p.x - prev.x, p.y - prev.y)
    const v2 = norm(next.x - p.x, next.y - p.y)
    const a = { x: p.x - v1.x * r, y: p.y - v1.y * r }
    const b = { x: p.x + v2.x * r, y: p.y + v2.y * r }
    d += ` L ${a.x} ${a.y} Q ${p.x} ${p.y} ${b.x} ${b.y}`
  }
  const last = points[points.length - 1]!
  d += ` L ${last.x} ${last.y}`
  return d
}

function norm(dx: number, dy: number): { x: number; y: number } {
  const len = Math.hypot(dx, dy) || 1
  return { x: dx / len, y: dy / len }
}
