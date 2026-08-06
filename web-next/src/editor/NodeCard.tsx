// ============================================================================
// NodeCard — o card flutuante do nó selecionado. Porte do `#node-card` do editor
// antigo (`web/index.html:166`), que é onde os campos do nó moram desde a fase 3.
//
// Duas abas, como lá: DESCRIÇÃO (rótulo, tipo, descrição técnica) e NOTAS (a
// conversa do nó). Os botões de veredito ficam FORA das abas, sempre visíveis —
// é o gesto mais frequente e não pode depender de estar na aba certa.
//
// QUANDO ESCREVE — a regra vem do antigo (`app.js:840-844`) e importa:
//   · digitar mexe SÓ no estado local (`input`)
//   · o patch sai no `change` — blur ou Enter
// Escrever a cada tecla incrementaria o `rev` (lei 6) e dispararia um `fs.watch`
// por caractere; o eco voltaria por cima do campo e comeria o cursor no meio da
// palavra. Já o `select` de tipo commita direto: ali não existe "meio da edição".
//
// LEI 7: com `busy` ligado o card lê, mas não escreve — os campos desabilitam.
// A garantia dura continua no transporte (`ws.ts`), isto aqui é a cortesia.
// ============================================================================

import { useEffect, useState } from 'react'
import type { Comment, DNode, NodeStatus } from '../types.js'
import { KINDS } from './shapes.js'
import { STLBL } from './status.js'

/** Rótulo em PT-BR de cada kind, agrupado como no `select` do editor antigo. */
const KIND_LABEL: Record<string, string> = {
  start: 'início',
  task: 'tarefa',
  decision: 'decisão',
  end: 'fim',
  idea: 'ideia',
  'event-start': 'evento início',
  'event-intermediate': 'evento intermediário',
  'event-end': 'evento fim',
  'gateway-exclusive': 'gateway exclusivo (ou)',
  'gateway-parallel': 'gateway paralelo (e)',
  subprocess: 'subprocesso',
  'data-object': 'objeto de dado',
  annotation: 'anotação'
}
const GRUPO_FLUXO = new Set(['start', 'task', 'decision', 'end', 'idea'])

export interface NodeCardProps {
  node: DNode
  busy?: boolean
  onVerdict: (id: string, status: NodeStatus, reason?: string) => void
  /** Grava campos do nó (já commitado — não chamar a cada tecla). */
  onEdit: (id: string, patch: Partial<DNode>) => void
}

