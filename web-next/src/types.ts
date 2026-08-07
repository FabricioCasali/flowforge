// ============================================================================
// types.ts — A BARREIRA (lei 3 do CLAUDE.md do FlowForge).
//
// Cópia LOCAL e AUTOSSUFICIENTE do modelo do editor. Nada aqui importa de fora
// do repo: **não existe** `@neon/shared` no FlowForge. O código veio do NEON
// (`app/packages/shared/src/model.ts`), mas os dois repos têm liberdade de
// divergir — o FlowForge é a bancada viva, e o aprendizado volta pro Context
// Builder depois, como implementação nova.
//
// O que NÃO entra aqui: nada de runtime do NEON (RuntimeNode, Profile,
// CravePlan, OpenSessionInput, TaskPhase, HostMsg, RunPlanInput, CONTEXT_MAX…).
// Isso é orquestração de agentes — o FlowForge é um editor de diagramas.
//
// Modelo ou campo novo entra AQUI antes de qualquer componente ou do servidor
// consumir.
// ============================================================================

// ---------- IDs ----------
export type NodeId = string

// ---------- Co-decisão ----------
/** Status de CO-DECISÃO (design-time) — o eixo Proposta→cravar. */
export type NodeStatus = 'proposed' | 'approved' | 'questioned' | 'rejected'

/** Lado da porta onde a aresta ancora (N/E/S/O). */
export type Side = 'top' | 'right' | 'bottom' | 'left'

// ---------- Modelo do diagrama (arquivo-como-verdade) ----------
export type DiagramType = 'flowchart' | 'bpm' | 'mindmap' | 'swimlane' | 'er'

export interface Comment {
  author: 'user' | 'claude'
  kind: 'note' | 'question' | 'reject'
  text: string
  ts?: number
}

export interface ErField {
  name: string
  type: string
  key?: 'pk' | 'fk' | null
}

export interface DNode {
  id: NodeId
  label: string
  kind: string
  status: NodeStatus
  /**
   * O EXEMPLO REAL: o que acontece na prática nesta etapa — arquivo, serviço,
   * tabela, o passo concreto. Aparece no card do nó, junto do veredito.
   */
  description?: string
  /**
   * A TEORIA: o conceito por trás da etapa, para quem está entendendo o fluxo
   * pela primeira vez. Aparece no painel guiado, não no card.
   *
   * Campo separado de propósito (decisão do Fabricio, 06/08/2026): são duas
   * frentes distintas, não dois recortes do mesmo texto. Quem lê para aprender
   * quer o conceito; quem lê para implementar quer o exemplo.
   */
  concept?: string
  comments: Comment[]
  x?: number
  y?: number
  fields?: ErField[] // ER-only
  lane?: string // swimlane-only
}

export interface Pt {
  x: number
  y: number
}

export interface DEdge {
  id: string
  source: NodeId
  target: NodeId
  label: string
  status: NodeStatus
  sourceSide?: Side
  targetSide?: Side
  sourceCard?: '1' | 'N' // cardinalidade ER
  targetCard?: '1' | 'N'
  /**
   * Quebras MANUAIS, em coordenadas do canvas. Quem tem waypoints manda: o
   * roteador automático não é consultado. Mesmo formato do editor antigo, que
   * grava `routing:'segments'` junto — decisão do Fabricio em 06/08/2026, pela
   * paridade com o `web/`.
   */
  waypoints?: Pt[]
  /** `segments` = respeita os waypoints; ausente = deixa o roteador decidir. */
  routing?: 'segments' | 'bezier'
}

export interface Lane {
  id: string
  label: string
  order: number
}

export interface Diagram {
  type: DiagramType
  title: string
  rev: number
  updatedBy: 'user' | 'claude'
  lanes: Lane[]
  nodes: DNode[]
  edges: DEdge[]
}

