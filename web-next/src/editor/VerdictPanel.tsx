import { useState } from 'react'
import type { Comment, DNode, NodeStatus } from '../types.js'

export const SC: Record<NodeStatus, string> = {
  proposed: '--s-proposed',
  approved: '--s-approved',
  questioned: '--s-questioned',
  rejected: '--s-rejected'
}
export const STLBL: Record<NodeStatus, string> = {
  proposed: 'proposto',
  approved: 'aprovado',
  questioned: 'questionado',
  rejected: 'reprovado'
}
export const LIVE = new Set<NodeStatus>(['approved', 'questioned'])

/** Painel de ações efêmero — nasce ancorado ao nó selecionado (co-decisão). */
export function VerdictPanel({
  node,
  onVerdict
}: {
  node: DNode
  onVerdict: (id: string, status: NodeStatus, reason?: string) => void
}): JSX.Element {
  const [reasonFor, setReasonFor] = useState<NodeStatus | null>(null)
  const [reason, setReason] = useState('')

  const verdict = (status: NodeStatus): void => {
    if (status === 'rejected' || status === 'questioned') {
      setReasonFor(status)
      setReason('')
    } else {
      onVerdict(node.id, status)
    }
  }
  const confirmReason = (): void => {
    if (reasonFor && reason.trim()) onVerdict(node.id, reasonFor, reason.trim())
    setReasonFor(null)
    setReason('')
  }

  return (
    <div className="fpanel nodrag nowheel" onClick={(e) => e.stopPropagation()}>
      <div className="fpanel-caret" />
      <div className="fpanel-head">
        <span className="fpanel-kind neon-mono">{node.kind}</span>
        <span className="fpanel-badge neon-mono">{STLBL[node.status]}</span>
      </div>
      {node.description && <div className="fpanel-desc">{node.description}</div>}

      {(node.comments?.length ?? 0) > 0 && (
        <div className="fpanel-thread">
          {node.comments.map((c: Comment, i) => (
            <div key={i} className={`fpanel-cmt ${c.author} ${c.kind}`}>
              <span className="who neon-mono">{c.author}</span>
              {c.text}
            </div>
          ))}
        </div>
      )}

      <div className="fpanel-verdict">
        <button className="v ok" title="aprovar" onClick={() => verdict('approved')}>
          ✓
        </button>
        <button className="v qu" title="questionar" onClick={() => verdict('questioned')}>
          ?
        </button>
        <button className="v no" title="reprovar" onClick={() => verdict('rejected')}>
          ✗
        </button>
        <button className="v rs" title="voltar a proposto" onClick={() => verdict('proposed')}>
          ○
        </button>
      </div>

      {reasonFor && (
        <div className="fpanel-reason">
          <input
            autoFocus
            placeholder={reasonFor === 'rejected' ? 'motivo da reprovação…' : 'o que você questiona?'}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirmReason()
              if (e.key === 'Escape') {
                setReasonFor(null)
                setReason('')
              }
            }}
          />
          <button onClick={confirmReason}>ok</button>
        </div>
      )}
    </div>
  )
}
