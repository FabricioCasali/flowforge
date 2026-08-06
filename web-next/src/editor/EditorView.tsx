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
  type EdgeChange,
  type NodeChange,
  type ReactFlowInstance
} from '@xyflow/react'
import type { DEdge, Diagram, DNode, Lane, ModelKey, NodeStatus, Pt, SeqModel, Workspace } from '../types.js'
import { FlowNode, sideOfHandle } from './FlowNode.js'
import { Palette } from './Palette.js'
import { LanesPanel } from './LanesPanel.js'
import { Toolbar } from './Toolbar.js'
import { EntityNode } from './EntityNode.js'
import { MindNode } from './MindNode.js'
import { LaneNode } from './LaneNode.js'
import { OrthEdge } from './OrthEdge.js'
import { ErEdge } from './ErEdge.js'
import { MindEdge } from './MindEdge.js'
import { SequenceView } from './SequenceView.js'
import {
  layoutDiagram,
  namedLayout,
  nodeSize,
  orthRoute,
  radialLayout,
  swimlaneLayout,
  toSavedPoint,
  type LayoutNome,
  type LayoutResult
} from './layout.js'
import { baixarPng, baixarTexto, nomeSeguro, toMermaid, toSvg } from './export.js'
import { applyVerdict, diffNodes, novaEdge, novoNode, propagateFrom } from './model.js'
import { LENSES, LENS_BY_KEY, type LensDef, type LensKey } from './lenses.js'

