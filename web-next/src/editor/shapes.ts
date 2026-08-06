// ============================================================================
// shapes.ts — a TABELA das formas por `kind` (lei 8 do CLAUDE.md).
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
 * como retângulo — de propósito: kind novo do Claude aparece como etapa comum em
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

/** Formas pequenas demais para o texto caber dentro — rótulo vai embaixo. */
export const LABEL_OUTSIDE = new Set<FlowShape>(['event', 'gate'])

/** Formas desenhadas por um losango de fundo (clip-path no `.fnode-di`). */
export const DIAMONDISH = new Set<FlowShape>(['diamond', 'gate'])

/** Formas que mostram cabeçalho + corpo (dot, rótulo, badge de status, descrição). */
export const BOXY = new Set<FlowShape>(['rect', 'subprocess'])

/** Medidas fixas do vocabulário BPM — iguais às do `web/app.js:67-71`. */
export const EVENT_SIZE = 62
export const GATE_SIZE = 92
