// ============================================================================
// BendHandles — as quebras arrastáveis da aresta (FF-011, metade manual).
//
// Porte do `bendHandles` da fase 3 do editor antigo. Aparecem só na aresta
// SELECIONADA — um canvas com uma bolinha por dobra de cada aresta seria
// ilegível, e foi assim que o antigo acabou fazendo também.
//
// Dois tipos de alça:
//   · CHEIA, numa quebra que existe — arrasta pra mover, duplo-clique remove
//   · FANTASMA, no meio de um trecho — arrasta pra criar uma quebra ali
//
// A quebra é gravada em coordenadas do CANVAS (as mesmas do `x`/`y` dos nós,
// ancoradas no centro do desenho), então mover o nó não arrasta a quebra junto —
// é isso que o `routing:'segments'` do editor antigo também fazia.
// ============================================================================

import { useCallback, useRef, useState } from 'react'
import { EdgeLabelRenderer, useReactFlow } from '@xyflow/react'
import type { DEdge, Pt } from '../types.js'

export interface BendHandlesProps {
  edge: DEdge
  /** O traço completo, com as duas âncoras nas pontas. */
  pts: Pt[]
  busy?: boolean
  onWaypoints: (id: string, wps: Pt[]) => void
}

export function BendHandles({ edge, pts, busy = false, onWaypoints }: BendHandlesProps): JSX.Element | null {
  const rf = useReactFlow()
  const wps = edge.waypoints ?? []
  // durante o arrasto o ponto vive aqui: mandar patch a cada pixel encheria o
  // arquivo de revs e o canvas de eco
  const [arrastando, setArrastando] = useState<{ idx: number; p: Pt } | null>(null)
  const novoRef = useRef<number | null>(null)

  const posDoEvento = useCallback(
    (e: { clientX: number; clientY: number }): Pt => rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }),
    [rf]
  )

  /** Começa a arrastar. `criarEm` != null quando a alça é fantasma. */
  const inicia = useCallback(
    (evt: React.PointerEvent, idx: number, criarEm: number | null) => {
      if (busy) return
      evt.stopPropagation()
      evt.preventDefault()
      ;(evt.target as Element).setPointerCapture?.(evt.pointerId)
      novoRef.current = criarEm
      setArrastando({ idx, p: posDoEvento(evt) })
    },
    [busy, posDoEvento]
  )

  const move = useCallback(
    (evt: React.PointerEvent) => {
      if (!arrastando) return
      evt.stopPropagation()
      setArrastando({ idx: arrastando.idx, p: posDoEvento(evt) })
    },
    [arrastando, posDoEvento]
  )

  const solta = useCallback(
    (evt: React.PointerEvent) => {
      if (!arrastando) return
      evt.stopPropagation()
      const p = { x: Math.round(arrastando.p.x), y: Math.round(arrastando.p.y) }
      const criarEm = novoRef.current
      const next = [...wps]
      if (criarEm === null) next[arrastando.idx] = p
      else next.splice(criarEm, 0, p)
      novoRef.current = null
      setArrastando(null)
      onWaypoints(edge.id, next)
    },
    [arrastando, wps, edge.id, onWaypoints]
  )

  const remove = useCallback(
    (idx: number) => {
      if (busy) return
      onWaypoints(
        edge.id,
        wps.filter((_, i) => i !== idx)
      )
    },
    [busy, wps, edge.id, onWaypoints]
  )

  if (busy) return null

  // meio de cada trecho — onde nasce uma quebra nova
  const meios: { p: Pt; criarEm: number }[] = []
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!
    const b = pts[i]!
    if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) < 34) continue // trecho curto não comporta alça
    meios.push({ p: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, criarEm: i - 1 })
  }

  return (
    <EdgeLabelRenderer>
      {wps.map((w, i) => {
        const p = arrastando && arrastando.idx === i && novoRef.current === null ? arrastando.p : w
        return (
          <div
            key={'w' + i}
            className="bend"
            title="arraste pra mover · duplo-clique pra remover"
            style={{ transform: `translate(-50%, -50%) translate(${p.x}px, ${p.y}px)` }}
            onPointerDown={(e) => inicia(e, i, null)}
            onPointerMove={move}
            onPointerUp={solta}
            onDoubleClick={(e) => {
              e.stopPropagation()
              remove(i)
            }}
          />
        )
      })}

      {meios.map((m, i) => {
        const ativo = arrastando && novoRef.current === m.criarEm
        const p = ativo ? arrastando.p : m.p
        return (
          <div
            key={'m' + i}
            className={'bend fantasma' + (ativo ? ' on' : '')}
            title="arraste pra criar uma quebra aqui"
            style={{ transform: `translate(-50%, -50%) translate(${p.x}px, ${p.y}px)` }}
            onPointerDown={(e) => inicia(e, m.criarEm, m.criarEm)}
            onPointerMove={move}
            onPointerUp={solta}
          />
        )
      })}
    </EdgeLabelRenderer>
  )
}
