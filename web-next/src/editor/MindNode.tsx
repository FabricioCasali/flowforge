import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { DNode, NodeStatus } from '../types.js'
import { LIVE, SC } from './status.js'
import { NodeCard } from './NodeCard.js'

// cor do ramo por índice (herdada pelos filhos via data.branch)
const BRANCH = ['--br-a', '--br-b', '--br-c', '--br-d']

export interface MindNodeData {
  node: DNode
  branch: number
  isRoot: boolean
  busy?: boolean
  onVerdict: (id: string, status: NodeStatus, reason?: string) => void
  onEdit: (id: string, patch: Partial<DNode>) => void
  [key: string]: unknown
}

export function MindNode({ data, selected }: NodeProps): JSX.Element {
  const { node, branch, isRoot, onVerdict, onEdit, busy } = data as MindNodeData
  const bc = `var(${BRANCH[branch % BRANCH.length]})`
  const sc = `var(${SC[node.status]})`
  const live = LIVE.has(node.status)

  return (
    <div
      className={'mind' + (isRoot ? ' root' : '') + (live ? ' live' : '') + (selected ? ' sel' : '') + ` st-${node.status}`}
      style={{ ['--bc' as string]: bc, ['--sc' as string]: sc }}
    >
      <Handle type="target" position={Position.Left} className="fh mind-h" />
      <span className="mind-dot" />
      <span className="mind-label">{node.label}</span>
      {selected && <NodeCard node={node} busy={busy} onVerdict={onVerdict} onEdit={onEdit} />}
      <Handle type="source" position={Position.Right} className="fh mind-h" />
    </div>
  )
}
