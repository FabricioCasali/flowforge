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
 * não merece o realce de "o agente mexeu aqui".
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

const KINDS_INICIO = new Set(['start', 'event-start'])
const KINDS_FIM = new Set(['end', 'event-end'])

/**
 * Por onde o fluxo começa: os `start`; sem eles, quem não tem seta entrando (e
 * tem saindo — nó totalmente solto não é começo de nada). Ordem: a do arquivo.
 */
export function iniciosDoFluxo(nodes: DNode[], edges: DEdge[], ehNota: (n: DNode) => boolean): DNode[] {
  const etapas = nodes.filter((n) => !ehNota(n))
  const declarados = etapas.filter((n) => KINDS_INICIO.has(n.kind))
  if (declarados.length) return declarados
  const comEntrada = new Set(edges.map((e) => e.target))
  const comSaida = new Set(edges.map((e) => e.source))
  return etapas.filter((n) => !comEntrada.has(n.id) && comSaida.has(n.id))
}

/** Alcançáveis a partir de `de`, seguindo `adj`. Em LARGURA, na ordem das setas. */
function percorrer(de: string[], adj: Map<string, string[]>): string[] {
  const visto = new Set(de)
  const fila = [...de]
  for (let i = 0; i < fila.length; i++) {
    for (const prox of adj.get(fila[i]!) ?? []) {
      if (visto.has(prox)) continue
      visto.add(prox)
      fila.push(prox)
    }
  }
  return fila
}

/**
 * Ordem de leitura do MODO GUIADO: a do FLUXO — começa no início e segue as setas.
 *
 * Era por posição (`y`, depois `x`), com o argumento de que 3 dos 11 diagramas
 * têm ciclo e 4 têm mais de uma raiz. Os dois casos têm resposta sem abrir mão do
 * fluxo: o percurso marca quem já visitou (ciclo não trava) e aceita vários
 * inícios. E a posição falhava justamente onde mais importa — bastava um arranjo
 * automático, ou um desenho em circuito (ida descendo, volta subindo), pro guia
 * começar pelo meio da história e intercalar ida com volta.
 *
 * É em LARGURA de propósito: o desvio de uma decisão ("não pegou a carteira →
 * volta e busca") aparece logo depois dela, e não no fim, depois do caminho
 * principal inteiro — que é o que a profundidade faria.
 *
 * Quem o percurso não alcança entra depois, por posição (é melhor aparecer fora
 * de ordem do que sumir do guia), e as anotações por último.
 */
export function ordenarParaGuia(nodes: DNode[], ehNota: (n: DNode) => boolean, edges: DEdge[] = []): DNode[] {
  const y = (n: DNode): number => (typeof n.y === 'number' ? n.y : Number.MAX_SAFE_INTEGER)
  const x = (n: DNode): number => (typeof n.x === 'number' ? n.x : Number.MAX_SAFE_INTEGER)
  const ord = (a: DNode, b: DNode): number => y(a) - y(b) || x(a) - x(b)

  const porId = new Map(nodes.map((n) => [n.id, n]))
  const saidas = new Map<string, string[]>()
  for (const e of edges) saidas.set(e.source, [...(saidas.get(e.source) ?? []), e.target])

  const inicios = iniciosDoFluxo(nodes, edges, ehNota).map((n) => n.id)
  const percurso = percorrer(inicios, saidas)
    .map((id) => porId.get(id))
    .filter((n): n is DNode => !!n && !ehNota(n))
  const noPercurso = new Set(percurso.map((n) => n.id))

  const soltos = nodes.filter((n) => !ehNota(n) && !noPercurso.has(n.id)).sort(ord)
  return [...percurso, ...soltos, ...nodes.filter(ehNota).sort(ord)]
}

/**
 * O que FALTA pra isto ser um processo legível. Vai pro HUD, em voz alta: um
 * fluxograma sem início não diz por onde ler, e sem fim não diz quando acabou.
 * O agente tem a mesma regra escrita na skill — isto é o lado de cá conferindo.
 */
export interface AvisoDeFluxo {
  texto: string
  /** Rótulos dos nós envolvidos, pro `title` do aviso. */
  quem: string[]
}

export function avisosDoFluxo(nodes: DNode[], edges: DEdge[], ehNota: (n: DNode) => boolean): AvisoDeFluxo[] {
  const etapas = nodes.filter((n) => !ehNota(n))
  if (etapas.length < 2) return []
  const avisos: AvisoDeFluxo[] = []
  const inicios = etapas.filter((n) => KINDS_INICIO.has(n.kind))
  const fins = etapas.filter((n) => KINDS_FIM.has(n.kind))
  if (!inicios.length) avisos.push({ texto: 'sem início', quem: [] })
  if (!fins.length) avisos.push({ texto: 'sem fim', quem: [] })

  const saidas = new Map<string, string[]>()
  const entradas = new Map<string, string[]>()
  for (const e of edges) {
    saidas.set(e.source, [...(saidas.get(e.source) ?? []), e.target])
    entradas.set(e.target, [...(entradas.get(e.target) ?? []), e.source])
  }
  if (inicios.length) {
    const alcanca = new Set(percorrer(inicios.map((n) => n.id), saidas))
    const fora = etapas.filter((n) => !alcanca.has(n.id))
    if (fora.length) avisos.push({ texto: `${fora.length} fora do percurso`, quem: fora.map((n) => n.label) })
  }
  if (fins.length) {
    const chega = new Set(percorrer(fins.map((n) => n.id), entradas))
    const becos = etapas.filter((n) => !chega.has(n.id))
    if (becos.length) avisos.push({ texto: `${becos.length} sem caminho até o fim`, quem: becos.map((n) => n.label) })
  }
  return avisos
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
