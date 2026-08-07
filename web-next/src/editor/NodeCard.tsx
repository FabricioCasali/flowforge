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

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Comment, DNode, ErField, Lane, NodeStatus } from '../types.js'
import { GRUPO_FLUXO, KIND_LABEL, KINDS } from './shapes.js'
import { STLBL } from './status.js'

type Tab = 'desc' | 'teoria' | 'campos' | 'notas'

export interface NodeCardProps {
  node: DNode
  busy?: boolean
  /** Raias do diagrama — quando existem, o card deixa escolher a do nó. */
  lanes?: Lane[]
  onVerdict: (id: string, status: NodeStatus, reason?: string) => void
  /** Grava campos do nó (já commitado — não chamar a cada tecla). */
  onEdit: (id: string, patch: Partial<DNode>) => void
}

export function NodeCard({ node, busy = false, lanes = [], onVerdict, onEdit }: NodeCardProps): JSX.Element {
  const ehEntidade = node.kind === 'entity'
  const [tab, setTab] = useState<Tab>('desc')
  const [reasonFor, setReasonFor] = useState<NodeStatus | null>(null)
  const [reason, setReason] = useState('')

  // Rascunho local dos campos de texto. Semeado pelo nó e RE-semeado quando a
  // seleção troca — sem isso o card abriria com o texto do nó anterior.
  const [label, setLabel] = useState(node.label)
  const [desc, setDesc] = useState(node.description ?? '')
  const [teoria, setTeoria] = useState(node.concept ?? '')
  useEffect(() => {
    setLabel(node.label)
    setDesc(node.description ?? '')
    setTeoria(node.concept ?? '')
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
  const commitTeoria = (): void => {
    if (teoria !== (node.concept ?? '')) onEdit(node.id, { concept: teoria })
  }

  /**
   * FF-012 — de que lado o card cabe.
   *
   * Ele abre à direita do nó por padrão. Num nó colado na borda direita da
   * viewport isso o punha fora da tela: o card existia e era inalcançável.
   * Aqui ele mede a si mesmo depois de montado e vira pro lado que couber; se
   * não couber de nenhum, desce pra baixo do nó (que sempre sobra).
   *
   * Medir > adivinhar: a largura do card e o zoom do canvas mudam, e regra de
   * CSS pura não enxerga nem um nem outro.
   */
  const caixa = useRef<HTMLDivElement>(null)
  const [lado, setLado] = useState('')
  useLayoutEffect(() => {
    const el = caixa.current
    if (!el) return
    setLado('') // mede sempre a partir do padrão, senão a decisão vira histerese
    const id = requestAnimationFrame(() => {
      const r = el.getBoundingClientRect()
      const folga = 12
      if (r.right <= window.innerWidth - folga) return
      // não cabe à direita: tenta a esquerda medindo o espaço que sobra lá
      const larguraCard = r.width
      const espacoEsq = r.left - larguraCard - 32
      setLado(espacoEsq > folga ? 'esq' : 'abaixo')
    })
    return () => cancelAnimationFrame(id)
  }, [node.id, tab])

  const notas = node.comments?.length ?? 0

  return (
    <div className={'fpanel nodrag nowheel ' + lado} ref={caixa} onClick={(e) => e.stopPropagation()}>
      <div className="fpanel-caret" />
      <div className="fpanel-head">
        <span className="fpanel-kind neon-mono">{KIND_LABEL[node.kind] ?? node.kind}</span>
        <span className="fpanel-badge neon-mono">{STLBL[node.status]}</span>
      </div>

      <div className="fcard-tabs neon-mono">
        <button className={tab === 'desc' ? 'on' : ''} onClick={() => setTab('desc')} title="o exemplo real: o que acontece na prática">
          prática
        </button>
        <button
          className={tab === 'teoria' ? 'on' : ''}
          onClick={() => setTab('teoria')}
          title="a teoria: o conceito, para quem está entendendo o fluxo — aparece no modo guiado"
        >
          teoria{node.concept?.trim() ? ' ·' : ''}
        </button>
        {ehEntidade && (
          <button className={tab === 'campos' ? 'on' : ''} onClick={() => setTab('campos')}>
            campos{(node.fields?.length ?? 0) > 0 ? ` · ${node.fields!.length}` : ''}
          </button>
        )}
        <button className={tab === 'notas' ? 'on' : ''} onClick={() => setTab('notas')}>
          notas{notas > 0 ? ` · ${notas}` : ''}
        </button>
      </div>

      {tab === 'desc' ? (
        // Duas colunas: identidade à esquerda (campos curtos), texto à direita
        // (campo longo). Empilhado, a descrição nascia num textarea de 3 linhas
        // espremido no fim do card — o campo mais lido era o pior de ler.
        <div className="fcard-pane fcard-2col">
          <div className="fcard-col">
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
              {!(node.kind in KIND_LABEL) && (
                <optgroup label="Atual">
                  <option value={node.kind}>{node.kind}</option>
                </optgroup>
              )}
            </select>

            {lanes.length > 0 && (
              <>
                <label className="fcard-lbl neon-mono" htmlFor={`lane-${node.id}`}>
                  raia (ator)
                </label>
                <select
                  id={`lane-${node.id}`}
                  className="fcard-input"
                  value={node.lane ?? ''}
                  disabled={busy}
                  onChange={(e) => onEdit(node.id, { lane: e.target.value || undefined })}
                >
                  <option value="">— sem raia —</option>
                  {lanes.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.label || l.id}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>

          <div className="fcard-col fcard-col-texto">
            <label className="fcard-lbl neon-mono" htmlFor={`desc-${node.id}`}>
              o que acontece na prática
            </label>
            <textarea
              id={`desc-${node.id}`}
              className="fcard-input fcard-area fcard-area-alta neon-mono"
              value={desc}
              disabled={busy}
              placeholder="o arquivo, o serviço, a tabela, o passo concreto…"
              onChange={(e) => setDesc(e.target.value)}
              onBlur={commitDesc}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setDesc(node.description ?? '')
              }}
            />
          </div>
        </div>
      ) : tab === 'teoria' ? (
        <div className="fcard-pane">
          <label className="fcard-lbl neon-mono" htmlFor={`teo-${node.id}`}>
            o conceito por trás desta etapa
          </label>
          <textarea
            id={`teo-${node.id}`}
            className="fcard-input fcard-area"
            rows={5}
            value={teoria}
            disabled={busy}
            placeholder="por que esta etapa existe, o que ela resolve, o que alguém precisa entender aqui…"
            onChange={(e) => setTeoria(e.target.value)}
            onBlur={commitTeoria}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setTeoria(node.concept ?? '')
            }}
          />
          <p className="fcard-dica neon-mono">
            é este texto que aparece no <b>modo guiado</b>. A aba “prática” é o exemplo real.
          </p>
        </div>
      ) : tab === 'campos' ? (
        <CamposEr
          busy={busy}
          fields={node.fields ?? []}
          onChange={(fields) => onEdit(node.id, { fields })}
        />
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

/**
 * Campos da entidade (ER). Cada linha é nome + tipo + chave; a lista inteira vai
 * de uma vez pro `onChange`, porque `fields` é um array no modelo e patch parcial
 * de array não existe. Nome e tipo commitam no blur, como todo texto do card.
 */
function CamposEr({
  fields,
  busy,
  onChange
}: {
  fields: ErField[]
  busy: boolean
  onChange: (f: ErField[]) => void
}): JSX.Element {
  const troca = (i: number, patch: Partial<ErField>): void => {
    const next = fields.map((f, j) => (j === i ? { ...f, ...patch } : f))
    onChange(next)
  }
  return (
    <div className="fcard-pane">
      {fields.length === 0 && <p className="fcard-vazio">sem campos ainda.</p>}
      {fields.map((f, i) => (
        <div key={i} className="erf-row">
          <select
            className="erf-key neon-mono"
            value={f.key ?? ''}
            disabled={busy}
            title="chave"
            onChange={(e) => troca(i, { key: (e.target.value || null) as ErField['key'] })}
          >
            <option value="">—</option>
            <option value="pk">PK</option>
            <option value="fk">FK</option>
          </select>
          <input
            className="erf-name"
            defaultValue={f.name}
            disabled={busy}
            placeholder="nome"
            onBlur={(e) => e.target.value !== f.name && troca(i, { name: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
          <input
            className="erf-type neon-mono"
            defaultValue={f.type}
            disabled={busy}
            placeholder="tipo"
            onBlur={(e) => e.target.value !== f.type && troca(i, { type: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
          <button
            className="erf-del"
            disabled={busy}
            title="remover campo"
            onClick={() => onChange(fields.filter((_, j) => j !== i))}
          >
            ✕
          </button>
        </div>
      ))}
      <button
        className="fcard-add"
        disabled={busy}
        onClick={() => onChange([...fields, { name: 'campo', type: 'text', key: null }])}
      >
        + campo
      </button>
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
