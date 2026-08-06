// ============================================================================
// Palette — de onde saem os nós novos. Porte da paleta da fase 3 do editor
// antigo, incluindo o que o Fabricio pediu lá: **mini-SVG da forma real** em vez
// de um ícone genérico, para escolher pela silhueta e não pela leitura.
//
// Gesto: arrastar o item e soltar no canvas (`app.js:995-1012`). O duplo-clique
// no vazio continua criando uma tarefa direto, que é o atalho de quem já sabe o
// que quer.
//
// Flutua na borda esquerda do canvas em vez de ocupar uma coluna do shell: o
// editor novo é feito de painéis flutuantes (barra de lentes, card do nó), e
// tirar largura útil do canvas num diagrama de 22 nós custa mais que o painel.
//
// LEI 7: com `busy` a paleta não arrasta — o `dragstart` é cancelado na origem.
// ============================================================================

import { GRUPO_FLUXO, KIND_LABEL, KIND_LABEL_CURTO, KINDS, shapeOf, type FlowShape } from './shapes.js'

/** Silhueta da forma, do tamanho de um selo. Traço só — a cor vem do CSS. */
function ShapeGlyph({ shape }: { shape: FlowShape }): JSX.Element {
  const box = { width: 30, height: 20 }
  switch (shape) {
    case 'pill':
      return (
        <svg {...box} viewBox="0 0 30 20" aria-hidden>
          <rect x="1.5" y="3.5" width="27" height="13" rx="6.5" />
        </svg>
      )
    case 'diamond':
      return (
        <svg {...box} viewBox="0 0 30 20" aria-hidden>
          <path d="M15 2 L28 10 L15 18 L2 10 Z" />
        </svg>
      )
    case 'gate':
      return (
        <svg {...box} viewBox="0 0 30 20" aria-hidden>
          <path d="M15 2 L28 10 L15 18 L2 10 Z" />
          <path d="M11.5 6.5 L18.5 13.5 M18.5 6.5 L11.5 13.5" />
        </svg>
      )
    case 'event':
      return (
        <svg {...box} viewBox="0 0 30 20" aria-hidden>
          <circle cx="15" cy="10" r="8" />
        </svg>
      )
    case 'idea':
      return (
        <svg {...box} viewBox="0 0 30 20" aria-hidden>
          <ellipse cx="15" cy="10" rx="13" ry="7.5" />
        </svg>
      )
    case 'data':
      return (
        <svg {...box} viewBox="0 0 30 20" aria-hidden>
          <path d="M6 2.5 L28.5 2.5 L24 17.5 L1.5 17.5 Z" />
        </svg>
      )
    case 'annotation':
      return (
        <svg {...box} viewBox="0 0 30 20" aria-hidden>
          <rect x="1.5" y="3.5" width="27" height="13" rx="2.5" strokeDasharray="3 2.5" />
        </svg>
      )
    case 'subprocess':
      return (
        <svg {...box} viewBox="0 0 30 20" aria-hidden>
          <rect x="1.5" y="3.5" width="27" height="13" rx="2.5" />
          <path d="M15 8.5 L15 13.5 M12.5 11 L17.5 11" />
        </svg>
      )
    default:
      return (
        <svg {...box} viewBox="0 0 30 20" aria-hidden>
          <rect x="1.5" y="3.5" width="27" height="13" rx="2.5" />
        </svg>
      )
  }
}

/** O gesto do gateway paralelo é ✛, não ✕ — a silhueta tem de mostrar isso. */
function GlyphFor({ kind }: { kind: string }): JSX.Element {
  if (kind === 'gateway-parallel') {
    return (
      <svg width={30} height={20} viewBox="0 0 30 20" aria-hidden>
        <path d="M15 2 L28 10 L15 18 L2 10 Z" />
        <path d="M15 6 L15 14 M11 10 L19 10" />
      </svg>
    )
  }
  return <ShapeGlyph shape={shapeOf(kind)} />
}

export interface PaletteProps {
  busy?: boolean
  /** Kind clicado — cria no meio da viewport (atalho pra quem não quer arrastar). */
  onPick: (kind: string) => void
}

export function Palette({ busy = false, onPick }: PaletteProps): JSX.Element {
  const fluxo = KINDS.filter((k) => GRUPO_FLUXO.has(k))
  const bpm = KINDS.filter((k) => !GRUPO_FLUXO.has(k))

  const item = (kind: string): JSX.Element => (
    <button
      key={kind}
      className="pal-item"
      draggable={!busy}
      disabled={busy}
      title={`${KIND_LABEL[kind]} — arraste pro canvas (ou clique)`}
      onDragStart={(e) => {
        if (busy) return e.preventDefault()
        e.dataTransfer.setData('text/flowforge-kind', kind)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      onClick={() => !busy && onPick(kind)}
    >
      <GlyphFor kind={kind} />
      <span className="pal-lbl">{KIND_LABEL_CURTO[kind] ?? KIND_LABEL[kind]}</span>
    </button>
  )

  return (
    <div className={'palette' + (busy ? ' ro' : '')} aria-label="paleta de formas">
      <div className="pal-sec neon-mono">fluxo</div>
      <div className="pal-grid">{fluxo.map(item)}</div>
      <div className="pal-sec neon-mono">bpm</div>
      <div className="pal-grid">{bpm.map(item)}</div>
    </div>
  )
}
