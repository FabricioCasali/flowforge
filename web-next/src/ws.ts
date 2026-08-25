// ============================================================================
// ws.ts — a fala do editor novo com o servidor do FlowForge (AGENTS.md §3).
//
// Protocolo (não mude de um lado só — o outro lado é `server/index.js`):
//   conecta  ws://<host>/ws?session=<slug>
//   recebe   { type:'state',  session, workspace, thread, busy, agentOnline, agentLabel }
//   recebe   { type:'busy',   session, busy }
//   recebe   { type:'agent', online, label }
//   envia    { type:'patch',  session, lens, diagram }   ← lens-aware (lei 4)
//   envia    { type:'analyze', session, note }
//
// O campo `diagram` do patch é o nome do PROTOCOLO, não do tipo: na lente `seq`
// o payload é um SeqModel { participants, messages }. O servidor sabe disso.
//
// O 'state' levava também um `diagram` (do editor antigo, servido em /). Saiu no
// FF-008, junto com o editor.
//
// LEI 7 (trava `busy`): enquanto o agente trabalha, o editor é SÓ LEITURA. A recusa
// mora aqui embaixo, no transporte: `patch()` simplesmente não sai quando busy.
// A UI também desabilita os botões — mas a garantia dura é esta, porque é a
// única que nenhum caminho de código consegue contornar por engano.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  emptyWorkspace,
  normalizeMessageAuthor,
  normalizeWorkspace,
  type Diagram,
  type ModelKey,
  type SeqModel,
  type Thread,
  type Workspace
} from './types.js'

// ---------- mensagens ----------
export interface StateMsg {
  type: 'state'
  session: string
  workspace?: unknown
  thread?: unknown
  busy?: boolean
  /** Tem adapter de agente registrado no `/agent`? */
  agentOnline?: boolean
  agentLabel?: string | null
}
export interface BusyMsg {
  type: 'busy'
  session: string
  busy: boolean
}
export interface AgentMsg {
  type: 'agent'
  online: boolean
  label?: string | null
}
export type ServerMsg = StateMsg | BusyMsg | AgentMsg | { type: 'pong' }

export type ClientMsg =
  | { type: 'patch'; session: string; lens: ModelKey; diagram: Diagram | SeqModel }
  | { type: 'analyze'; session: string; note?: string }
  | { type: 'ping' }

/** Estado do cano, do jeito que o pill da topbar mostra. */
export type ConnStatus = 'conectando' | 'conectado' | 'reconectando'

export interface Handlers {
  onWorkspace: (ws: Workspace) => void
  onThread: (t: Thread) => void
  onBusy: (busy: boolean) => void
  onConn: (c: ConnStatus) => void
  onAgent: (online: boolean, label: string | null) => void
}

const RETRY_BASE = 800
const RETRY_MAX = 10000

/** Slug da sessão a partir da URL (`/v2/?session=<slug>`). O servidor slugifica de novo. */
export function sessionFromUrl(): string {
  const s = new URLSearchParams(location.search).get('session')
  return (s || 'sessao').trim() || 'sessao'
}

/** Grava a sessão escolhida na URL sem recarregar (o link continua compartilhável). */
export function sessionToUrl(session: string): void {
  const u = new URL(location.href)
  u.searchParams.set('session', session)
  history.replaceState(null, '', u.toString())
}

function wsUrl(session: string): string {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://'
  return proto + location.host + '/ws?session=' + encodeURIComponent(session)
}

/**
 * Cano vivo com uma sessão. Reconecta sozinho com backoff (800ms → ×1.6 → 10s),
 * porque o servidor reinicia bastante durante o desenvolvimento e o Fabricio não
 * pode ter que apertar F5 no meio de um desenho.
 */
export class FlowForgeSocket {
  private ws: WebSocket | null = null
  private retry = RETRY_BASE
  private timer: ReturnType<typeof setTimeout> | null = null
  private dead = false
  private busy = false

  constructor(
    readonly session: string,
    private readonly h: Handlers
  ) {
    this.open()
  }

  private open(): void {
    if (this.dead) return
    this.h.onConn(this.retry === RETRY_BASE ? 'conectando' : 'reconectando')
    const ws = new WebSocket(wsUrl(this.session))
    this.ws = ws

    ws.onopen = () => {
      this.retry = RETRY_BASE
      this.h.onConn('conectado')
    }
    ws.onclose = () => {
      if (this.dead) return
      this.h.onConn('reconectando')
      this.timer = setTimeout(() => this.open(), this.retry)
      this.retry = Math.min(Math.round(this.retry * 1.6), RETRY_MAX)
    }
    ws.onerror = () => {
      try {
        ws.close()
      } catch {
        /* o onclose cuida da reconexão */
      }
    }
    ws.onmessage = (ev: MessageEvent) => this.receive(ev.data)
  }