const nodeTypes = { flow: FlowNode, entity: EntityNode, mind: MindNode, lane: LaneNode }
const edgeTypes = { orth: OrthEdge, er: ErEdge, mind: MindEdge }

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

  // O QUE O CLAUDE MUDOU (FF-007). Num diagrama de 22 nós, "o Claude respondeu"
  // não serve de nada se você tem que caçar o que mudou. Guarda a assinatura de
  // cada nó e, quando chega escrita com `updatedBy:'claude'`, marca o que é novo
  // ou diferente e oferece o salto.
  const [mudados, setMudados] = useState<Record<string, Set<string>>>({})
  const anteriorRef = useRef<Workspace | null>(null)

  // O arquivo-verdade é a fonte da verdade (lei 2): o que chega do servidor
  // SUBSTITUI o estado local — inclusive o eco do nosso próprio patch.
  useEffect(() => {
    const anterior = anteriorRef.current
    anteriorRef.current = workspace
    setData(workspace)
    if (!anterior || workspace.updatedBy !== 'claude' || workspace.rev === anterior.rev) return
    const porModelo: Record<string, Set<string>> = {}
    for (const m of ['process', 'state', 'er', 'mind'] as const) {
      const ids = diffNodes(anterior[m], workspace[m])
      if (ids.size) porModelo[m] = ids
    }
    setMudados(porModelo)
  }, [workspace])

  // trocar de lente limpa o realce da lente anterior
  const limparMudados = useCallback(() => setMudados({}), [])

  const lensDef = LENS_BY_KEY[lens]
  const activeDiagram: Diagram | null = lensDef.model === 'seq' ? null : (data[lensDef.model] as Diagram)
  /** O que o Claude mexeu NA LENTE ATUAL (o realce e o toast leem daqui). */
  const mudadosAqui = mudados[lensDef.model] ?? null

  /**
   * Escreve um modelo: otimista na tela + patch no servidor (que reecoa o
   * arquivo e vira a verdade). O `mutate` roda FORA do updater do setState de
   * propósito — updater tem que ser puro, e o StrictMode o chama duas vezes;
   * mandar o patch de dentro dele mandaria dois patches por clique.
   */
  // ---- histórico (FF-007): 20 níveis, como no editor antigo ----
  // Guarda o modelo ANTES de cada escrita, junto com a lente — desfazer numa
  // lente não pode escrever noutra. Não guarda o eco do servidor: histórico é
  // do que EU fiz, e o que o Claude escreve não é meu pra desfazer.
  const undoRef = useRef<{ model: Exclude<ModelKey, 'seq'>; antes: Diagram }[]>([])
  const redoRef = useRef<{ model: Exclude<ModelKey, 'seq'>; antes: Diagram }[]>([])
  // as pilhas moram em ref (não precisam re-renderizar), mas os BOTÕES precisam
  // saber se estão vivos — daí este par de contadores em state
  const [hist, setHist] = useState({ undo: 0, redo: 0 })
  const marcaHist = useCallback(() => setHist({ undo: undoRef.current.length, redo: redoRef.current.length }), [])
  const MAX_HIST = 20

  const aplica = useCallback(
    (model: Exclude<ModelKey, 'seq'>, next: Diagram) => {
      setData((d) => ({ ...d, [model]: next }))
      onPatch(model, next)
    },
    [onPatch]
  )

  const writeModel = useCallback(
    (model: Exclude<ModelKey, 'seq'>, mutate: (d: Diagram) => Diagram) => {
      if (busy) return // lei 7
      const antes = data[model]
      const next = mutate(antes)
      if (next === antes) return // mutate desistiu (ex: aresta duplicada)
      undoRef.current.push({ model, antes })
      if (undoRef.current.length > MAX_HIST) undoRef.current.shift()
      redoRef.current = [] // ramo novo: o que estava pra frente morreu
      marcaHist()
      aplica(model, next)
    },
    [busy, data, aplica, marcaHist]
  )

  const desfazer = useCallback(() => {
    if (busy) return
    const passo = undoRef.current.pop()
    if (!passo) return
    redoRef.current.push({ model: passo.model, antes: data[passo.model] })
    marcaHist()
    aplica(passo.model, passo.antes)
  }, [busy, data, aplica, marcaHist])

  const refazer = useCallback(() => {
    if (busy) return
    const passo = redoRef.current.pop()
    if (!passo) return
    undoRef.current.push({ model: passo.model, antes: data[passo.model] })
    marcaHist()
    aplica(passo.model, passo.antes)
  }, [busy, data, aplica, marcaHist])

  useEffect(() => {
    const tecla = (e: globalThis.KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      const alvo = e.target as HTMLElement | null
      // dentro de campo de texto, Ctrl+Z é do campo, não do diagrama
      if (alvo && /^(INPUT|TEXTAREA|SELECT)$/.test(alvo.tagName)) return
      if (e.key.toLowerCase() !== 'z') return
      e.preventDefault()
      if (e.shiftKey) refazer()
      else desfazer()
    }
    window.addEventListener('keydown', tecla)
    return () => window.removeEventListener('keydown', tecla)
  }, [desfazer, refazer])

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

  /**
   * Quebras manuais da aresta (FF-011). Grava `routing:'segments'` junto, como o
   * editor antigo — e LIMPA os dois quando a última quebra sai, senão sobraria
   * um `routing` órfão dizendo que há quebras que não existem mais.
   */
  const onEdgeWaypoints = useCallback(
    (id: string, wps: Pt[]) => {
      const model = lensDef.model
      if (busy || model === 'seq') return
      writeModel(model, (dia) => ({
        ...dia,
        edges: dia.edges.map((e) => {
          if (e.id !== id) return e
          const next = { ...e }
          if (wps.length) {
            next.waypoints = wps
            next.routing = 'segments'
          } else {
            delete next.waypoints
            delete next.routing
          }
          return next
        })
      }))
    },
    [busy, lensDef.model, writeModel]
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

  /**
   * SELEÇÃO — precisa morar aqui, e isso não é detalhe.
   *
   * Os nós do React Flow são remontados a cada render a partir do arquivo. O
   * React Flow avisa a seleção por `onNodesChange` ({type:'select'}); se a gente
   * ignorar, o `selected` volta a `false` no render seguinte — o card do nó
   * abria no clique e sumia no piscar de olhos. Guardar os ids selecionados é o
   * que faz o card FICAR aberto.
   */
  const [sel, setSel] = useState<{ nodes: Set<string>; edges: Set<string> }>({
    nodes: new Set(),
    edges: new Set()
  })

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    let mexeuSel = false
    const selNext = new Set<string>()
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
    for (const c of changes) {
      if (c.type === 'select') {
        mexeuSel = true
        if (c.selected) selNext.add(c.id)
      }
    }
    if (mexeuSel) {
      setSel((s) => {
        const nodes = new Set(s.nodes)
        for (const c of changes) {
          if (c.type !== 'select') continue
          if (c.selected) nodes.add(c.id)
          else nodes.delete(c.id)
        }
        return { nodes, edges: s.edges }
      })
    }
  }, [])

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    if (!changes.some((c) => c.type === 'select')) return
    setSel((s) => {
      const edges = new Set(s.edges)
      for (const c of changes) {
        if (c.type !== 'select') continue
        if (c.selected) edges.add(c.id)
        else edges.delete(c.id)
      }
      return { nodes: s.nodes, edges }
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
        className: mudadosAqui?.has(n.id) ? 'ff-changed' : undefined,
        selected: sel.nodes.has(n.id),
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
  }, [layout, activeDiagram, lens, lensDef.nodeType, onVerdict, onEditNode, branch, posOf, busy, mudadosAqui, sel.nodes])

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
        selected: sel.edges.has(e.id),
        data: {
          points,
          status: e.status,
          label: e.label,
          edge: e,
          busy,
          onEdgeEdit,
          onEdgeDelete: onEdgeDeleteOne,
          onEdgeWaypoints
        } as Record<string, unknown>
      }
      if (lensDef.edgeType === 'er') return { ...base, data: { ...base.data, sourceCard: e.sourceCard, targetCard: e.targetCard } }
      if (lensDef.edgeType === 'mind') return { ...base, data: { points, branch: branch[e.target] ?? 0 } }
      return base
    })
  }, [layout, activeDiagram, lensDef.edgeType, branch, posOf, posOverride, busy, onEdgeEdit, onEdgeDeleteOne, onEdgeWaypoints, sel.edges])

  // ------------------------------------------------------------------------
  // FERRAMENTAS (FF-007)
  // ------------------------------------------------------------------------

  /** Centraliza um nó — usado pela busca e pelo salto do toast do Claude. */
  const saltarPara = useCallback(
    (id: string) => {
      const rf = rfRef.current
      if (!rf) return
      const p = posOf(id)
      const s = layout ? sizeOf(layout, id) : { width: 180, height: 60 }
      rf.setCenter(p.x + s.width / 2, p.y + s.height / 2, { zoom: Math.max(rf.getZoom(), 0.85), duration: 420 })
    },
    [posOf, layout]
  )

  /**
   * Arranjo nomeado: recalcula ignorando o desenho salvo e GRAVA o resultado.
   * Gravar é o ponto — sem isso o arranjo duraria até o próximo reload, já que
   * o FF-001 faz o arquivo mandar na geometria.
   */
  const aplicarArranjo = useCallback(
    async (nome: LayoutNome) => {
      const model = lensDef.model
      if (busy || model === 'seq' || !activeDiagram || !lensDef.savesPos) return
      const res = await namedLayout(activeDiagram, nome)
      writeModel(model, (dia) => ({
        ...dia,
        nodes: dia.nodes.map((n) => {
          const p = res.positions[n.id]
          const s = res.sizes[n.id]
          if (!p || !s) return n
          const c = toSavedPoint(p, s)
          return { ...n, x: c.x, y: c.y }
        })
      }))
    },
    [busy, lensDef, activeDiagram, writeModel]
  )

  const exportar = useCallback(
    async (formato: 'png' | 'svg' | 'mmd') => {
      if (!activeDiagram || !layout) return
      const nome = nomeSeguro(activeDiagram.title)
      if (formato === 'mmd') return baixarTexto(nome + '.mmd', toMermaid(activeDiagram))
      const svg = toSvg(activeDiagram, layout)
      if (formato === 'svg') return baixarTexto(nome + '.svg', svg, 'image/svg+xml;charset=utf-8')
      await baixarPng(nome + '.png', svg)
    },
    [activeDiagram, layout]
  )


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
      {activeDiagram && (
        <Toolbar
          nodes={activeDiagram.nodes}
          busy={busy}
          podeDesfazer={hist.undo > 0}
          podeRefazer={hist.redo > 0}
          onDesfazer={desfazer}
          onRefazer={refazer}
          onArranjo={aplicarArranjo}
          onSaltar={saltarPara}
          onExport={exportar}
        />
      )}
      {mudadosAqui && mudadosAqui.size > 0 && (
        <div className="change-toast neon-mono" role="status">
          <span className="ct-dot" />o Claude mexeu em {mudadosAqui.size}{' '}
          {mudadosAqui.size === 1 ? 'etapa' : 'etapas'}
          <button className="ct-ir" onClick={() => saltarPara([...mudadosAqui][0]!)}>
            ver ↷
          </button>
          <button className="ct-x" title="dispensar" onClick={limparMudados}>
            ✕
          </button>
        </div>
      )}
      {actions}
      {layout?.noLanes && (
        <div className="lanes-empty neon-mono" role="status">
          <b>sem raias definidas</b> — este diagrama não tem <code>lanes</code>, então o fluxo aparece sem bandas.
        </div>
      )}
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
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
