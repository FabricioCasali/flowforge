// Registro de lentes (VIEWCFG). Cada lente declara qual MODELO lê, o LAYOUT,
// o tipo de NÓ e o estilo de ARESTA. Lentes de "lente" compartilham grafo
// (flow/swimlane sobre `process`); lentes de "conteúdo" têm modelo próprio.

export type LensKey = 'flow' | 'swimlane' | 'state' | 'er' | 'mind' | 'seq'
export type ModelKey = 'process' | 'state' | 'er' | 'mind' | 'seq'

export interface LensDef {
  key: LensKey
  label: string
  model: ModelKey
  layout: 'layered' | 'swimlane' | 'er' | 'radial' | 'seq'
  nodeType: 'flow' | 'entity' | 'mind'
  edgeType: 'orth' | 'er' | 'mind'
  family: 'lente' | 'conteúdo'
}

export const LENSES: LensDef[] = [
  { key: 'flow', label: 'Fluxograma', model: 'process', layout: 'layered', nodeType: 'flow', edgeType: 'orth', family: 'lente' },
  { key: 'swimlane', label: 'Swimlane', model: 'process', layout: 'swimlane', nodeType: 'flow', edgeType: 'orth', family: 'lente' },
  { key: 'state', label: 'Máq. estados', model: 'state', layout: 'layered', nodeType: 'flow', edgeType: 'orth', family: 'lente' },
  { key: 'er', label: 'ER', model: 'er', layout: 'er', nodeType: 'entity', edgeType: 'er', family: 'conteúdo' },
  { key: 'mind', label: 'Mind map', model: 'mind', layout: 'radial', nodeType: 'mind', edgeType: 'mind', family: 'conteúdo' },
  { key: 'seq', label: 'Sequência', model: 'seq', layout: 'seq', nodeType: 'flow', edgeType: 'orth', family: 'conteúdo' }
]

export const LENS_BY_KEY: Record<LensKey, LensDef> = Object.fromEntries(LENSES.map((l) => [l.key, l])) as Record<
  LensKey,
  LensDef
>
