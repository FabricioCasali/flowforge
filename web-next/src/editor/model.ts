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
 * Propaga status nó→aresta NAS ARESTAS DOS NÓS QUE MUDARAM.
 *
 * A regra do consenso é a de sempre: a aresta herda o status só se as duas
 * pontas têm o MESMO status não-neutro; senão volta pra 'proposed'.
 *
 * O RAIO é que importa, e é decisão do Fabricio (06/08/2026): a seta tem status
 * PRÓPRIO e editável (o editor antigo sempre teve — `#edge-status`), então a
 * propagação só pode tocar nas arestas do nó que acabou de receber veredito,
 * como o `propagateFrom` do antigo (`app.js:831`). Recalcular o diagrama inteiro
 * a cada clique apagaria marcação de seta do outro lado do desenho — e não é
 * hipótese: 34 das 143 arestas dos diagramas reais têm status que a regra NÃO
 * derivaria das pontas. Elas mudariam de cor todas juntas no primeiro veredito.
 */
export function propagateFrom(nodes: DNode[], edges: DEdge[], changed: Iterable<string>): DEdge[] {
  const alvo = new Set(changed)
  if (!alvo.size) return edges
  const byId = new Map(nodes.map((n) => [n.id, n.status]))
  return edges.map((e) => {
    if (!alvo.has(e.source) && !alvo.has(e.target)) return e
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
