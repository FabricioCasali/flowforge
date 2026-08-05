import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { DNode, NodeStatus } from '../types.js'
import { LIVE, SC, STLBL, VerdictPanel } from './VerdictPanel.js'

const PILL = new Set(['start', 'end', 'event-start', 'event-end', 'event-intermediate'])
const DIAMOND = new Set(['decision', 'gateway-exclusive', 'gateway-parallel'])

function shapeOf(kind: string): 'pill' | 'diamond' | 'rect' {
  if (PILL.has(kind)) return 'pill'
  if (DIAMOND.has(kind)) return 'diamond'
  return 'rect'
}

export interface FlowNodeData {
  node: DNode
  onVerdict: (id: string, status: NodeStatus, reason?: string) => void
  [key: string]: unknown
}

export function FlowNode({ data, selected }: NodeProps): JSX.Element {
  const { node, onVerdict } = data as FlowNodeData
  const sc = `var(${SC[node.status]})`
  const live = LIVE.has(node.status)
  const shape = shapeOf(node.kind)

  return (
    <div
      className={`fnode shape-${shape}` + (live ? ' live' : '') + (selected ? ' sel' : '') + ` st-${node.status}`}
      style={{ ['--sc' as string]: sc }}
    >
      <Handle type="target" position={Position.Top} className="fh" />

      {shape === 'diamond' && <span className="fnode-di" aria-hidden />}

      {shape === 'rect' ? (
        <>
          <div className="nn-head">
            <span className="dot" />
            <span className="nn-label">{node.label}</span>
            <span className="badge neon-mono">{STLBL[node.status]}</span>
          </div>
          {node.description && <div className="nn-body neon-mono">{node.description}</div>}
        </>
      ) : (
        <div className="nn-center">
          <span className="dot" />
          <span className="nn-label">{node.label}</span>
        </div>
      )}

      {selected && <VerdictPanel node={node} onVerdict={onVerdict} />}

      <Handle type="source" position={Position.Bottom} className="fh" />
    </div>
  )
}
