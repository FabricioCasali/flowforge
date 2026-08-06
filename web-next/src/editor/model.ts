// Helpers do editor: propagação de status (consenso das 2 pontas), veredito e as
// fábricas de nó/aresta (criar, ligar).
import type { Comment, DEdge, DNode, NodeStatus, Side } from '../types.js'
import { KIND_NEW_LABEL } from './shapes.js'

/**
 * ID novo. Mesma fórmula do editor antigo (`app.js:148`): aleatório + tempo.
 * Não precisa ser criptográfico — precisa não colidir dentro de um diagrama e
 * ser curto o suficiente pra caber num `workspace.json` legível à mão.
 */
export function uid(pfx: string): string {
  return pfx + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3)
}

/** Nó recém-nascido, na posição (em coords de CENTRO — é o que o arquivo guarda). */
export function novoNode(kind: string, center: { x: number; y: number }, lane?: string | null): DNode {
  const n: DNode = {
    id: uid('n'),
    label: KIND_NEW_LABEL[kind] ?? 'nova tarefa',
    kind,
    status: 'proposed',
    comments: [],
    description: '',
    x: Math.round(center.x),
    y: Math.round(center.y)
  }
  // entidade já nasce com uma PK — uma entidade sem chave não diz nada
  if (kind === 'entity') n.fields = [{ name: 'id', type: 'int', key: 'pk' }]
  if (lane) n.lane = lane
  return n
}

/** Aresta nova entre dois nós, com os lados de ancoragem que o gesto escolheu. */
export function novaEdge(source: string, target: string, sourceSide?: Side, targetSide?: Side): DEdge {
  const e: DEdge = { id: uid('e'), source, target, label: '', status: 'proposed' }
  if (sourceSide) e.sourceSide = sourceSide
  if (targetSide) e.targetSide = targetSide
  return e
}

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
