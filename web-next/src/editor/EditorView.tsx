// ============================================================================
// EditorView — o canvas multi-lente. Porte do NEON
// (`app/packages/canvas/src/editor/EditorView.tsx`) com o que é NEON REMOVIDO:
//
//   · store zustand (`useNeon`) e `sendIn` → o workspace chega por PROPS, e o
//     patch sobe por callback. Quem fala com o servidor é o App (ws.ts).
//   · botão "Cravar plano" / `onCrave` → cravar é virar execução de agentes,
//     conceito do NEON. O FlowForge desenha e conversa; não executa.
//   · painel "cérebro de design" (DesignThought ao vivo) → no FlowForge o
//     equivalente é a conversa do `thread.json`, e ela mora no App.
//   · botão "← constelação" → não existem duas altitudes aqui.
//
// O que ficou (e é requisito): barra de 6 lentes, NodeCard (via FlowNode),
// "Aprovar tudo", HUD de contagem, layout por lente e arrastar de nós.
//
// LEI 7: com `busy` ligado o canvas é SÓ LEITURA — sem veredito, sem "Aprovar
// tudo" e sem arrastar (o antigo faz `cy.autolock(true)`; aqui é
// `draggable:false`). Ver/navegar/zoom continuam livres.
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react'
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type ReactFlowInstance
} from '@xyflow/react'
import type { DEdge, Diagram, DNode, Lane, ModelKey, NodeStatus, SeqModel, Workspace } from '../types.js'
import { FlowNode, sideOfHandle } from './FlowNode.js'
import { Palette } from './Palette.js'
import { LanesPanel } from './LanesPanel.js'
import { EntityNode } from './EntityNode.js'
import { MindNode } from './MindNode.js'
import { LaneNode } from './LaneNode.js'
import { OrthEdge } from './OrthEdge.js'
import { ErEdge } from './ErEdge.js'
import { MindEdge } from './MindEdge.js'
import { SequenceView } from './SequenceView.js'
import {
  layoutDiagram,
  nodeSize,
  orthRoute,
  radialLayout,
  swimlaneLayout,
  toSavedPoint,
  type LayoutResult
} from './layout.js'
import { applyVerdict, novaEdge, novoNode, propagateFrom } from './model.js'
import { LENSES, LENS_BY_KEY, type LensDef, type LensKey } from './lenses.js'

const STATUS_COLOR: Record<NodeStatus, string> = {
  proposed: 'oklch(0.58 0.02 258)',
  approved: 'oklch(0.8 0.16 162)',
  questioned: 'oklch(0.84 0.15 78)',
  rejected: 'oklch(0.7 0.19 22)'
}
const nodeTypes = { flow: FlowNode, entity: EntityNode, mind: MindNode, lane: LaneNode }
const edgeTypes = { orth: OrthEdge, er: ErEdge, mind: MindEdge }

type Pt = { x: number; y: number }

export interface EditorViewProps {
  /** O arquivo-verdade (`workspace.json`) já normalizado, vindo do WS. */
  workspace: Workspace
  /** Lente ativa — o estado mora no App (a topbar também fala dela). */
  lens: LensKey
  onLens: (l: LensKey) => void
  /** Trava do Claude pensando (lei 7). */
  busy?: boolean
  /** Sobe um modelo alterado pro servidor: `{type:'patch', lens, diagram}`. */
  onPatch: (lens: ModelKey, model: Diagram | SeqModel) => void
}

