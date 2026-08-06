// ============================================================================
// App — o shell do editor novo (/v2). Objetivo desta fase: o LOOP VIVO ponta a
// ponta (desenhar → Analisar → o Claude edita o arquivo → o canvas atualiza
// sozinho). Paridade de edição com o `web/` antigo é a próxima fase.
//
// Peças:
//   · topbar    — título da sessão (do workspace), seletor de sessão, pill de
//                 conexão e o aviso de modo leitura (lei 7)
//   · canvas    — <EditorView>, com a barra das 6 lentes flutuando no topo-esq.
//                 (a barra é do editor, mas o estado da lente mora aqui: a
//                 topbar e o canvas falam da mesma lente)
//   · conversa  — o `thread.json` da sessão + caixa de nota + Analisar
//
// Ninguém aqui toca em `diagram.json` (lei 1): o editor novo vive no
// `workspace.json`, o antigo continua dono do arquivo antigo, servido em /.
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EditorView } from './editor/EditorView.js'
import type { LensKey } from './editor/lenses.js'
import { workspaceTitle, type Thread } from './types.js'
import { sessionFromUrl, sessionToUrl, useFlowForge, type ConnStatus } from './ws.js'

export function App(): JSX.Element {
  const [session, setSession] = useState<string>(sessionFromUrl)
  const [sessions, setSessions] = useState<string[]>([])
  const [lens, setLens] = useState<LensKey>('flow')
  const { workspace, thread, busy, conn, patch, analyze } = useFlowForge(session)

  // lista de sessões pro seletor. Recarrega quando a sessão muda porque abrir
  // uma sessão nova a CRIA no servidor (ensureSession) — ela precisa aparecer.
  useEffect(() => {
    let alive = true
    fetch('/api/sessions')
      .then((r) => r.json())
      .then((j: { sessions?: unknown }) => {
        if (alive && Array.isArray(j.sessions)) setSessions(j.sessions as string[])
      })
      .catch(() => {
        /* servidor caiu — o pill de conexão já conta essa história */
      })
    return () => {
      alive = false
    }
  }, [session])

  const trocaSessao = useCallback((s: string) => {
    setSession(s)
    sessionToUrl(s)
  }, [])

  const title = workspaceTitle(workspace)
  useEffect(() => {
    document.title = title + ' · FlowForge'
  }, [title])

  /**
   * Renomear a sessão. O título NÃO mora no workspace — mora dentro de cada um
   * dos 5 modelos (é o FF-009, decisão de contrato ainda em aberto). Enquanto
   * ela não é tomada, renomear grava em TODOS os modelos com conteúdo, senão as
   * lentes passariam a mostrar nomes diferentes do mesmo assunto. Custa um
   * patch por modelo — feio, e é exatamente o argumento pra fechar o FF-009.
   */
  const renomear = useCallback(
    (novo: string) => {
      const limpo = novo.trim()
      if (!limpo || limpo === title || busy) return
      const modelos = (['process', 'state', 'er', 'mind'] as const).filter((m) => workspace[m].nodes.length > 0)
      const alvos = modelos.length ? modelos : (['process'] as const)
      for (const m of alvos) patch(m, { ...workspace[m], title: limpo })
    },
    [title, busy, workspace, patch]
  )

  return (
    <div className="ff-shell neon-plane">
      <header className="ff-topbar">
        <span className="ff-brand neon-mono">FlowForge</span>
        <TituloEditavel title={title} busy={busy} onRename={renomear} />
        <span className="ff-spacer" />
        {busy && <span className="ff-pill busy neon-mono">modo leitura · Claude analisando…</span>}
        <select
          className="ff-sess neon-mono"
          value={sessions.includes(session) ? session : ''}
          onChange={(e) => e.target.value && trocaSessao(e.target.value)}
          title="Trocar de sessão"
        >
          {!sessions.includes(session) && <option value="">{session}</option>}
          {sessions.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <ConnPill conn={conn} />
      </header>

      <EditorView workspace={workspace} lens={lens} onLens={setLens} busy={busy} onPatch={patch} />

      <ChatPanel thread={thread} busy={busy} online={conn === 'conectado'} onAnalyze={analyze} />
    </div>
  )
}

/** Título da sessão: clicou, virou campo. Enter grava, Esc desiste. */
function TituloEditavel({
  title,
  busy,
  onRename
}: {
  title: string
  busy: boolean
  onRename: (novo: string) => void
}): JSX.Element {
  const [editando, setEditando] = useState(false)
  const [txt, setTxt] = useState(title)

  useEffect(() => {
    if (!editando) setTxt(title)
  }, [title, editando])

  if (!editando) {
    return (
      <button
        className="ff-title"
        title={busy ? title : `${title} — clique pra renomear`}
        disabled={busy}
        onClick={() => setEditando(true)}
      >
        {title}
      </button>
    )
  }
  return (
    <input
      className="ff-title-edit"
      autoFocus
      value={txt}
      onChange={(e) => setTxt(e.target.value)}
      onBlur={() => {
        onRename(txt)
        setEditando(false)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          setTxt(title)
          setEditando(false)
        }
      }}
    />
  )
}

function ConnPill({ conn }: { conn: ConnStatus }): JSX.Element {
  return <span className={'ff-pill ' + (conn === 'conectado' ? 'on' : 'off') + ' neon-mono'}>{conn}</span>
}

/**
 * A conversa da sessão: o `thread.json` inteiro (é o arquivo-verdade da
 * conversa — o editor não guarda mensagem em memória) + a caixa que vai junto
 * no "Analisar". Ctrl/⌘+Enter despacha.
 */
function ChatPanel({
  thread,
  busy,
  online,
  onAnalyze
}: {
  thread: Thread
  busy: boolean
  online: boolean
  onAnalyze: (note?: string) => void
}): JSX.Element {
  const [note, setNote] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const msgs = thread.messages ?? []

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [msgs.length, busy])

  const podeEnviar = online && !busy
  const enviar = useCallback(() => {
    if (!podeEnviar) return
    onAnalyze(note.trim())
    setNote('')
  }, [podeEnviar, note, onAnalyze])

  const rotulo = useMemo(
    () => (busy ? '⏳ Claude analisando…' : online ? '▶ Analisar com o Claude' : '⚠ desconectado'),
    [busy, online]
  )

  return (
    <aside className="ff-chat">
      <div className="ff-chat-head neon-mono">
        {busy && <span className="live" />}
        conversa
      </div>

      <div className="ff-msgs" ref={listRef}>
        {msgs.length === 0 ? (
          <div className="ff-empty">
            Fale comigo sobre o diagrama todo (ex: “reprovei o nó X, e se a fila cair?”) e clique Analisar.
          </div>
        ) : (
          msgs.map((m, i) => (
            <div key={i} className={'ff-msg ' + (m.author || 'user')}>
              <div className="who neon-mono">{m.author === 'claude' ? 'Claude' : m.author === 'system' ? 'sistema' : 'você'}</div>
              <div className="txt">{m.text}</div>
            </div>
          ))
        )}
      </div>

      <div className="ff-compose">
        <textarea
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="o que você quer que eu olhe neste diagrama?"
          disabled={busy}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') enviar()
          }}
        />
        <button className="ff-analyze" onClick={enviar} disabled={!podeEnviar}>
          {rotulo}
        </button>
      </div>
    </aside>
  )
}
