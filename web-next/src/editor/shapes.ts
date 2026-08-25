// ============================================================================
// shapes.ts — a TABELA das formas por `kind` (lei 8 do AGENTS.md).
//
// Mora sozinha, sem React e sem @xyflow, por dois motivos:
//   · `nodeSize` (layout.ts) e `FlowNode` (render) precisam concordar sobre o
//     que é cada kind. Quando cada um tinha a sua lista, elas divergiam em
//     silêncio — o nó ganhava tamanho de losango e desenho de retângulo.
//   · o verificador (`scripts/verifica-layout.mjs`) carrega este módulo direto
//     em Node para provar que nenhum kind real caiu no fallback.
//
// Referência das formas: `web/app.js:60-74` (editor antigo, Cytoscape).
// ============================================================================

export type FlowShape =
  | 'rect' // task, state e qualquer kind desconhecido
  | 'subprocess' // retângulo + marca [+]
  | 'pill' // início / fim
  | 'diamond' // decisão (rótulo dentro)
  | 'gate' // gateway BPM ✕ / ✛ (rótulo fora)
  | 'event' // evento BPM ○ (rótulo fora)
  | 'idea' // elipse
  | 'data' // objeto de dados (canto cortado)
  | 'annotation' // anotação (tracejada, esmaecida)
  | 'entity' // ER — desenhado pelo EntityNode, não pelo FlowNode

/**
 * Os kinds que o editor conhece por nome. Tudo que não estiver aqui é desenhado
 * como retângulo — de propósito: kind novo do agente aparece como etapa comum em
 * vez de sumir do canvas.
 */
export const SHAPE_BY_KIND = {
  task: 'rect',
  state: 'rect',
  subprocess: 'subprocess',
  start: 'pill',
  end: 'pill',
  decision: 'diamond',
  'gateway-exclusive': 'gate',
  'gateway-parallel': 'gate',
  'event-start': 'event',
  'event-end': 'event',
  'event-intermediate': 'event',
  idea: 'idea',
  'data-object': 'data',
  annotation: 'annotation',
  entity: 'entity'
} as const satisfies Record<string, FlowShape>

export type KnownKind = keyof typeof SHAPE_BY_KIND

/** Ordem de paleta (a de FF-005 sai daqui). `entity` fica fora: é lente própria. */
export const KINDS: KnownKind[] = [
  'start',
  'task',
  'decision',
  'end',
  'subprocess',
  'data-object',
  'annotation',
  'idea',
  'event-start',
  'event-intermediate',
  'event-end',
  'gateway-exclusive',
  'gateway-parallel'
]

export function shapeOf(kind: string): FlowShape {
  return (SHAPE_BY_KIND as Record<string, FlowShape>)[kind] ?? 'rect'
}

/** Nome em PT-BR de cada kind — o mesmo do `select` do editor antigo. */
export const KIND_LABEL: Record<string, string> = {
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
  annotation: 'anotação',
  entity: 'entidade'
}

/**
 * Nome CURTO, pra paleta. Ela é uma coluna estreita ao lado do canvas: o nome
 * inteiro ("gateway exclusivo (ou)") não cabe e sai cortado no meio da palavra.
 * O nome completo continua no `title` do item e no select do card do nó.
 */
export const KIND_LABEL_CURTO: Record<string, string> = {
  start: 'início',
  task: 'tarefa',
  decision: 'decisão',
  end: 'fim',
  idea: 'ideia',
  'event-start': 'ev. início',
  'event-intermediate': 'ev. meio',
  'event-end': 'ev. fim',
  'gateway-exclusive': 'gate ou',
  'gateway-parallel': 'gate e',
  subprocess: 'subproc.',
  'data-object': 'dado',
  annotation: 'anotação',
  entity: 'entidade'
}

/** Rótulo com que o nó NASCE (`web/app.js:970`). Some assim que o Fabricio digita. */
export const KIND_NEW_LABEL: Record<string, string> = {
  start: 'início',
  end: 'fim',
  decision: 'decisão?',
  idea: 'ideia',
  task: 'nova tarefa',
  'event-start': 'início',
  'event-end': 'fim',
  'event-intermediate': 'evento',
  'gateway-exclusive': 'ou?',
  'gateway-parallel': 'e',
  subprocess: 'subprocesso',
  'data-object': 'dado',
  annotation: 'anotação',
  entity: 'NovaEntidade'
}

/** Os que a paleta agrupa como "Fluxo"; o resto é BPM. */
export const GRUPO_FLUXO = new Set<string>(['start', 'task', 'decision', 'end', 'idea'])

/** Formas pequenas demais para o texto caber dentro — rótulo vai embaixo. */
export const LABEL_OUTSIDE = new Set<FlowShape>(['event', 'gate'])

/** Formas desenhadas por um losango de fundo (clip-path no `.fnode-di`). */
export const DIAMONDISH = new Set<FlowShape>(['diamond', 'gate'])

/** Formas que mostram cabeçalho + corpo (dot, rótulo, badge de status, descrição). */
export const BOXY = new Set<FlowShape>(['rect', 'subprocess'])

/** Medidas fixas do vocabulário BPM — iguais às do `web/app.js:67-71`. */
export const EVENT_SIZE = 62
export const GATE_SIZE = 92