export function EditorView({ workspace, lens, onLens, busy = false, onPatch }: EditorViewProps): JSX.Element {
  const [data, setData] = useState<Workspace>(workspace)
  const [layout, setLayout] = useState<LayoutResult | null>(null)
  const [posOverride, setPosOverride] = useState<Record<string, Pt>>({})
  const movedRef = useRef<Set<string>>(new Set())

  // O arquivo-verdade é a fonte da verdade (lei 2): o que chega do servidor
  // SUBSTITUI o estado local — inclusive o eco do nosso próprio patch.
  useEffect(() => {
    setData(workspace)
  }, [workspace])

  const lensDef = LENS_BY_KEY[lens]
  const activeDiagram: Diagram | null = lensDef.model === 'seq' ? null : (data[lensDef.model] as Diagram)

  /**
   * Escreve um modelo: otimista na tela + patch no servidor (que reecoa o
   * arquivo e vira a verdade). O `mutate` roda FORA do updater do setState de
   * propósito — updater tem que ser puro, e o StrictMode o chama duas vezes;
   * mandar o patch de dentro dele mandaria dois patches por clique.
   */
  const writeModel = useCallback(
    (model: Exclude<ModelKey, 'seq'>, mutate: (d: Diagram) => Diagram) => {
      if (busy) return // lei 7
      const next = mutate(data[model])
      setData((d) => ({ ...d, [model]: next }))
      onPatch(model, next)
    },
    [busy, data, onPatch]
  )

  // APROVAR TUDO: promove todas as etapas `proposed` da lente atual a `approved`
  // num clique (com patch persistido) — sem clicar nó a nó.
  const proposedCount = useMemo(
    () => (activeDiagram ? activeDiagram.nodes.filter((n) => n.status === 'proposed').length : 0),
    [activeDiagram]
  )
  const approveAll = useCallback(() => {
    const model = lensDef.model
    if (model === 'seq') return
    writeModel(model, (dia) => {
      const mudaram = dia.nodes.filter((n) => n.status === 'proposed').map((n) => n.id)
      const nodes = dia.nodes.map((n) => (n.status === 'proposed' ? { ...n, status: 'approved' as NodeStatus } : n))
      return { ...dia, nodes, edges: propagateFrom(nodes, dia.edges, mudaram) }
    })
  }, [lensDef.model, writeModel])

  const actions =
    activeDiagram && proposedCount > 0 && !busy ? (
      <div className="neon-editor-actions">
        <button className="neon-approveall" onClick={approveAll} title="aprova todas as etapas propostas desta lente">
          ✓ Aprovar tudo · {proposedCount}
        </button>
      </div>
    ) : null

  // Assinatura do que MEXE NO LAYOUT. Inclui `x`/`y` porque o Claude move nó pelo
  // arquivo e o canvas tem que refletir sozinho (o loop vivo), e inclui `kind`,
  // rótulo, descrição e campos porque todos entram no `nodeSize`: mudar o rótulo
  // muda a largura, e com a posição ancorada no CENTRO isso desloca o canto.
  const structureKey = useMemo(() => {
    if (!activeDiagram) return 'seq'
    const nodes = activeDiagram.nodes
      .map((n) => `${n.id}@${n.x ?? '-'},${n.y ?? '-'}:${n.kind}:${n.label}:${n.description ?? ''}:${n.fields?.length ?? 0}`)
      .join(',')
    return lens + '|' + nodes + '|' + activeDiagram.edges.map((e) => e.id).join(',')
  }, [lens, activeDiagram])

  // (re)layout ao trocar de lente / estrutura — e zera as posições arrastadas
  useEffect(() => {
    if (!activeDiagram) {
      setLayout(null)
      return
    }
    movedRef.current = new Set()
    setPosOverride({})
    let alive = true
    computeLayout(lensDef, activeDiagram).then((l) => alive && setLayout(l))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey])

  const onVerdict = useCallback(
    (id: string, status: NodeStatus, reason?: string) => {
      const model = lensDef.model
      if (model === 'seq') return
      writeModel(model, (dia) => {
        const nodes = dia.nodes.map((n) => (n.id === id ? applyVerdict(n, status, reason) : n))
        return { ...dia, nodes, edges: propagateFrom(nodes, dia.edges, [id]) }
      })
    },
    [lensDef.model, writeModel]
  )

  // ------------------------------------------------------------------------
  // CRIAR · LIGAR · DELETAR (FF-005)
  // ------------------------------------------------------------------------

  const rfRef = useRef<ReactFlowInstance | null>(null)

  /**
   * Nasce um nó. A posição que chega é o CENTRO (é o que o arquivo guarda).
   *
   * Numa lente que não é dona da posição — a Swimlane — o nó nasce SEM `x`/`y`:
   * o `y` de lá é a banda da raia e o `x` é a ordem do elk, nenhum dos dois diz
   * onde a etapa fica no Fluxograma. Melhor deixar o elk decidir da próxima vez
   * (o FF-001 já sabe posicionar quem não tem posição) do que gravar um palpite.
   */
  const criarNode = useCallback(
    (kind: string, center: Pt | null) => {
      const model = lensDef.model
      if (busy || model === 'seq') return
      const node = novoNode(kind, center ?? { x: 0, y: 0 })
      if (!lensDef.savesPos || !center) {
        delete node.x
        delete node.y
      }
      writeModel(model, (dia) => ({ ...dia, nodes: [...dia.nodes, node] }))
    },
    [busy, lensDef, writeModel]
  )

  /** Converte um ponto da tela para coords do canvas (onde o mouse soltou). */
  const pontoDoEvento = useCallback((clientX: number, clientY: number): Pt | null => {
    const rf = rfRef.current
    return rf ? rf.screenToFlowPosition({ x: clientX, y: clientY }) : null
  }, [])

  const onDrop = useCallback(
    (evt: DragEvent) => {
      const kind = evt.dataTransfer.getData('text/flowforge-kind')
      if (!kind) return
      evt.preventDefault()
      criarNode(kind, pontoDoEvento(evt.clientX, evt.clientY))
    },
    [criarNode, pontoDoEvento]
  )
  const onDragOver = useCallback((evt: DragEvent) => {
    if (!evt.dataTransfer.types.includes('text/flowforge-kind')) return
    evt.preventDefault()
    evt.dataTransfer.dropEffect = 'copy'
  }, [])

  /**
   * Duplo-clique no VAZIO cria uma tarefa ali — o atalho de quem já sabe.
   * Só no vazio: dois cliques num nó (ou no card dele) não podem virar nó novo.
   */
  const onPaneDoubleClick = useCallback(
    (evt: MouseEvent) => {
      const alvo = evt.target as HTMLElement | null
      if (!alvo?.classList.contains('react-flow__pane')) return
      criarNode('task', pontoDoEvento(evt.clientX, evt.clientY))
    },
    [criarNode, pontoDoEvento]
  )

  /** Clique na paleta (sem arrastar): põe no meio do que está à vista. */
  const criarNoCentro = useCallback(
    (kind: string) => {
      const rf = rfRef.current
      if (!rf) return criarNode(kind, null)
      const { x, y, zoom } = rf.getViewport()
      const el = document.querySelector('.neon-editor .react-flow')
      const r = el?.getBoundingClientRect()
      const cx = r ? r.width / 2 : 400
      const cy = r ? r.height / 2 : 300
      criarNode(kind, { x: (cx - x) / zoom, y: (cy - y) / zoom })
    },
    [criarNode]
  )

  /**
   * Liga dois nós. O id do handle carrega o lado (`s-right` → `right`), e é ele
   * que vira `sourceSide`/`targetSide` no arquivo — o mesmo campo que o editor
   * antigo grava, e que 54 pontas dos diagramas reais já usam.
   */
  const onConnect = useCallback(
    (c: Connection) => {
      const model = lensDef.model
      if (busy || model === 'seq' || !c.source || !c.target) return
      if (c.source === c.target) return // laço em si mesmo não desenha nada útil
      writeModel(model, (dia) => {
        const jaExiste = dia.edges.some((e) => e.source === c.source && e.target === c.target)
        if (jaExiste) return dia
        const edge = novaEdge(c.source!, c.target!, sideOfHandle(c.sourceHandle), sideOfHandle(c.targetHandle))
        // a aresta nasce já com o consenso das suas próprias pontas
        return { ...dia, edges: propagateFrom(dia.nodes, [...dia.edges, edge], [c.source!, c.target!]) }
      })
    },
    [busy, lensDef.model, writeModel]
  )

  /** Del/Backspace num nó: o nó sai e leva junto as arestas penduradas nele. */
  const onNodesDelete = useCallback(
    (nodes: Node[]) => {
      const model = lensDef.model
      if (busy || model === 'seq') return
      const ids = new Set(nodes.map((n) => n.id).filter((id) => !id.startsWith('lane_')))
      if (!ids.size) return
      writeModel(model, (dia) => ({
        ...dia,
        nodes: dia.nodes.filter((n) => !ids.has(n.id)),
        edges: dia.edges.filter((e) => !ids.has(e.source) && !ids.has(e.target))
      }))
    },
    [busy, lensDef.model, writeModel]
  )

  /**
   * Raias. Quando uma raia some, os nós dela perdem o `lane` em vez de sumirem
   * junto — apagar trabalho por tabela seria pior que uma raia órfã.
   */
  const onLanesChange = useCallback(
    (lanes: Lane[], removida?: string) => {
      const model = lensDef.model
      if (model === 'seq') return
      writeModel(model, (dia) => ({
        ...dia,
        lanes,
        nodes: removida ? dia.nodes.map((n) => (n.lane === removida ? { ...n, lane: undefined } : n)) : dia.nodes
      }))
    },
    [lensDef.model, writeModel]
  )

  /** Campos da seta (rótulo, status próprio, cardinalidade ER) — do EdgeCard. */
  const onEdgeEdit = useCallback(
    (id: string, patch: Partial<DEdge>) => {
      const model = lensDef.model
      if (model === 'seq') return
      writeModel(model, (dia) => ({
        ...dia,
        edges: dia.edges.map((e) => {
          if (e.id !== id) return e
          const next = { ...e, ...patch }
          // cardinalidade "—" limpa o campo em vez de gravar string vazia
          if (patch.sourceCard === undefined && 'sourceCard' in patch) delete next.sourceCard
          if (patch.targetCard === undefined && 'targetCard' in patch) delete next.targetCard
          return next
        })
      }))
    },
    [lensDef.model, writeModel]
  )

  const onEdgeDeleteOne = useCallback(
    (id: string) => {
      const model = lensDef.model
      if (model === 'seq') return
      writeModel(model, (dia) => ({ ...dia, edges: dia.edges.filter((e) => e.id !== id) }))
    },
    [lensDef.model, writeModel]
  )

  const onEdgesDelete = useCallback(
    (edges: Edge[]) => {
      const model = lensDef.model
      if (busy || model === 'seq') return
      const ids = new Set(edges.map((e) => e.id))
      writeModel(model, (dia) => ({ ...dia, edges: dia.edges.filter((e) => !ids.has(e.id)) }))
    },
    [busy, lensDef.model, writeModel]
  )

  /**
   * Edição de campo do nó (rótulo, kind, descrição, notas) vinda do NodeCard.
   * Já chega commitada — o card só chama isto no blur/Enter, nunca por tecla.
   */
  const onEditNode = useCallback(
    (id: string, patch: Partial<DNode>) => {
      const model = lensDef.model
      if (model === 'seq') return
      writeModel(model, (dia) => ({
        ...dia,
        nodes: dia.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n))
      }))
    },
    [lensDef.model, writeModel]
  )

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setPosOverride((prev) => {
      let next = prev
      for (const c of changes) {
        if (c.type === 'position' && c.position) {
          if (next === prev) next = { ...prev }
          next[c.id] = c.position
          movedRef.current.add(c.id)
        }
      }
      return next
    })
  }, [])

  const branch = useMemo(() => (lens === 'mind' && activeDiagram ? branchMap(activeDiagram) : {}), [lens, activeDiagram])
  const posOf = useCallback(
    (id: string): Pt => posOverride[id] ?? layout?.positions[id] ?? { x: 0, y: 0 },
    [posOverride, layout]
  )

  /**
   * Soltou o nó → o desenho vira arquivo (lei 2).
   *
   * Grava a posição de TODOS os nós, não só a do que foi arrastado — é o que o
   * editor antigo faz (`app.js:374`) e é o que dá estabilidade: no primeiro
   * arrasto o layout do elk se materializa no `workspace.json` e, da próxima vez
   * que a sessão abrir, o diagrama volta idêntico em vez de ser recalculado.
   *
   * Na Swimlane não grava nada: ela divide o `x`/`y` com o Fluxograma e é lente
   * derivada (`savesPos: false`) — arrastar lá vale só enquanto a aba está aberta.
   */
  const onNodeDragStop = useCallback(
    (_evt: unknown, _node: Node, dragged?: Node[]) => {
      const model = lensDef.model
      if (!lensDef.savesPos || model === 'seq' || !activeDiagram) return
      const moved = (dragged?.length ? dragged : [_node]).filter((n): n is Node => !!n && !n.id.startsWith('lane_'))
      if (!moved.length) return
      const byId = new Map(moved.map((n) => [n.id, n.position]))
      writeModel(model, (dia) => ({
        ...dia,
        nodes: dia.nodes.map((n) => {
          // canto (React Flow) → centro (o que o arquivo guarda). Ver `savedPositions`.
          const p = toSavedPoint(byId.get(n.id) ?? posOf(n.id), layout ? sizeOf(layout, n.id) : nodeSize(n))
          return { ...n, x: p.x, y: p.y }
        })
      }))
    },
    [lensDef, activeDiagram, writeModel, posOf, layout]
  )

  const rfNodes: Node[] = useMemo(() => {
    if (!layout || !activeDiagram) return []
    const out: Node[] = []
    // bandas de raia (swimlane) — atrás de tudo
    if (lens === 'swimlane' && layout.lanes) {
      const maxRight = Math.max(
        0,
        ...activeDiagram.nodes.map((n) => (layout.positions[n.id]?.x ?? 0) + (layout.sizes[n.id]?.width ?? 0))
      )
      for (const b of layout.lanes) {
        out.push({
          id: 'lane_' + b.id,
          type: 'lane',
          position: { x: -20, y: b.y },
          data: { label: b.label, width: maxRight + 60, height: b.height },
          draggable: false,
          selectable: false,
          zIndex: 0
        })
      }
    }
    for (const n of activeDiagram.nodes) {
      const s = layout.sizes[n.id]
      out.push({
        id: n.id,
        type: lensDef.nodeType,
        position: posOf(n.id),
        width: s?.width,
        height: s?.height,
        style: s ? { width: s.width, height: s.height } : undefined,
        draggable: !busy, // lei 7: modo leitura não arrasta
        zIndex: 1,
        data:
          lensDef.nodeType === 'mind'
            ? { node: n, busy, onVerdict, onEdit: onEditNode, branch: branch[n.id] ?? 0, isRoot: branch[n.id] === -1 }
            : { node: n, busy, lanes: activeDiagram.lanes ?? [], onVerdict, onEdit: onEditNode }
      })
    }
    return out
  }, [layout, activeDiagram, lens, lensDef.nodeType, onVerdict, branch, posOf, busy])

  const rfEdges: Edge[] = useMemo(() => {
    if (!layout || !activeDiagram) return []
    return activeDiagram.edges.map((e) => {
      const moved = movedRef.current.has(e.source) || movedRef.current.has(e.target)
      const points = moved
        ? orthRoute(
            posOf(e.source),
            sizeOf(layout, e.source),
            posOf(e.target),
            sizeOf(layout, e.target),
            e.sourceSide,
            e.targetSide
          )
        : layout.edgePoints[e.id]
      const base = {
        id: e.id,
        source: e.source,
        target: e.target,
        type: lensDef.edgeType,
        data: {
          points,
          status: e.status,
          label: e.label,
          edge: e,
          busy,
          onEdgeEdit,
          onEdgeDelete: onEdgeDeleteOne
        } as Record<string, unknown>
      }
      if (lensDef.edgeType === 'orth') return { ...base, markerEnd: `url(#neon-arrow-${e.status})` }
      if (lensDef.edgeType === 'er') return { ...base, data: { ...base.data, sourceCard: e.sourceCard, targetCard: e.targetCard } }
      if (lensDef.edgeType === 'mind') return { ...base, data: { points, branch: branch[e.target] ?? 0 } }
      return base
    })
  }, [layout, activeDiagram, lensDef.edgeType, branch, posOf, posOverride, busy, onEdgeEdit, onEdgeDeleteOne])

  const shell = 'neon-editor' + (busy ? ' ro' : '')

  if (lensDef.layout === 'seq') {
    return (
      <div className={shell}>
        <LensBar lens={lens} onLens={onLens} />
        <SequenceView model={data.seq} />
      </div>
    )
  }

  const counts = activeDiagram ? tally(activeDiagram) : null

  return (
    <div className={shell} onDrop={onDrop} onDragOver={onDragOver}>
      <LensBar lens={lens} onLens={onLens} />
      <Palette busy={busy} onPick={criarNoCentro} />
      {lens === 'swimlane' && activeDiagram && (
        <LanesPanel lanes={activeDiagram.lanes ?? []} busy={busy} onChange={onLanesChange} />
      )}
      {actions}
      {layout?.noLanes && (
        <div className="lanes-empty neon-mono" role="status">
          <b>sem raias definidas</b> — este diagrama não tem <code>lanes</code>, então o fluxo aparece sem bandas.
        </div>
      )}
      <MarkerDefs />
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        onInit={(rf) => (rfRef.current = rf)}
        onConnect={onConnect}
        onNodesDelete={onNodesDelete}
        onEdgesDelete={onEdgesDelete}
        onDoubleClick={onPaneDoubleClick}
        // Del e Backspace apagam; com `busy` ninguém apaga nada (lei 7)
        deleteKeyCode={busy ? null : ['Delete', 'Backspace']}
        nodesConnectable={!busy}
        elementsSelectable
        fitView
        proOptions={{ hideAttribution: true }}
        minZoom={0.15}
      >
        <Background color="oklch(0.30 0.02 258 / .35)" gap={26} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable nodeColor={() => 'oklch(0.4 0.03 258)'} maskColor="oklch(0.12 0.02 258 / .7)" />
      </ReactFlow>

      {counts && (
        <div className="neon-editor-hud neon-mono">
          <span className="t">{activeDiagram!.title}</span>
          <span className="c ap">{counts.approved} aprovados</span>
          <span className="c qu">{counts.questioned} questionados</span>
          <span className="c no">{counts.rejected} reprovados</span>
          <span className="c pr">{counts.proposed} propostos</span>
        </div>
      )}
    </div>
  )
}

