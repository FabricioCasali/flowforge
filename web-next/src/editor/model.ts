// Helpers do editor: propagação de status (consenso das 2 pontas) e verdito.
import type { Comment, DEdge, DNode, NodeStatus } from '../types.js'

/**
 * Propaga status nó→aresta: a aresta herda o status SÓ se as duas pontas têm o
 * MESMO status não-neutro; senão volta pra 'proposed'. (Portado do FlowForge.)
 */
export function propagateEdges(nodes: DNode[], edges: DEdge[]): DEdge[] {
  const byId = new Map(nodes.map((n) => [n.id, n.status]))
  return edges.map((e) => {
    const a = byId.get(e.source)
    const b = byId.get(e.target)
    const status: NodeStatus = a && a !== 'proposed' && a === b ? a : 'proposed'
    return e.status === status ? e : { ...e, status }
  })
}

/** Aplica um veredito a um nó (com motivo obrigatório em reject/question → comment). */
export function applyVerdict(node: DNode, status: NodeStatus, reason?: string): DNode {
  const comments: Comment[] = [...(node.comments ?? [])]
  if ((status === 'rejected' || status === 'questioned') && reason) {
    comments.push({
      author: 'user',
      kind: status === 'rejected' ? 'reject' : 'question',
      text: reason,
      ts: Date.now()
    })
  }
  return { ...node, status, comments }
}
