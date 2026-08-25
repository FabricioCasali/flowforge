// ============================================================================
// FlowNode — o nó do grafo, com as formas por `kind` (LEI 8 do AGENTS.md).
//
// O porte do NEON só conhecia 3 famílias (pill/diamond/rect), e isso apagava
// distinção que os diagramas reais usam o tempo todo: `annotation` é o 2º kind
// mais usado (21 nós) e virava um retângulo igual a uma etapa de verdade.
//
// Referência exata das formas: `web/app.js:60-74` (o editor antigo, Cytoscape).
// A divisão de responsabilidade vem de lá e vale aqui:
//     FUNDO/CONTORNO = kind   (o que a coisa É)
//     BORDA/GLOW     = status (o veredito da co-decisão)
// Por isso `start` não é pintado de verde-aprovado: a tinta do kind é discreta e
// o eixo de cor forte continua sendo só o status.
//
// Rótulo FORA da forma em evento e gateway — são pequenos (62/92px) e é assim
// que o BPM se lê. O tamanho da caixa vem de `nodeSize` em layout.ts, que é o
// par desta tabela: mudou um, mude o outro.
// ============================================================================

import { Fragment } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { DNode, Lane, NodeStatus, Side } from '../types.js'
import { LIVE, SC, STLBL } from './status.js'
import { NodeCard } from './NodeCard.js'
import { BOXY, DIAMONDISH, LABEL_OUTSIDE, shapeOf } from './shapes.js'

/** ✕ (exclusivo) e ✛ (paralelo) — SVG inline, nítido em qualquer zoom. */
function GateMark({ kind }: { kind: string }): JSX.Element {
  const parallel = kind === 'gateway-parallel'
  return (
    <svg className="mk mk-gate" viewBox="0 0 24 24" aria-hidden>
      <path d={parallel ? 'M12 5 L12 19 M5 12 L19 12' : 'M6 6 L18 18 M18 6 L6 18'} />
    </svg>
  )
}

/** [+] do subprocesso, no rodapé da caixa — igual ao MARK_SUB do antigo. */
function SubMark(): JSX.Element {
  return (
    <svg className="mk mk-sub" viewBox="0 0 24 24" aria-hidden>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M12 8 L12 16 M8 12 L16 12" />
    </svg>
  )
}

/**
 * Os 4 nozinhos de conexão (`app.js:1031`). Cada lado tem um handle de SAÍDA e um
 * de ENTRADA sobrepostos, porque no FlowForge qualquer lado liga em qualquer
 * lado — e é o id do handle que vira `sourceSide`/`targetSide` no arquivo.
 * Ficam invisíveis até o mouse passar no nó; arrastar o corpo continua movendo.
 */
export const SIDES: { side: Side; pos: Position }[] = [
  { side: 'top', pos: Position.Top },
  { side: 'right', pos: Position.Right },
  { side: 'bottom', pos: Position.Bottom },
  { side: 'left', pos: Position.Left }
]

/** `s-right` → `right`. Devolve undefined pro handle sem lado (ER, mind). */
export function sideOfHandle(handleId?: string | null): Side | undefined {
  if (!handleId) return undefined
  const s = handleId.slice(2)
  return s === 'top' || s === 'right' || s === 'bottom' || s === 'left' ? s : undefined
}

export interface FlowNodeData {
  node: DNode
  busy?: boolean
  lanes?: Lane[]
  cardOpen?: boolean
  onCardPersist: (id: string) => void
  onVerdict: (id: string, status: NodeStatus, reason?: string) => void
  onEdit: (id: string, patch: Partial<DNode>) => void
  [key: string]: unknown
}

export function FlowNode({ data, selected }: NodeProps): JSX.Element {
  const { node, onVerdict, onEdit, onCardPersist, busy, lanes, cardOpen } = data as FlowNodeData
  const sc = `var(${SC[node.status]})`
  const live = LIVE.has(node.status)
  const shape = shapeOf(node.kind)

  const cls = [
    'fnode',
    `shape-${shape}`,
    `kind-${node.kind}`,
    `st-${node.status}`,
    live ? 'live' : '',
    selected ? 'sel' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={cls} style={{ ['--sc' as string]: sc }}>
      {SIDES.map(({ side, pos }) => (
        <Fragment key={side}>
          <Handle type="target" position={pos} id={`t-${side}`} className="fh fh-t" />
          <Handle type="source" position={pos} id={`s-${side}`} className="fh fh-s" />
        </Fragment>
      ))}

      {DIAMONDISH.has(shape) && <span className="fnode-di" aria-hidden />}
      {shape === 'gate' && <GateMark kind={node.kind} />}
      {shape === 'subprocess' && <SubMark />}

      {BOXY.has(shape) ? (
        <>
          <div className="nn-head">
            <span className="dot" />
            <span className="nn-label">{node.label}</span>
            <span className="badge neon-mono">{STLBL[node.status]}</span>
          </div>
          {node.description && <div className="nn-body neon-mono">{node.description}</div>}
        </>
      ) : LABEL_OUTSIDE.has(shape) ? (
        // evento/gateway: a forma fica vazia e o rótulo mora embaixo, fora dela
        <span className="nn-out">{node.label}</span>
      ) : (
        <div className="nn-center">
          {shape !== 'annotation' && <span className="dot" />}
          <span className="nn-label">{node.label}</span>
        </div>
      )}

      {cardOpen && (
        <NodeCard node={node} busy={busy} lanes={lanes} onVerdict={onVerdict} onEdit={onEdit} onPersist={onCardPersist} />
      )}
    </div>
  )
}