// ---------- Conversa da sessão (thread.json) ----------
export interface ThreadMessage {
  author: 'user' | 'claude' | 'system'
  text: string
  ts?: number
}

export interface Thread {
  messages: ThreadMessage[]
}

// ---------- Workspace multi-lente: o arquivo-verdade do editor ----------
// As 6 lentes leem 5 modelos: process (Fluxograma+Swimlane), state, er, mind e
// seq. `seq` é um modelo DEDICADO (participantes+mensagens), NÃO um Diagram.
export type ModelKey = 'process' | 'state' | 'er' | 'mind' | 'seq'

export interface SeqMessage {
  from: string
  to: string
  label: string
  kind?: 'call' | 'return' | 'async'
}

export interface SeqModel {
  participants: { id: string; label: string }[]
  messages: SeqMessage[]
}

export interface Workspace {
  process: Diagram
  state: Diagram
  er: Diagram
  mind: Diagram
  seq: SeqModel
  rev: number
  updatedBy: 'user' | 'claude'
}

// ---------- Fábricas ----------
export function emptyDiagram(title = 'Novo diagrama', type: DiagramType = 'flowchart'): Diagram {
  return { type, title, rev: 0, updatedBy: 'user', lanes: [], nodes: [], edges: [] }
}

export function emptySeq(): SeqModel {
  return { participants: [], messages: [] }
}

export function emptyWorkspace(): Workspace {
  return {
    process: emptyDiagram('Fluxo', 'flowchart'),
    state: emptyDiagram('Estados', 'flowchart'),
    er: emptyDiagram('Entidades', 'er'),
    mind: emptyDiagram('Mapa mental', 'mindmap'),
    seq: emptySeq(),
    rev: 0,
    updatedBy: 'user'
  }
}

// ---------- Normalização do que chega do servidor (WS 'state') ----------
// Espelho do `normalizeWorkspace` de `server/state.js`: garante os 5 modelos +
// rev + updatedBy SEM PODAR nada. Campo desconhecido (do Claude, de uma versão
// futura do formato) sobrevive intacto — quem poda perde dado do usuário.
//
// Diferente de `coerceDiagram`: aquele DESCONFIA da origem (zera rev, dropa nó
// sem id, devolve null se sobrar vazio) e serve pra proposta crua; este só
// completa o que falta pra o editor conseguir renderizar.

function normalizeModel(raw: unknown, title: string, type: DiagramType): Diagram {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyDiagram(title, type)
  const d = { ...(raw as Record<string, unknown>) } as unknown as Diagram
  if (typeof d.type !== 'string' || !d.type) d.type = type
  if (typeof d.title !== 'string' || !d.title) d.title = title
  if (typeof d.rev !== 'number') d.rev = 0
  if (d.updatedBy !== 'user' && d.updatedBy !== 'claude') d.updatedBy = 'user'
  if (!Array.isArray(d.lanes)) d.lanes = []
  if (!Array.isArray(d.nodes)) d.nodes = []
  if (!Array.isArray(d.edges)) d.edges = []
  return d
}

function normalizeSeqModel(raw: unknown): SeqModel {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptySeq()
  const s = { ...(raw as Record<string, unknown>) } as unknown as SeqModel
  if (!Array.isArray(s.participants)) s.participants = []
  if (!Array.isArray(s.messages)) s.messages = []
  return s
}

/** Completa um workspace cru (vindo do WS/disco) para um Workspace renderizável. */
export function normalizeWorkspace(raw: unknown): Workspace {
  const base: Record<string, unknown> =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const t = rawTitle(base.process) ?? rawTitle(base.state) ?? rawTitle(base.er) ?? rawTitle(base.mind) ?? 'Novo diagrama'
  return {
    ...base,
    process: normalizeModel(base.process, t, 'flowchart'),
    state: normalizeModel(base.state, t, 'flowchart'),
    er: normalizeModel(base.er, t, 'er'),
    mind: normalizeModel(base.mind, t, 'mindmap'),
    seq: normalizeSeqModel(base.seq),
    rev: typeof base.rev === 'number' ? base.rev : 0,
    updatedBy: base.updatedBy === 'claude' ? 'claude' : 'user'
  }
}