export function NodeCard({ node, busy = false, onVerdict, onEdit }: NodeCardProps): JSX.Element {
  const [tab, setTab] = useState<'desc' | 'notas'>('desc')
  const [reasonFor, setReasonFor] = useState<NodeStatus | null>(null)
  const [reason, setReason] = useState('')

  // Rascunho local dos campos de texto. Semeado pelo nó e RE-semeado quando a
  // seleção troca — sem isso o card abriria com o texto do nó anterior.
  const [label, setLabel] = useState(node.label)
  const [desc, setDesc] = useState(node.description ?? '')
  useEffect(() => {
    setLabel(node.label)
    setDesc(node.description ?? '')
    setTab('desc')
    setReasonFor(null)
  }, [node.id])

  const verdict = (status: NodeStatus): void => {
    if (status === 'rejected' || status === 'questioned') {
      setReasonFor(status)
      setReason('')
    } else {
      onVerdict(node.id, status)
    }
  }
  const confirmReason = (): void => {
    if (reasonFor && reason.trim()) onVerdict(node.id, reasonFor, reason.trim())
    setReasonFor(null)
    setReason('')
  }

  const commitLabel = (): void => {
    const v = label.trim()
    // rótulo vazio não vale: o nó viraria uma caixa anônima no canvas
    if (!v) return setLabel(node.label)
    if (v !== node.label) onEdit(node.id, { label: v })
  }
  const commitDesc = (): void => {
    if (desc !== (node.description ?? '')) onEdit(node.id, { description: desc })
  }

  const notas = node.comments?.length ?? 0

  return (
    <div className="fpanel nodrag nowheel" onClick={(e) => e.stopPropagation()}>
      <div className="fpanel-caret" />
      <div className="fpanel-head">
        <span className="fpanel-kind neon-mono">{KIND_LABEL[node.kind] ?? node.kind}</span>
        <span className="fpanel-badge neon-mono">{STLBL[node.status]}</span>
      </div>

      <div className="fcard-tabs neon-mono">
        <button className={tab === 'desc' ? 'on' : ''} onClick={() => setTab('desc')}>
          descrição
        </button>
        <button className={tab === 'notas' ? 'on' : ''} onClick={() => setTab('notas')}>
          notas{notas > 0 ? ` · ${notas}` : ''}
        </button>
      </div>

      {tab === 'desc' ? (
        <div className="fcard-pane">
          <label className="fcard-lbl neon-mono" htmlFor={`lbl-${node.id}`}>
            rótulo
          </label>
          <input
            id={`lbl-${node.id}`}
            className="fcard-input"
            value={label}
            disabled={busy}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={commitLabel}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') setLabel(node.label)
            }}
          />

          <label className="fcard-lbl neon-mono" htmlFor={`kind-${node.id}`}>
            tipo
          </label>
          <select
            id={`kind-${node.id}`}
            className="fcard-input"
            value={node.kind}
            disabled={busy}
            onChange={(e) => onEdit(node.id, { kind: e.target.value })}
          >
            <optgroup label="Fluxo">
              {KINDS.filter((k) => GRUPO_FLUXO.has(k)).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </optgroup>
            <optgroup label="BPM">
              {KINDS.filter((k) => !GRUPO_FLUXO.has(k)).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </optgroup>
            {/* kind fora da lista (do Claude, ou de uma versão futura) não pode
                sumir do select e virar 'task' sem ninguém pedir */}
            {!(node.kind in KIND_LABEL) && (
              <optgroup label="Atual">
                <option value={node.kind}>{node.kind}</option>
              </optgroup>
            )}
          </select>

          <label className="fcard-lbl neon-mono" htmlFor={`desc-${node.id}`}>
            descrição técnica
          </label>
          <textarea
            id={`desc-${node.id}`}
            className="fcard-input fcard-area neon-mono"
            rows={3}
            value={desc}
            disabled={busy}
            placeholder="o que essa etapa faz, na prática…"
            onChange={(e) => setDesc(e.target.value)}
            onBlur={commitDesc}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setDesc(node.description ?? '')
            }}
          />
        </div>
      ) : (
        <div className="fcard-pane">
          {notas === 0 ? (
            <p className="fcard-vazio">sem notas neste nó.</p>
          ) : (
            <div className="fpanel-thread">
              {node.comments.map((c: Comment, i) => (
                <div key={i} className={`fpanel-cmt ${c.author} ${c.kind}`}>
                  <span className="who neon-mono">{c.author}</span>
                  {c.text}
                </div>
              ))}
            </div>
          )}
          <NotaNova busy={busy} onAdd={(text) => onEdit(node.id, { comments: [...(node.comments ?? []), { author: 'user', kind: 'note', text, ts: Date.now() }] })} />
        </div>
      )}

      <div className="fpanel-verdict">
        <button className="v ok" title="aprovar" disabled={busy} onClick={() => verdict('approved')}>
          ✓
        </button>
        <button className="v qu" title="questionar" disabled={busy} onClick={() => verdict('questioned')}>
          ?
        </button>
        <button className="v no" title="reprovar" disabled={busy} onClick={() => verdict('rejected')}>
          ✗
        </button>
        <button className="v rs" title="voltar a proposto" disabled={busy} onClick={() => verdict('proposed')}>
          ○
        </button>
      </div>

      {reasonFor && (
        <div className="fpanel-reason">
          <input
            autoFocus
            placeholder={reasonFor === 'rejected' ? 'motivo da reprovação…' : 'o que você questiona?'}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirmReason()
              if (e.key === 'Escape') {
                setReasonFor(null)
                setReason('')
              }
            }}
          />
          <button onClick={confirmReason}>ok</button>
        </div>
      )}
    </div>
  )
}

/** Campo de nota livre. Enter grava; o campo se limpa pra a próxima. */
function NotaNova({ busy, onAdd }: { busy: boolean; onAdd: (text: string) => void }): JSX.Element {
  const [txt, setTxt] = useState('')
  const grava = (): void => {
    const v = txt.trim()
    if (!v) return
    onAdd(v)
    setTxt('')
  }
  return (
    <div className="fcard-nota">
      <input
        placeholder="anotar…"
        value={txt}
        disabled={busy}
        onChange={(e) => setTxt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') grava()
          if (e.key === 'Escape') setTxt('')
        }}
      />
      <button disabled={busy || !txt.trim()} onClick={grava} title="anotar (Enter)">
        +
      </button>
    </div>
  )
}
