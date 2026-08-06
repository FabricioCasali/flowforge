// ============================================================================
// EdgeCard — o card da SETA selecionada. Porte do `#edge-card` do editor antigo
// (`web/index.html:235`): rótulo, status próprio e, na lente ER, cardinalidade.
//
// O status da seta é PRÓPRIO e editável — decisão do Fabricio em 06/08/2026.
// Quem respeita isso é o `propagateFrom` (model.ts), que só recalcula as arestas
// do nó que recebeu veredito. Ver o comentário lá: 34 das 143 arestas dos
// diagramas reais têm status que a regra não derivaria das pontas, e elas
// existem porque a seta pode discordar do consenso.
//
// Mesma regra de escrita do NodeCard: o rótulo commita no blur/Enter, nunca por
// tecla. Status e cardinalidade commitam no clique — não têm "meio da edição".
// ============================================================================

import { useEffect, useState } from 'react'
import type { DEdge, NodeStatus } from '../types.js'
import { STLBL } from './status.js'

const VERDICTS: { s: NodeStatus; ico: string; cls: string; hint: string }[] = [
  { s: 'approved', ico: '✓', cls: 'ok', hint: 'aprovar a seta' },
  { s: 'questioned', ico: '?', cls: 'qu', hint: 'questionar a seta' },
  { s: 'rejected', ico: '✗', cls: 'no', hint: 'reprovar a seta' },
  { s: 'proposed', ico: '○', cls: 'rs', hint: 'não marcar' }
]

export interface EdgeCardProps {
  edge: DEdge
  /** Lente ER: liga os selects de cardinalidade. */
  er?: boolean
  busy?: boolean
  onEdit: (id: string, patch: Partial<DEdge>) => void
  onDelete: (id: string) => void
}

export function EdgeCard({ edge, er = false, busy = false, onEdit, onDelete }: EdgeCardProps): JSX.Element {
  const [label, setLabel] = useState(edge.label ?? '')
  useEffect(() => {
    setLabel(edge.label ?? '')
  }, [edge.id])

  const commitLabel = (): void => {
    if (label !== (edge.label ?? '')) onEdit(edge.id, { label })
  }

  return (
    <div className="ecard nodrag nowheel" onClick={(e) => e.stopPropagation()}>
      <div className="ecard-head neon-mono">
        <span>seta</span>
        <span className="ecard-badge">{STLBL[edge.status]}</span>
        <button className="ecard-del" title="excluir a seta (Del)" disabled={busy} onClick={() => onDelete(edge.id)}>
          ✕
        </button>
      </div>

      <input
        className="ecard-input"
        value={label}
        disabled={busy}
        placeholder="ex: sim / não / se falhar…"
        onChange={(e) => setLabel(e.target.value)}
        onBlur={commitLabel}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') setLabel(edge.label ?? '')
        }}
      />

      {er && (
        <div className="ecard-card-row neon-mono">
          <select
            value={edge.sourceCard ?? ''}
            disabled={busy}
            title="cardinalidade na origem"
            onChange={(e) => onEdit(edge.id, { sourceCard: (e.target.value || undefined) as DEdge['sourceCard'] })}
          >
            <option value="">—</option>
            <option value="1">1</option>
            <option value="N">N</option>
          </select>
          <span className="sep">↔</span>
          <select
            value={edge.targetCard ?? ''}
            disabled={busy}
            title="cardinalidade no destino"
            onChange={(e) => onEdit(edge.id, { targetCard: (e.target.value || undefined) as DEdge['targetCard'] })}
          >
            <option value="">—</option>
            <option value="1">1</option>
            <option value="N">N</option>
          </select>
        </div>
      )}

      <div className="fpanel-verdict">
        {VERDICTS.map(({ s, ico, cls, hint }) => (
          <button
            key={s}
            className={'v ' + cls + (edge.status === s ? ' on' : '')}
            title={hint}
            disabled={busy}
            onClick={() => onEdit(edge.id, { status: s })}
          >
            {ico}
          </button>
        ))}
      </div>
    </div>
  )
}