function rawTitle(m: unknown): string | null {
  if (!m || typeof m !== 'object') return null
  const t = (m as Record<string, unknown>).title
  return typeof t === 'string' && t ? t : null
}

/**
 * Título da SESSÃO. O workspace não tem campo `title` próprio (o contrato são os
 * 5 modelos + rev + updatedBy) — o título mora nos modelos, e um workspace é UM
 * assunto visto por 6 lentes. Mesma ordem do `workspaceTitle` do servidor.
 */
export function workspaceTitle(ws: Workspace): string {
  return ws.process.title || ws.state.title || ws.er.title || ws.mind.title || 'Novo diagrama'
}

// ---------- Co-decisão: propagação de status nó→aresta ----------
/**
 * A aresta herda o status SÓ se as duas pontas têm o MESMO status não-neutro;
 * senão volta pra 'proposed'.
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

// ---------- Validação/coerção de input não-tipado (disco / Claude) ----------
const DIAGRAM_TYPES: DiagramType[] = ['flowchart', 'bpm', 'mindmap', 'swimlane', 'er']
const NODE_STATUSES: NodeStatus[] = ['proposed', 'approved', 'questioned', 'rejected']

function coerceStatus(s: unknown): NodeStatus {
  return NODE_STATUSES.includes(s as NodeStatus) ? (s as NodeStatus) : 'proposed'
}

/**
 * Coage um Diagram cru (arquivo em disco ou proposta do Claude) para um Diagram
 * VÁLIDO. Nunca confia na origem: status inválido → 'proposed'; arestas
 * penduradas → dropadas; nós sem `id` → descartados. Sem nenhum nó válido →
 * `null` (o chamador descarta).
 */
export function coerceDiagram(raw: unknown): Diagram | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>

  const nodes: DNode[] = []
  const seen = new Set<string>()
  for (const rn of Array.isArray(r.nodes) ? r.nodes : []) {
    if (!rn || typeof rn !== 'object') continue
    const n = rn as Record<string, unknown>
    const id = typeof n.id === 'string' ? n.id.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    const node: DNode = {
      id,
      label: typeof n.label === 'string' && n.label ? n.label : id,
      kind: typeof n.kind === 'string' && n.kind ? n.kind : 'task',
      status: coerceStatus(n.status),
      comments: Array.isArray(n.comments) ? (n.comments as Comment[]) : []
    }
    if (typeof n.description === 'string') node.description = n.description
    if (typeof n.concept === 'string') node.concept = n.concept
    if (typeof n.x === 'number') node.x = n.x
    if (typeof n.y === 'number') node.y = n.y
    if (typeof n.lane === 'string') node.lane = n.lane
    if (Array.isArray(n.fields)) node.fields = n.fields as ErField[]
    nodes.push(node)
  }
  if (!nodes.length) return null

  const ids = new Set(nodes.map((n) => n.id))
  const edges: DEdge[] = []
  ;(Array.isArray(r.edges) ? r.edges : []).forEach((re, i) => {
    if (!re || typeof re !== 'object') return
    const e = re as Record<string, unknown>
    const source = typeof e.source === 'string' ? e.source : ''
    const target = typeof e.target === 'string' ? e.target : ''
    if (!ids.has(source) || !ids.has(target)) return // dropa aresta pendurada
    const edge: DEdge = {
      id: typeof e.id === 'string' && e.id ? e.id : `e_${i}`,
      source,
      target,
      label: typeof e.label === 'string' ? e.label : '',
      status: coerceStatus(e.status)
    }
    if (e.sourceSide === 'top' || e.sourceSide === 'right' || e.sourceSide === 'bottom' || e.sourceSide === 'left') edge.sourceSide = e.sourceSide
    if (e.targetSide === 'top' || e.targetSide === 'right' || e.targetSide === 'bottom' || e.targetSide === 'left') edge.targetSide = e.targetSide
    if (e.sourceCard === '1' || e.sourceCard === 'N') edge.sourceCard = e.sourceCard
    if (e.targetCard === '1' || e.targetCard === 'N') edge.targetCard = e.targetCard
    // quebras manuais: só entram se forem pontos numéricos de verdade
    if (Array.isArray(e.waypoints)) {
      const wp = (e.waypoints as unknown[])
        .filter((p): p is Pt => !!p && typeof p === 'object' && Number.isFinite((p as Pt).x) && Number.isFinite((p as Pt).y))
        .map((p) => ({ x: p.x, y: p.y }))
      if (wp.length) edge.waypoints = wp
    }
    if (e.routing === 'segments' || e.routing === 'bezier') edge.routing = e.routing
    edges.push(edge)
  })

  const type = DIAGRAM_TYPES.includes(r.type as DiagramType) ? (r.type as DiagramType) : 'flowchart'
  const lanes = Array.isArray(r.lanes) ? (r.lanes as Lane[]) : []
  return {
    type,
    title: typeof r.title === 'string' && r.title ? r.title : 'Proposta',
    rev: 0,
    updatedBy: 'claude',
    lanes,
    nodes,
    edges: propagateEdges(nodes, edges)
  }
}

