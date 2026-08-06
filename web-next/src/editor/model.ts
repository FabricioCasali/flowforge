// Helpers do editor: propagação de status (consenso das 2 pontas), veredito e as
// fábricas de nó/aresta (criar, ligar).
import type { Comment, DEdge, Diagram, DNode, NodeStatus, Side } from '../types.js'
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

/**
 * Assinatura do CONTEÚDO de um nó — o `nodeKey` do editor antigo (`app.js:506`).
 * A posição fica de fora de propósito: mover um nó não é mudança de conteúdo e
 * não merece o realce de "o Claude mexeu aqui".
 */
export function nodeKey(n: DNode): string {
  return [
    n.status,
    n.label,
    n.comments?.length ?? 0,
    n.kind,
    n.description ?? '',
    JSON.stringify(n.fields ?? []),
    n.lane ?? ''
  ].join('|')
}

/** Ids que nasceram ou mudaram de conteúdo entre dois estados do mesmo modelo. */
export function diffNodes(antes: Diagram | undefined, depois: Diagram | undefined): Set<string> {
  const out = new Set<string>()
  if (!depois) return out
  const mapa = new Map((antes?.nodes ?? []).map((n) => [n.id, nodeKey(n)]))
  for (const n of depois.nodes) {
    const chave = mapa.get(n.id)
    if (chave === undefined || chave !== nodeKey(n)) out.add(n.id)
  }
  return out
}

/**
 * Ordem de leitura do MODO GUIADO (FF-015): por POSIÇÃO — `y`, com `x` de
 * desempate — e as anotações no fim.
 *
 * Não é topológica de propósito. Medido nos 11 diagramas reais: 3 têm ciclo e 4
 * têm mais de uma raiz, então seguir as setas quebraria neles e não saberia onde
 * começar. A posição sempre existe e é do Fabricio (o FF-001 garantiu isso):
 * ele desenha de cima pra baixo, então esta ordem é a leitura que ele já faz.
 *
 * Anotação vai pro fim porque não é etapa de percurso — são 12 nós soltos nos
 * diagramas reais, e intercalá-las cortaria o fio da meada.
 */
export function ordenarParaGuia(nodes: DNode[], ehNota: (n: DNode) => boolean): DNode[] {
  const y = (n: DNode): number => (typeof n.y === 'number' ? n.y : Number.MAX_SAFE_INTEGER)
  const x = (n: DNode): number => (typeof n.x === 'number' ? n.x : Number.MAX_SAFE_INTEGER)
  const ord = (a: DNode, b: DNode): number => y(a) - y(b) || x(a) - x(b)
  return [...nodes.filter((n) => !ehNota(n)).sort(ord), ...nodes.filter(ehNota).sort(ord)]
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
