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
  ControlButton,
  Controls,
  MiniMap,
  ReactFlow,
  getViewportForBounds,
  type Connection,
  type Edge,
  type Node,
  type EdgeChange,
  type NodeChange,
  type ReactFlowInstance
} from '@xyflow/react'
import { emptyTasks } from '../types.js'
import type { ActivityEvent, DEdge, Diagram, DNode, Lane, ModelKey, NodeStatus, Pt, SeqModel, TasksFile, Workspace } from '../types.js'
import { FlowNode, sideOfHandle } from './FlowNode.js'
import { Palette } from './Palette.js'
import { LanesPanel } from './LanesPanel.js'
import { GuidePanel } from './GuidePanel.js'
import { Toolbar } from './Toolbar.js'
import { EntityNode } from './EntityNode.js'
import { MindNode } from './MindNode.js'
import { LaneNode } from './LaneNode.js'
import { OrthEdge } from './OrthEdge.js'
import { ErEdge } from './ErEdge.js'
import { MindEdge } from './MindEdge.js'
import { SequenceView } from './SequenceView.js'
import {
  labelPoint,
  labelRect,
  layoutDiagram,
  namedLayout,
  nodeSize,
  LAYOUTS,
  LAYOUTS_MIND,
  mindEdgePoints,
  mindLayout,
  routeAll,
  routeMoved,
  swimlaneLayout,
  toRect,
  toSavedPoint,
  type LayoutNome,
  type LayoutResult
} from './layout.js'
import { CardAbertoCtx, useCardAberto } from './useCardAberto.js'
import { useHistorico } from './useHistorico.js'
import { SC } from './status.js'
import { baixarPng, baixarTexto, nomeSeguro, toMermaid, toSvg } from './export.js'
import { applyVerdict, avisosDoFluxo, diffNodes, novaEdge, novoNode, propagateFrom } from './model.js'
import { shapeOf } from './shapes.js'
import { LENSES, LENS_BY_KEY, type LensDef, type LensKey } from './lenses.js'
import { contaTarefas, TasksView } from './TasksView.js'

const nodeTypes = { flow: FlowNode, entity: EntityNode, mind: MindNode, lane: LaneNode }
const edgeTypes = { orth: OrthEdge, er: ErEdge, mind: MindEdge }

export interface EditorViewProps {
  /** O arquivo-verdade (`workspace.json`) já normalizado, vindo do WS. */
  workspace: Workspace
  /** O `workspace` já é o do servidor (e não o marcador vazio da troca de sessão). */
  carregado?: boolean
  /** Lente ativa — o estado mora no App (a topbar também fala dela). */
  lens: LensKey
  onLens: (l: LensKey) => void
  /** Trava do agente trabalhando (lei 7). */
  busy?: boolean
  /** Sobe um modelo alterado pro servidor: `{type:'patch', lens, diagram}`. */
  onPatch: (lens: ModelKey, model: Diagram | SeqModel) => void
  /** Tarefas ao vivo do CLI (`tasks.json` do projeto) — a lente Tarefas e o placar da barra. */
  tasks?: TasksFile
  /** A linha do tempo do CLI (`activity.jsonl` do projeto) — coluna da lente Tarefas. */
  activity?: ActivityEvent[]
}

const SEM_TAREFAS = emptyTasks()
const SEM_ATIVIDADE: ActivityEvent[] = []