  private receive(raw: unknown): void {
    let msg: ServerMsg
    try {
      msg = JSON.parse(String(raw)) as ServerMsg
    } catch {
      return // lixo no cano não derruba o editor
    }
    if (msg.type === 'state') {
      // Arquivo é a verdade (lei 2): o que veio do disco SUBSTITUI o local.
      this.h.onWorkspace(normalizeWorkspace(msg.workspace))
      this.h.onThread(normalizeThread(msg.thread))
      if (typeof msg.busy === 'boolean') this.setBusy(msg.busy)
      if (typeof msg.agentOnline === 'boolean') this.h.onAgent(msg.agentOnline, msg.agentLabel ?? null)
      return
    }
    if (msg.type === 'busy') {
      this.setBusy(!!msg.busy)
      return
    }
    if (msg.type === 'agent') {
      this.h.onAgent(!!msg.online, msg.label ?? null)
      return
    }
  }

  private setBusy(b: boolean): void {
    this.busy = b
    this.h.onBusy(b)
  }

  private send(msg: ClientMsg): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(msg))
    return true
  }

  /**
   * Grava UMA lente do workspace. Devolve `false` se não saiu (offline ou busy) —
   * quem chamou pode desfazer o otimismo local se quiser.
   */
  patch(lens: ModelKey, model: Diagram | SeqModel): boolean {
    if (this.busy) return false // lei 7: modo leitura, ninguém escreve por cima do agente
    return this.send({ type: 'patch', session: this.session, lens, diagram: model })
  }

  /** Despacha o "Analisar". O servidor liga o busy e avisa todo mundo. */
  analyze(note?: string): boolean {
    if (this.busy) return false
    return this.send({ type: 'analyze', session: this.session, note: note || '' })
  }

  close(): void {
    this.dead = true
    if (this.timer) clearTimeout(this.timer)
    try {
      this.ws?.close()
    } catch {
      /* já estava fechado */
    }
    this.ws = null
  }
}

function normalizeThread(raw: unknown): Thread {
  if (!raw || typeof raw !== 'object') return { messages: [] }
  const m = (raw as Record<string, unknown>).messages
  return {
    messages: Array.isArray(m)
      ? (m as Thread['messages']).map((msg) => ({ ...msg, author: normalizeMessageAuthor(msg.author) }))
      : []
  }
}

// ---------- ponte com o React ----------

export interface Live {
  workspace: Workspace
  thread: Thread
  busy: boolean
  conn: ConnStatus
  /** Adapter externo registrado. Sem ele, "Analisar" fica pendente no inbox. */
  agentOnline: boolean
  agentLabel: string | null
  /** grava uma lente (não sai quando busy — lei 7) */
  patch: (lens: ModelKey, model: Diagram | SeqModel) => void
  analyze: (note?: string) => void
}

/**
 * Liga o componente a uma sessão. Trocar de sessão fecha o cano antigo e abre o
 * novo — sem estado velho vazando pra sessão nova (por isso o workspace zera).
 */
export function useFlowForge(session: string): Live {
  const [workspace, setWorkspace] = useState<Workspace>(emptyWorkspace)
  const [thread, setThread] = useState<Thread>({ messages: [] })
  const [busy, setBusy] = useState(false)
  const [conn, setConn] = useState<ConnStatus>('conectando')
  const [agentOnline, setAgentOnline] = useState(false)
  const [agentLabel, setAgentLabel] = useState<string | null>(null)
  const sockRef = useRef<FlowForgeSocket | null>(null)

  useEffect(() => {
    setWorkspace(emptyWorkspace())
    setThread({ messages: [] })
    setBusy(false)
    setAgentOnline(false)
    setAgentLabel(null)
    const sock = new FlowForgeSocket(session, {
      onWorkspace: setWorkspace,
      onThread: setThread,
      onBusy: setBusy,
      onConn: setConn,
      onAgent: (online, label) => {
        setAgentOnline(online)
        setAgentLabel(label)
      }
    })
    sockRef.current = sock
    return () => {
      sock.close()
      sockRef.current = null
    }
  }, [session])

  const patch = useCallback((lens: ModelKey, model: Diagram | SeqModel) => {
    sockRef.current?.patch(lens, model)
  }, [])
  const analyze = useCallback((note?: string) => {
    sockRef.current?.analyze(note)
  }, [])

  return { workspace, thread, busy, conn, agentOnline, agentLabel, patch, analyze }
}
