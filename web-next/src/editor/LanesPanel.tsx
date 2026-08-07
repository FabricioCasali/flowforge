// ============================================================================
// LanesPanel — criar, renomear e remover raias (atores) na lente Swimlane.
//
// No editor antigo isso estava espalhado: um item "Raias ⇉" na paleta pra criar
// e um duplo-clique na faixa do cabeçalho pra renomear (`app.js:1018`). Um
// duplo-clique numa faixa fina é um gesto que só quem escreveu o código
// descobre, então aqui vira um painel explícito — as raias são metadado do
// diagrama, não nós, e merecem um lugar próprio.
//
// A raia removida não leva os nós junto: eles perdem o `lane` e caem em "sem
// raia". Apagar trabalho por tabela seria pior que uma raia órfã.
// ============================================================================

import { useState } from 'react'
import type { Lane } from '../types.js'
import { uid } from './model.js'

export interface LanesPanelProps {
  lanes: Lane[]
  busy?: boolean
  /** Recebe a lista inteira, já ordenada — `lanes` é array no modelo. */
  onChange: (lanes: Lane[], removida?: string) => void
}

export function LanesPanel({ lanes, busy = false, onChange }: LanesPanelProps): JSX.Element {
  const [aberto, setAberto] = useState(true)
  const ordenadas = [...lanes].sort((a, b) => a.order - b.order)

  const renomeia = (id: string, label: string): void => {
    onChange(ordenadas.map((l) => (l.id === id ? { ...l, label } : l)))
  }
  const remove = (id: string): void => {
    onChange(
      ordenadas.filter((l) => l.id !== id).map((l, i) => ({ ...l, order: i })),
      id
    )
  }
  const adiciona = (): void => {
    onChange([...ordenadas, { id: uid('l'), label: 'novo ator', order: ordenadas.length }])
  }
  const move = (id: string, delta: number): void => {
    const i = ordenadas.findIndex((l) => l.id === id)
    const j = i + delta
    if (i < 0 || j < 0 || j >= ordenadas.length) return
    const arr = [...ordenadas]
    ;[arr[i], arr[j]] = [arr[j]!, arr[i]!]
    onChange(arr.map((l, k) => ({ ...l, order: k })))
  }

  return (
    <div className={'lanespanel' + (busy ? ' ro' : '')}>
      <button className="lanes-head neon-mono" onClick={() => setAberto((v) => !v)}>
        <span>raias · {ordenadas.length}</span>
        <span className="chev">{aberto ? '▾' : '▸'}</span>
      </button>

      {aberto && (
        <div className="lanes-body">
          {ordenadas.length === 0 && <p className="fcard-vazio">nenhuma raia — o fluxo aparece sem bandas.</p>}
          {ordenadas.map((l, i) => (
            <div key={l.id} className="lane-row">
              <div className="lane-ord">
                <button disabled={busy || i === 0} title="subir" onClick={() => move(l.id, -1)}>
                  ▴
                </button>
                <button disabled={busy || i === ordenadas.length - 1} title="descer" onClick={() => move(l.id, 1)}>
                  ▾
                </button>
              </div>
              <input
                defaultValue={l.label}
                disabled={busy}
                placeholder="nome do ator"
                onBlur={(e) => e.target.value !== l.label && renomeia(l.id, e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              />
              <button className="lane-del" disabled={busy} title="remover a raia" onClick={() => remove(l.id)}>
                ✕
              </button>
            </div>
          ))}
          <button className="fcard-add" disabled={busy} onClick={adiciona}>
            + raia
          </button>
        </div>
      )}
    </div>
  )
}
