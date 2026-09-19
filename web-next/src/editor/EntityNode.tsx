import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { DNode, NodeStatus } from '../types.js'
import { LIVE, SC } from './status.js'
import { NodeCard } from './NodeCard.js'
import { MarcaViva } from './EtapaViva.js'
import type { EtapaViva } from './model.js'
import { useCardAbertoDe } from './useCardAberto.js'

export interface EntityNodeData {
  node: DNode
  busy?: boolean
  /** Tarefa do agente apontando esta entidade (issue #8). */
  viva?: EtapaViva
  onCardPersist: (id: string) => void
  onVerdict: (id: string, status: NodeStatus, reason?: string) => void
  onEdit: (id: string, patch: Partial<DNode>) => void
  [key: string]: unknown
}

export function EntityNode({ data, selected }: NodeProps): JSX.Element {
  const { node, onVerdict, onEdit, onCardPersist, busy, viva } = data as EntityNodeData
  const cardOpen = useCardAbertoDe(node.id)
  const sc = `var(${SC[node.status]})`
  const live = LIVE.has(node.status)

  return (
    <div
      className={'ent' + (live ? ' live' : '') + (selected ? ' sel' : '') + ` st-${node.status}`}
      style={{ ['--sc' as string]: sc }}
    >
      <Handle type="target" position={Position.Left} className="fh" />
      <div className="ent-head neon-mono">
        <span className="dot" />
        {node.label}
        {/* aqui dentro, e não no canto de fora como nos outros nós: a entidade
            tem `overflow: hidden` (é o que arredonda a lista de campos) e comeria
            uma marca pendurada na borda */}
        {viva && <MarcaViva viva={viva} />}
      </div>
      <div className="ent-fields">
        {(node.fields ?? []).map((f, i) => (
          <div key={i} className="ent-row neon-mono">
            <span className={'ent-key ' + (f.key ?? '')}>{f.key ? f.key.toUpperCase() : ''}</span>
            <span className="ent-name">{f.name}</span>
            <span className="ent-type">{f.type}</span>
          </div>
        ))}
      </div>
      {cardOpen && <NodeCard node={node} busy={busy} onVerdict={onVerdict} onEdit={onEdit} onPersist={onCardPersist} />}
      <Handle type="source" position={Position.Right} className="fh" />
    </div>
  )
}