/** Coage um modelo de sequência cru. Sem participantes → null. */
export function coerceSeq(raw: unknown): SeqModel | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const participants: SeqModel['participants'] = []
  const pseen = new Set<string>()
  for (const rp of Array.isArray(r.participants) ? r.participants : []) {
    if (!rp || typeof rp !== 'object') continue
    const p = rp as Record<string, unknown>
    const id = typeof p.id === 'string' ? p.id.trim() : ''
    if (!id || pseen.has(id)) continue
    pseen.add(id)
    participants.push({ id, label: typeof p.label === 'string' && p.label ? p.label : id })
  }
  if (!participants.length) return null
  const messages: SeqMessage[] = []
  for (const rm of Array.isArray(r.messages) ? r.messages : []) {
    if (!rm || typeof rm !== 'object') continue
    const m = rm as Record<string, unknown>
    const from = typeof m.from === 'string' ? m.from : ''
    const to = typeof m.to === 'string' ? m.to : ''
    if (!pseen.has(from) || !pseen.has(to)) continue // mensagem sem participante → dropada
    const msg: SeqMessage = { from, to, label: typeof m.label === 'string' ? m.label : '' }
    if (m.kind === 'call' || m.kind === 'return' || m.kind === 'async') msg.kind = m.kind
    messages.push(msg)
  }
  return { participants, messages }
}

/**
 * Mescla uma proposta (`next`) preservando os nós já `approved` do usuário
 * (`prev`): approved VENCE (garantia dura — uma re-proposta não apaga uma
 * aprovação). Arestas recalculadas via `propagateEdges`.
 */
export function mergePreservingApproved(prev: Diagram, next: Diagram): Diagram {
  const approved = prev.nodes.filter((n) => n.status === 'approved')
  const byId = new Map<string, DNode>(next.nodes.map((n) => [n.id, n]))
  for (const a of approved) byId.set(a.id, a) // approved sobrescreve/insere
  const nextIds = new Set(next.nodes.map((n) => n.id))
  const merged: DNode[] = next.nodes.map((n) => byId.get(n.id) as DNode)
  for (const a of approved) if (!nextIds.has(a.id)) merged.push(a) // re-adiciona approved dropado
  const ids = new Set(merged.map((n) => n.id))
  const edges = next.edges.filter((e) => ids.has(e.source) && ids.has(e.target))
  return { ...next, nodes: merged, edges: propagateEdges(merged, edges) }
}
