// ============================================================================
// Toolbar — as ferramentas do editor (FF-007): desfazer/refazer, busca com
// salto, menu de arranjos e export.
//
// Fica no topo-direito, ao lado do "Aprovar tudo". Tudo aqui é gesto de quem já
// está desenhando — nada disso muda o modelo sozinho, exceto o arranjo (que
// reposiciona e grava, e por isso entra no histórico como qualquer edição).
//
// A busca salta pro nó: digitar filtra, Enter vai pro primeiro, Enter de novo
// vai pro próximo (o "circula pelos achados" do editor antigo).
// ============================================================================

import { useEffect, useMemo, useRef, useState } from 'react'
import type { DNode } from '../types.js'
import { LAYOUTS, type LayoutNome } from './layout.js'

export interface ToolbarProps {
  nodes: DNode[]
  busy?: boolean
  podeDesfazer: boolean
  podeRefazer: boolean
  onDesfazer: () => void
  onRefazer: () => void
  onArranjo: (nome: LayoutNome) => void
  onSaltar: (id: string) => void
  onExport: (formato: 'png' | 'svg' | 'mmd') => void
}

export function Toolbar({
  nodes,
  busy = false,
  podeDesfazer,
  podeRefazer,
  onDesfazer,
  onRefazer,
  onArranjo,
  onSaltar,
  onExport
}: ToolbarProps): JSX.Element {
  const [busca, setBusca] = useState('')
  const [menu, setMenu] = useState<'arranjo' | 'export' | null>(null)
  const idx = useRef(0)
  const caixa = useRef<HTMLDivElement>(null)

  const achados = useMemo(() => {
    const q = busca.trim().toLowerCase()
    if (!q) return []
    return nodes.filter((n) => (n.label || '').toLowerCase().includes(q) || (n.description || '').toLowerCase().includes(q))
  }, [busca, nodes])

  useEffect(() => {
    idx.current = 0
  }, [busca])

  // clique fora fecha o menu aberto
  useEffect(() => {
    if (!menu) return
    const fora = (e: globalThis.MouseEvent): void => {
      if (!caixa.current?.contains(e.target as Node)) setMenu(null)
    }
    document.addEventListener('mousedown', fora)
    return () => document.removeEventListener('mousedown', fora)
  }, [menu])

  const saltar = (): void => {
    if (!achados.length) return
    const n = achados[idx.current % achados.length]!
    idx.current++
    onSaltar(n.id)
  }

  return (
    <div className="toolbar neon-mono" ref={caixa}>
      <button className="tb-btn" title="desfazer (Ctrl+Z)" disabled={busy || !podeDesfazer} onClick={onDesfazer}>
        ↺
      </button>
      <button className="tb-btn" title="refazer (Ctrl+Shift+Z)" disabled={busy || !podeRefazer} onClick={onRefazer}>
        ↻
      </button>

      <span className="tb-sep" />

      <div className="tb-busca">
        <input
          value={busca}
          placeholder="buscar nó…"
          onChange={(e) => setBusca(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') saltar()
            if (e.key === 'Escape') setBusca('')
          }}
        />
        {busca.trim() && <span className="tb-cont">{achados.length}</span>}
      </div>

      <span className="tb-sep" />

      <div className="tb-menu-wrap">
        <button
          className={'tb-btn' + (menu === 'arranjo' ? ' on' : '')}
          title="arranjar o diagrama"
          disabled={busy}
          onClick={() => setMenu(menu === 'arranjo' ? null : 'arranjo')}
        >
          ⌗ arranjo
        </button>
        {menu === 'arranjo' && (
          <div className="tb-menu">
            {LAYOUTS.map((l) => (
              <button
                key={l.nome}
                onClick={() => {
                  setMenu(null)
                  onArranjo(l.nome)
                }}
              >
                {l.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="tb-menu-wrap">
        <button
          className={'tb-btn' + (menu === 'export' ? ' on' : '')}
          title="exportar"
          onClick={() => setMenu(menu === 'export' ? null : 'export')}
        >
          ↧ export
        </button>
        {menu === 'export' && (
          <div className="tb-menu">
            <button
              onClick={() => {
                setMenu(null)
                onExport('png')
              }}
            >
              PNG
            </button>
            <button
              onClick={() => {
                setMenu(null)
                onExport('svg')
              }}
            >
              SVG (vetorial)
            </button>
            <button
              onClick={() => {
                setMenu(null)
                onExport('mmd')
              }}
            >
              Mermaid (.mmd)
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
