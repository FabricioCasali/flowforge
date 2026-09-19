import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from '@xyflow/react'
import type { DEdge, NodeStatus, Pt } from '../types.js'
import { EDGE_COLOR } from './status.js'
import { EdgeCard } from './EdgeCard.js'
import { BendHandles } from './BendHandles.js'

export interface OrthEdgeData {
  points?: { x: number; y: number }[]
  status: NodeStatus
  label?: string
  /** Centro do rótulo, já escolhido longe dos nós (`labelPoint`, em layout.ts). */
  labelAt?: Pt
  /** A aresta do modelo + os callbacks — só chegam quando a lente edita. */
  edge?: DEdge
  busy?: boolean
  onEdgeEdit?: (id: string, patch: Partial<DEdge>) => void
  onEdgeDelete?: (id: string) => void
  onEdgeWaypoints?: (id: string, wps: Pt[]) => void
  [key: string]: unknown
}

/** Aresta ortogonal: desenha a polilinha roteada pelo elk (data.points) com
 *  cantos arredondados. Se faltar rota, cai num L simples source→target. */
export function OrthEdge(props: EdgeProps): JSX.Element {
  const { sourceX, sourceY, targetX, targetY, selected } = props
  const data = props.data as OrthEdgeData | undefined
  const pts = data?.points && data.points.length >= 2 ? data.points : [
    { x: sourceX, y: sourceY },
    { x: targetX, y: targetY }
  ]
  const status = data?.status ?? 'proposed'
  const path = roundedPath(pts, 8)
  const mid = pts[Math.floor(pts.length / 2)]

  const cor = selected ? 'var(--accent)' : EDGE_COLOR[status]
  const rotulo = data?.labelAt ?? (mid ? { x: mid.x, y: mid.y - 10 } : null)

  return (
    <>
      <BaseEdge
        path={path}
        style={{
          stroke: cor,
          strokeWidth: selected ? 2.6 : status === 'proposed' ? 1.4 : 1.9
        }}
      />
      <Ponta pts={pts} cor={cor} />
      {/* trilho invisível e gordo: acertar uma linha de 1.4px com o mouse é
          perícia, e selecionar a seta é o gesto que abre o card dela */}
      <path className="orth-hit" d={path} />
      {data?.label && rotulo && (
        <text className="orth-label" x={rotulo.x} y={rotulo.y} textAnchor="middle" dominantBaseline="central">
          {data.label}
        </text>
      )}
      {selected && data?.edge && data.onEdgeWaypoints && (
        <BendHandles edge={data.edge} pts={pts} busy={data.busy} onWaypoints={data.onEdgeWaypoints} />
      )}
      {selected && data?.edge && data.onEdgeEdit && data.onEdgeDelete && mid && (
        <EdgeLabelRenderer>
          <div className="ecard-anchor" style={{ transform: `translate(-50%, -50%) translate(${mid.x}px, ${mid.y}px)` }}>
            <EdgeCard
              edge={data.edge}
              busy={data.busy}
              onEdit={data.onEdgeEdit}
              onDelete={data.onEdgeDelete}
            />
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

/**
 * A PONTA DA SETA, desenhada no traço em vez de vir de um `<marker>`.
 *
 * O marker referenciado por `url(#id)` de outro SVG é o caminho usual, mas falha
 * em silêncio quando a referência não resolve — e "falha em silêncio" numa seta
 * significa um diagrama de fluxo sem direção nenhuma, que foi o que o usuário
 * viu. Desenhando aqui, a ponta acompanha a cor da seleção e o tamanho não
 * depende do `strokeWidth`.
 *
 * O ângulo vem do ÚLTIMO trecho, então a ponta encosta no nó no mesmo sentido em
 * que a linha chega — inclusive quando o traço desviou de um obstáculo.
 */
function Ponta({ pts, cor }: { pts: { x: number; y: number }[]; cor: string }): JSX.Element | null {
  if (pts.length < 2) return null
  const fim = pts[pts.length - 1]!
  let antes = pts[pts.length - 2]!
  // trecho final degenerado não define direção; procura o último que define
  for (let i = pts.length - 2; i >= 0; i--) {
    const p = pts[i]!
    if (Math.abs(p.x - fim.x) + Math.abs(p.y - fim.y) > 0.5) {
      antes = p
      break
    }
  }
  const graus = (Math.atan2(fim.y - antes.y, fim.x - antes.x) * 180) / Math.PI
  return (
    <path
      className="orth-ponta"
      d="M 0 0 L -9.5 -4.6 L -9.5 4.6 Z"
      fill={cor}
      transform={`translate(${fim.x} ${fim.y}) rotate(${graus})`}
    />
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