function LensBar({ lens, onLens }: { lens: LensKey; onLens: (l: LensKey) => void }): JSX.Element {
  return (
    <div className="lensbar neon-mono">
      <span className="lensbar-lbl">lente</span>
      {LENSES.map((l: LensDef) => (
        <button key={l.key} className={l.key === lens ? 'on' : ''} onClick={() => onLens(l.key)}>
          {l.label}
        </button>
      ))}
    </div>
  )
}

async function computeLayout(lensDef: LensDef, diagram: Diagram): Promise<LayoutResult> {
  switch (lensDef.layout) {
    case 'swimlane':
      return swimlaneLayout(diagram)
    case 'er':
      return layoutDiagram(diagram, 'RIGHT', 110)
    case 'radial':
      return radialLayout(diagram)
    default:
      return layoutDiagram(diagram, 'DOWN', 70)
  }
}

/** Tamanho do nó no layout, com um fallback pra aresta não sumir se faltar. */
function sizeOf(layout: LayoutResult, id: string): { width: number; height: number } {
  return layout.sizes[id] ?? { width: 180, height: 60 }
}

/** Ramo (cor) por nó no mind map: filhos da raiz = 0,1,2…; descendentes herdam. */
function branchMap(diagram: Diagram): Record<string, number> {
  const targets = new Set(diagram.edges.map((e) => e.target))
  const root = diagram.nodes.find((n) => !targets.has(n.id))
  const children: Record<string, string[]> = {}
  for (const e of diagram.edges) (children[e.source] ??= []).push(e.target)
  const out: Record<string, number> = {}
  if (!root) return out
  out[root.id] = -1
  ;(children[root.id] ?? []).forEach((c, i) => {
    const walk = (id: string): void => {
      out[id] = i
      for (const ch of children[id] ?? []) walk(ch)
    }
    walk(c)
  })
  return out
}

function tally(d: Diagram): Record<NodeStatus, number> {
  const r: Record<NodeStatus, number> = { proposed: 0, approved: 0, questioned: 0, rejected: 0 }
  for (const n of d.nodes) r[n.status]++
  return r
}

function MarkerDefs(): JSX.Element {
  return (
    <svg style={{ position: 'absolute', width: 0, height: 0 }} aria-hidden>
      <defs>
        {(Object.keys(STATUS_COLOR) as NodeStatus[]).map((s) => (
          <marker
            key={s}
            id={`neon-arrow-${s}`}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={STATUS_COLOR[s]} />
          </marker>
        ))}
      </defs>
    </svg>
  )
}