export function EditorView({ workspace, carregado = true, lens, onLens, busy = false, onPatch, tasks = SEM_TAREFAS, activity = SEM_ATIVIDADE }: EditorViewProps): JSX.Element {
  const [data, setData] = useState<Workspace>(workspace)
  const [layout, setLayout] = useState<LayoutResult | null>(null)
  const [posOverride, setPosOverride] = useState<Record<string, Pt>>({})
  const [arrastando, setArrastando] = useState(false)
  const movedRef = useRef<Set<string>>(new Set())

  // O QUE O AGENTE MUDOU (FF-007). Num diagrama de 22 nós, "o agente respondeu"
  // não serve de nada se você tem que caçar o que mudou. Guarda a assinatura de
  // cada nó e, quando chega escrita com `updatedBy:'agent'`, marca o que é novo
  // ou diferente e oferece o salto.
  const [mudados, setMudados] = useState<Record<string, Set<string>>>({})
  const anteriorRef = useRef<Workspace | null>(null)
  const jaCarregadoRef = useRef(false)

  // O arquivo-verdade é a fonte da verdade (lei 2): o que chega do servidor
  // SUBSTITUI o estado local — inclusive o eco do nosso próprio patch.
  useEffect(() => {
    const anterior = anteriorRef.current
    anteriorRef.current = workspace
    setData(workspace)
    // ABRIR uma sessão não é "o agente mexeu": o primeiro estado do servidor é
    // comparado com o marcador vazio, e sem esta trava toda sessão cuja última
    // escrita foi do agente abria com TODOS os nós realçados e o toast na tela.
    const primeiroEstado = !jaCarregadoRef.current
    jaCarregadoRef.current = carregado
    if (primeiroEstado) return
    if (!anterior || workspace.updatedBy !== 'agent' || workspace.rev === anterior.rev) return
    const porModelo: Record<string, Set<string>> = {}
    for (const m of ['process', 'state', 'er', 'mind'] as const) {
      const ids = diffNodes(anterior[m], workspace[m])
      if (ids.size) porModelo[m] = ids
    }
    setMudados(porModelo)
  }, [workspace, carregado])

  // trocar de lente limpa o realce da lente anterior
  const limparMudados = useCallback(() => setMudados({}), [])

  const lensDef = LENS_BY_KEY[lens]
  const activeDiagram: Diagram | null = lensDef.model === 'seq' ? null : (data[lensDef.model] as Diagram)
  /** O que o agente mexeu NA LENTE ATUAL (o realce e o toast leem daqui). */
  const mudadosAqui = mudados[lensDef.model] ?? null

  /**
   * MODO GUIADO (FF-015) — lembrado entre sessões: é preferência de leitura, não
   * estado do diagrama, então mora no localStorage e não no arquivo.
   */
  const [guiado, setGuiado] = useState(() => {
    try {
      return localStorage.getItem('ff-guiado') === '1'
    } catch {
      return false // navegador com storage bloqueado não pode derrubar o editor
    }
  })
  const alternaGuiado = useCallback(() => {
    setGuiado((v) => {
      try {
        localStorage.setItem('ff-guiado', v ? '0' : '1')
      } catch {
        /* sem storage: vale só nesta aba */
      }
      return !v
    })
  }, [])
  const guiaAberto = guiado && lensDef.guiado && !!activeDiagram

  const aplica = useCallback(
    (model: Exclude<ModelKey, 'seq'>, next: Diagram) => {
      setData((d) => ({ ...d, [model]: next }))
      onPatch(model, next)
    },
    [onPatch]
  )

  // desfazer/refazer (FF-007) — as pilhas e o Ctrl+Z moram em `useHistorico`
  const { registra, desfazer, refazer, podeDesfazer, podeRefazer } = useHistorico(data, busy, aplica)

  /**
   * Escreve um modelo: otimista na tela + patch no servidor (que reecoa o
   * arquivo e vira a verdade). O `mutate` roda FORA do updater do setState de
   * propósito — updater tem que ser puro, e o StrictMode o chama duas vezes;
   * mandar o patch de dentro dele mandaria dois patches por clique.
   */
  const writeModel = useCallback(
    (model: Exclude<ModelKey, 'seq'>, mutate: (d: Diagram) => Diagram) => {
      if (busy) return // lei 7
      const antes = data[model]
      const next = mutate(antes)
      if (next === antes) return // mutate desistiu (ex: aresta duplicada)
      registra(model, antes)
      aplica(model, next)
    },
    [busy, data, aplica, registra]
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

  // Assinatura do que MEXE NO LAYOUT. Inclui `x`/`y` porque o agente move nó pelo
  // arquivo e o canvas tem que refletir sozinho (o loop vivo), e inclui `kind`,
  // rótulo, descrição e campos porque todos entram no `nodeSize`: mudar o rótulo
  // muda a largura, e com a posição ancorada no CENTRO isso desloca o canto.
  const structureKey = useMemo(() => {
    if (!activeDiagram) return 'seq'
    const nodes = activeDiagram.nodes
      .map((n) => `${n.id}@${n.x ?? '-'},${n.y ?? '-'}:${n.kind}:${n.label}:${n.description ?? ''}:${n.fields?.length ?? 0}:${n.lane ?? ''}`)
      .join(',')
    const edges = activeDiagram.edges.map((e) => [e.id, e.source, e.target, e.sourceSide, e.targetSide, e.routing, e.waypoints])
    const lanes = (activeDiagram.lanes ?? []).map((l) => [l.id, l.order])
    return lens + '|' + nodes + '|' + JSON.stringify(edges) + '|' + JSON.stringify(lanes)
  }, [lens, activeDiagram])

  // (re)layout ao trocar de lente / estrutura — e zera as posições arrastadas
  useEffect(() => {
    if (!activeDiagram) {
      setLayout(null)
      return
    }
    movedRef.current = new Set()
    setPosOverride({})
    setArrastando(false)
    let alive = true
    computeLayout(lensDef, activeDiagram)
      .then((l) => alive && setLayout(l))
      // um layout que falha deixava o canvas parado no desenho ANTERIOR, sem dizer nada
      .catch((err) => console.error('[flowforge] layout falhou; o desenho anterior fica na tela', err))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey])

  /**
   * SOBREPOSIÇÃO: o layout afastou nós, e isso vai pro arquivo (exceção da lei 4).
   *
   * Grava uma vez e converge: o eco volta com as posições já separadas, o layout
   * recalcula, `ajustados` vem vazio e ninguém escreve de novo. Não roda em lente
   * derivada (Swimlane não é dona da posição) nem com `busy` (o writeModel barra).
   */
  const [afastados, setAfastados] = useState(0)
  useEffect(() => {
    const ids = layout?.ajustados
    if (!ids?.length || !lensDef.savesPos || lensDef.model === 'seq' || busy) return
    const alvo = new Set(ids)
    const model = lensDef.model
    writeModel(model, (dia) => ({
      ...dia,
      nodes: dia.nodes.map((n) => {
        if (!alvo.has(n.id)) return n
        const p = layout!.positions[n.id]
        const s = layout!.sizes[n.id]
        if (!p || !s) return n
        const c = toSavedPoint(p, s)
        return { ...n, x: c.x, y: c.y }
      })
    }))
    setAfastados(ids.length)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout])

  // o aviso some sozinho: é informação, não decisão
  useEffect(() => {
    if (!afastados) return
    const t = setTimeout(() => setAfastados(0), 6000)
    return () => clearTimeout(t)
  }, [afastados])

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

  // ------------------------------------------------------------------------
  // ENQUADRAMENTO e NÍVEL DE DETALHE
  // ------------------------------------------------------------------------

  /**
   * Paleta recolhida por padrão (só as silhuetas). Preferência de leitura, como
   * o guiado: mora no localStorage, não no arquivo.
   */
  const [paletaMini, setPaletaMini] = useState(() => {
    try {
      return localStorage.getItem('ff-paleta') !== 'aberta'
    } catch {
      return true
    }
  })
  const alternaPaleta = useCallback(() => {
    setPaletaMini((v) => {
      try {
        localStorage.setItem('ff-paleta', v ? 'aberta' : 'mini')
      } catch {
        /* sem storage: vale só nesta aba */
      }
      return !v
    })
  }, [])

  /**
   * A área do `.react-flow` NÃO é a área que se enxerga: barra de lentes e toolbar
   * cobrem o topo, a paleta cobre a esquerda e o HUD o rodapé. Enquadrar na área
   * inteira punha as anotações do topo atrás da barra e, na Swimlane, os rótulos
   * das raias atrás da paleta. A folga por lado desconta esses painéis.
   * `maxZoom: 1` porque diagrama pequeno não precisa ser AMPLIADO pra caber —
   * o `er-demo`, de 3 entidades, abria a 1,8× com caixas gigantes.
   */
  const enquadre = useMemo(() => {
    // em janela estreita a toolbar desce pra segunda linha (media query no
    // editor.css, mesmos cortes) e o topo coberto cresce junto
    const estreita = window.innerWidth <= (guiaAberto ? 1640 : 1330)
    return {
      padding: {
        top: estreita ? '112px' : '72px',
        right: '28px',
        bottom: '64px',
        left: paletaMini ? '84px' : '158px'
      } as const,
      maxZoom: 1
    }
  }, [paletaMini, guiaAberto])

  /**
   * LONGE = zoom em que descrição (10,5px) e badge (9px) já são mancha. Abaixo do
   * corte o nó mostra só o título, maior — a descrição continua no card e no
   * modo guiado. É classe no container: trocar de nível não refaz nó nenhum.
   */
  const ZOOM_LONGE = 0.62
  const [longe, setLonge] = useState(false)
  const medirZoom = useCallback((zoom: number) => setLonge(zoom < ZOOM_LONGE), [])

  /**
   * Enquadra quando o DESENHO troca (abrir sessão, trocar de lente) — nunca numa
   * edição, que tiraria a tela de baixo do mouse. O `fitView` do React Flow não
   * servia: ele roda na montagem, quando o layout (assíncrono) ainda não chegou
   * e não há nó nenhum pra enquadrar; o canvas abria num zoom arbitrário.
   */
  const enquadrarPendente = useRef(true)
  useEffect(() => {
    enquadrarPendente.current = true
  }, [lens])

  /**
   * Enquadra o DESENHO — nós E setas. O `fitView` do React Flow só olha os nós, e
   * num fluxo quebrado em colunas a seta que liga o pé de uma ao topo da outra
   * passa POR CIMA de todos eles: ficava cortada atrás da barra de lentes. De
   * quebra, calcular o viewport na mão não espera o React Flow medir os nós, que
   * é o que o deixava sem enquadrar em aba oculta.
   */
  const enquadrar = useCallback(() => {
    const rf = rfRef.current
    const area = document.querySelector('.neon-editor .react-flow')?.getBoundingClientRect()
    if (!rf || !area) return
    let x1 = Infinity
    let y1 = Infinity
    let x2 = -Infinity
    let y2 = -Infinity
    const inclui = (x: number, y: number): void => {
      x1 = Math.min(x1, x)
      y1 = Math.min(y1, y)
      x2 = Math.max(x2, x)
      y2 = Math.max(y2, y)
    }
    for (const n of rf.getNodes()) {
      inclui(n.position.x, n.position.y)
      // +22 embaixo: evento e gateway levam o rótulo FORA da forma
      inclui(n.position.x + (n.width ?? 0), n.position.y + (n.height ?? 0) + (n.type === 'lane' ? 0 : 22))
    }
    for (const e of rf.getEdges()) {
      for (const p of ((e.data as { points?: Pt[] } | undefined)?.points ?? [])) inclui(p.x, p.y)
    }
    if (!Number.isFinite(x1)) return
    const vp = getViewportForBounds(
      { x: x1, y: y1, width: Math.max(1, x2 - x1), height: Math.max(1, y2 - y1) },
      area.width,
      area.height,
      0.15,
      enquadre.maxZoom,
      enquadre.padding
    )
    void rf.setViewport(vp)
    medirZoom(vp.zoom)
  }, [enquadre, medirZoom])
  useEffect(() => {
    if (!enquadrarPendente.current || !layout || !Object.keys(layout.positions).length) return
    // um frame de espera: o React Flow precisa ter recebido os nós deste layout.
    // A pendência só é baixada DENTRO do frame — se o efeito for desmontado antes
    // (StrictMode, ou outro layout chegando logo atrás), o próximo tenta de novo.
    // Timer e não `requestAnimationFrame`: o Chrome PAUSA o rAF em aba oculta, e
    // sessão aberta em segundo plano ficava desenquadrada até alguém olhar pra ela.
    const espera = setTimeout(() => {
      const rf = rfRef.current
      if (!rf) return
      enquadrarPendente.current = false
      enquadrar()
    }, 40)
    return () => clearTimeout(espera)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout])

  // Abrir ou fechar o guia muda a ÁREA de desenho em 306px: sem reenquadrar, o
  // lado direito do diagrama ia parar atrás da conversa. É troca de modo de
  // leitura, não edição — aqui mexer na tela é o esperado.
  const guiaAnterior = useRef(guiaAberto)
  useEffect(() => {
    if (guiaAnterior.current === guiaAberto) return
    // a marca só é baixada quando o timer DISPARA (StrictMode desmonta o efeito antes)
    const espera = setTimeout(() => {
      guiaAnterior.current = guiaAberto
      enquadrar()
    }, 60)
    return () => clearTimeout(espera)
  }, [guiaAberto, enquadrar])

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
      // quem criou um nó escolheu onde olhar: o enquadramento automático não pode mais puxar a tela
      enquadrarPendente.current = false
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
   * ignorar, o `selected` volta a `false` no render seguinte. Guardar os ids é
   * o que mantém o realce do nó e a animação das suas ligações; o card tem um
   * ciclo próprio logo abaixo e não depende mais da seleção.
   */
  const [sel, setSel] = useState<{ nodes: Set<string>; edges: Set<string> }>({
    nodes: new Set(),
    edges: new Set()
  })

  // O ciclo do card (hover temporário, duplo clique persiste, clique fora fecha)
  // mora em `useCardAberto`. Quem está aberto chega aos nós por contexto.
  const { cardId, persistirCard, onNodeMouseEnter, onNodeMouseLeave, onNodeDoubleClick } = useCardAberto(lens)

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
  const onEdgeClick = useCallback((_event: MouseEvent, edge: Edge) => {
    setSel((s) => ({ nodes: s.nodes, edges: new Set([edge.id]) }))
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
      setArrastando(false)
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
  const onNodeDragStart = useCallback(() => setArrastando(true), [])

  const rfNodes: Node[] = useMemo(() => {
    if (!layout || !activeDiagram) return []
    const out: Node[] = []
    // bandas de raia (swimlane) — atrás de tudo
    if (lens === 'swimlane' && layout.lanes) {
      const maxRight = Math.max(
        0,
        ...activeDiagram.nodes.map((n) => posOf(n.id).x + (layout.sizes[n.id]?.width ?? 0))
      )
      for (const b of layout.lanes) {
        const width = maxRight + 60
        out.push({
          id: 'lane_' + b.id,
          type: 'lane',
          position: { x: -20, y: b.y },
          data: { label: b.label, width, height: b.height },
          width,
          height: b.height,
          style: { width, height: b.height },
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
        zIndex: 1, // o nó com card aberto sobe por CSS (`:has(.fpanel)`), sem refazer esta lista
        data:
          lensDef.nodeType === 'mind'
            ? {
                node: n,
                busy,
                onVerdict,
                onEdit: onEditNode,
                branch: branch[n.id] ?? 0,
                isRoot: branch[n.id] === -1,
                onCardPersist: persistirCard
              }
            : {
                node: n,
                busy,
                lanes: activeDiagram.lanes ?? [],
                onVerdict,
                onEdit: onEditNode,
                onCardPersist: persistirCard
              }
      })
    }
    return out
  }, [layout, activeDiagram, lens, lensDef.nodeType, onVerdict, onEditNode, branch, posOf, busy, mudadosAqui, sel.nodes, persistirCard])

  const currentEdgePoints = useMemo(() => {
    if (!layout || !activeDiagram || movedRef.current.size === 0) return layout?.edgePoints ?? {}
    const positions = { ...layout.positions, ...posOverride }
    // Mind map não passa pelo roteador ortogonal: a `MindEdge` é uma bézier entre
    // DOIS pontos, e a polilinha do `routeAll` virava um toco reto solto do nó.
    if (lensDef.edgeType === 'mind') return mindEdgePoints(activeDiagram, positions, layout.sizes)
    if (!arrastando) return routeAll(activeDiagram, positions, layout.sizes)

    // Durante o drag, A* em todas as arestas a cada pixel fazia a camada de
    // bandas/linhas piscar. Mantém as rotas estáveis e recalcula só as ligações
    // dos nós movidos com o L/Z barato; ao soltar, routeAll refaz o desvio final.
    return routeMoved(activeDiagram, positions, layout.sizes, movedRef.current, layout.edgePoints)
  }, [layout, activeDiagram, posOverride, arrastando, lensDef.edgeType])

  const rfEdges: Edge[] = useMemo(() => {
    if (!layout || !activeDiagram) return []
    // caixas dos nós ONDE ELES ESTÃO (arrasto incluso): o rótulo da seta foge delas
    const caixas = activeDiagram.nodes.flatMap((n) => {
      const s = layout.sizes[n.id]
      return s ? [toRect(posOf(n.id), s, 4)] : []
    })
    return activeDiagram.edges.map((e) => {
      const points = currentEdgePoints[e.id]
      const labelAt = e.label && points && points.length >= 2 ? labelPoint(points, e.label, caixas) : undefined
      if (labelAt && e.label) caixas.push(labelRect(labelAt, e.label)) // o próximo rótulo desvia deste
      const base = {
        id: e.id,
        source: e.source,
        target: e.target,
        type: lensDef.edgeType,
        animated: sel.nodes.has(e.source) || sel.nodes.has(e.target),
        selected: sel.edges.has(e.id),
        data: {
          points,
          status: e.status,
          label: e.label,
          labelAt,
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
  }, [layout, activeDiagram, lensDef.edgeType, branch, currentEdgePoints, busy, onEdgeEdit, onEdgeDeleteOne, onEdgeWaypoints, sel.nodes, sel.edges, posOf])

  // ------------------------------------------------------------------------
  // FERRAMENTAS (FF-007)
  // ------------------------------------------------------------------------

  /** Centraliza um nó — usado pela busca e pelo salto do toast do agente. */
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
        }),
        // Lado ancorado e quebra manual pertencem ao desenho ANTIGO: foram
        // escolhidos pra uma geometria que o arranjo acabou de jogar fora. Mantê-los
        // é o que fazia a seta sair pela esquerda pra chegar em quem foi parar à
        // direita. "Reorganiza isso pra mim" inclui as setas. (Ctrl+Z desfaz tudo.)
        edges: dia.edges.map((e) => {
          if (!e.sourceSide && !e.targetSide && !e.waypoints && !e.routing) return e
          const { sourceSide: _s, targetSide: _t, waypoints: _w, routing: _r, ...limpa } = e
          return limpa
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


  /** Cartão do guia → seleciona o nó, abre o card dele e voa até ele. */
  const irParaNo = useCallback(
    (id: string) => {
      setSel((s) => ({ nodes: new Set([id]), edges: s.edges }))
      persistirCard(id)
      saltarPara(id)
    },
    [persistirCard, saltarPara]
  )

  const shell = 'neon-editor' + (busy ? ' ro' : '') + (guiaAberto ? ' com-guia' : '') + (longe ? ' lod-longe' : '')

  if (lensDef.layout === 'tasks') {
    return (
      <div className={shell}>
        <LensBar lens={lens} onLens={onLens} guiado={guiado} podeGuiar={false} onGuiado={alternaGuiado} tarefas={tasks} />
        <TasksView tasks={tasks} activity={activity} />
      </div>
    )
  }

  if (lensDef.layout === 'seq') {
    return (
      <div className={shell}>
        <LensBar lens={lens} onLens={onLens} guiado={guiado} podeGuiar={false} onGuiado={alternaGuiado} tarefas={tasks} />
        <SequenceView model={data.seq} />
      </div>
    )
  }

  const counts = activeDiagram ? tally(activeDiagram) : null
  // início/fim/percurso só fazem sentido onde há PROCESSO (Fluxograma e Swimlane)
  const avisos =
    activeDiagram && lensDef.model === 'process'
      ? avisosDoFluxo(activeDiagram.nodes, activeDiagram.edges, (n) => shapeOf(n.kind) === 'annotation')
      : []

  return (
    <div className={shell} onDrop={onDrop} onDragOver={onDragOver}>
      <LensBar lens={lens} onLens={onLens} guiado={guiado} podeGuiar={lensDef.guiado} onGuiado={alternaGuiado} tarefas={tasks} />
      {guiaAberto && activeDiagram && (
        <GuidePanel
          nodes={activeDiagram.nodes}
          edges={activeDiagram.edges}
          selecionado={[...sel.nodes][0] ?? null}
          onIr={irParaNo}
          onFechar={alternaGuiado}
        />
      )}
      <Palette busy={busy} recolhida={paletaMini} onAlterna={alternaPaleta} onPick={criarNoCentro} />
      {lens === 'swimlane' && activeDiagram && (
        <LanesPanel lanes={activeDiagram.lanes ?? []} busy={busy} onChange={onLanesChange} />
      )}
      {activeDiagram && (
        <Toolbar
          nodes={activeDiagram.nodes}
          busy={busy}
          podeDesfazer={podeDesfazer}
          podeRefazer={podeRefazer}
          onDesfazer={desfazer}
          onRefazer={refazer}
          arranjos={lensDef.layout === 'mind' ? LAYOUTS_MIND : LAYOUTS}
          onArranjo={aplicarArranjo}
          onSaltar={saltarPara}
          onExport={exportar}
        />
      )}
      {afastados > 0 && (
        <div className="change-toast afasta neon-mono" role="status">
          <span className="ct-dot" />
          {afastados === 1 ? '1 nó foi afastado' : `${afastados} nós foram afastados`} para não
          ficarem um sobre o outro
          <button className="ct-x" title="ok" onClick={() => setAfastados(0)}>
            ✕
          </button>
        </div>
      )}
      {mudadosAqui && mudadosAqui.size > 0 && (
        <div className="change-toast neon-mono" role="status">
          <span className="ct-dot" />o agente mexeu em {mudadosAqui.size}{' '}
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
      {activeDiagram && activeDiagram.nodes.length === 0 && (
        <div className="canvas-vazio neon-mono" role="status">
          <b>{lensDef.label} ainda sem nada.</b>
          {busy ? ' O agente está trabalhando.' : ' Arraste uma forma da paleta, dê duplo-clique no vazio, ou peça pro agente em "Analisar".'}
        </div>
      )}
      <CardAbertoCtx.Provider value={cardId}>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onEdgeClick={onEdgeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onNodeMouseEnter={onNodeMouseEnter}
        onNodeMouseLeave={onNodeMouseLeave}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onInit={(rf) => (rfRef.current = rf)}
        onMove={(_evt, vp) => medirZoom(vp.zoom)}
        onConnect={onConnect}
        onNodesDelete={onNodesDelete}
        onEdgesDelete={onEdgesDelete}
        onDoubleClick={onPaneDoubleClick}
        // Del e Backspace apagam; com `busy` ninguém apaga nada (lei 7)
        deleteKeyCode={busy ? null : ['Delete', 'Backspace']}
        nodesConnectable={!busy}
        elementsSelectable
        proOptions={{ hideAttribution: true }}
        minZoom={0.15}
      >
        <Background color="oklch(0.30 0.02 258 / .35)" gap={26} />
        {/* O botão de enquadrar é NOSSO: o do React Flow chama o `fitView` dele (que
            ignora setas e painéis) e só depois avisa — os dois brigariam pelo viewport. */}
        <Controls showInteractive={false} showFitView={false}>
          <ControlButton className="react-flow__controls-fitview" onClick={enquadrar} title="enquadrar o desenho" aria-label="enquadrar o desenho">
            <svg viewBox="0 0 32 30" aria-hidden>
              <path d="M3.692 4.63c0-.53.4-.938.939-.938h5.215V0H4.708C2.13 0 0 2.054 0 4.63v5.216h3.692V4.631zM27.354 0h-5.2v3.692h5.17c.53 0 .984.4.984.939v5.215H32V4.631A4.624 4.624 0 0027.354 0zm.954 24.83c0 .532-.4.94-.939.94h-5.215v3.768h5.215c2.577 0 4.631-2.13 4.631-4.707v-5.139h-3.692v5.139zm-23.677.94c-.531 0-.939-.4-.939-.94v-5.138H0v5.139c0 2.577 2.13 4.707 4.708 4.707h5.138V25.77H4.631z" />
            </svg>
          </ControlButton>
        </Controls>
        {/* Na Swimlane o canto é do painel de raias. A cor por status é o que dá
            serventia ao minimapa: acha-se o questionado sem percorrer o desenho. */}
        {lens !== 'swimlane' && (
          <MiniMap
            pannable
            zoomable
            style={{ width: 148, height: 96 }}
            nodeColor={corNoMinimapa}
            nodeStrokeWidth={0}
            maskColor="oklch(0.12 0.02 258 / .7)"
          />
        )}
      </ReactFlow>
      </CardAbertoCtx.Provider>

      {counts && (
        <div className="neon-editor-hud neon-mono">
          <span className="t">{activeDiagram!.title}</span>
          <span className="c ap">{counts.approved} aprovados</span>
          <span className="c qu">{counts.questioned} questionados</span>
          <span className="c no">{counts.rejected} reprovados</span>
          <span className="c pr">{counts.proposed} propostos</span>
          {avisos.map((a) => (
            <span
              key={a.texto}
              className="c aviso"
              title={a.quem.length ? a.quem.join(' · ') : 'todo fluxograma precisa dizer onde começa e onde termina'}
            >
              ⚠ {a.texto}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/** Aprovado e proposto são o repouso (cinza); questionado e reprovado saltam. */
function corNoMinimapa(n: Node): string {
  if (n.type === 'lane') return 'transparent'
  const status = (n.data as { node?: DNode }).node?.status
  return status === 'questioned' || status === 'rejected' ? `var(${SC[status]})` : 'oklch(0.42 0.03 258)'
}

function LensBar({
  lens,
  onLens,
  guiado,
  podeGuiar,
  onGuiado,
  tarefas
}: {
  lens: LensKey
  onLens: (l: LensKey) => void
  guiado: boolean
  podeGuiar: boolean
  onGuiado: () => void
  tarefas: TasksFile
}): JSX.Element {
  // O placar mora NO BOTÃO da lente: é o que avisa, de dentro de um diagrama, que o
  // CLI está andando — sem abrir mais um painel em cima do desenho (FF-023).
  const placar = contaTarefas(tarefas)
  return (
    <div className="lensbar neon-mono">
      <span className="lensbar-lbl">lente</span>
      {LENSES.map((l: LensDef) => (
        <button key={l.key} className={l.key === lens ? 'on' : ''} onClick={() => onLens(l.key)}>
          {l.label}
          {l.key === 'tasks' && placar.total > 0 && (
            <span
              className={'lens-placar' + (placar.andando ? ' viva' : '') + (placar.travadas ? ' travada' : '')}
              title={`${placar.feitas} de ${placar.total} concluídas` + (placar.travadas ? ` · ${placar.travadas} travada(s)` : '')}
            >
              {placar.feitas}/{placar.total}
            </span>
          )}
        </button>
      ))}
      {/* o guiado é um modo de LER, então mora junto das lentes — mas separado,
          porque não é uma delas: é uma camada por cima da que estiver ativa */}
      <span className="lensbar-sep" />
      <button
        className={'lensbar-guia' + (guiado && podeGuiar ? ' on' : '')}
        disabled={!podeGuiar}
        onClick={onGuiado}
        title={
          podeGuiar
            ? 'modo guiado: as etapas viram cartões, e clicar num deles leva até o nó'
            : 'esta lente não tem percurso pra guiar (só Fluxograma, Swimlane e Máq. estados)'
        }
      >
        ☰ guiado
      </button>
    </div>
  )
}

async function computeLayout(lensDef: LensDef, diagram: Diagram): Promise<LayoutResult> {
  switch (lensDef.layout) {
    case 'swimlane':
      return swimlaneLayout(diagram)
    case 'er':
      return layoutDiagram(diagram, 'RIGHT', 110)
    case 'mind':
      return mindLayout(diagram)
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
