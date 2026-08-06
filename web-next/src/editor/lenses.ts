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
  /**
   * A lente é DONA das posições do modelo: honra o `x`/`y` do arquivo e grava o
   * arrasto de volta nele.
   *
   * A Swimlane é a única de grafo que fica de fora, e é decisão do Fabricio
   * (06/08/2026): `process` tem UM par `x`/`y` por nó servindo duas lentes, e a
   * geometria delas é incompatível — num fluxograma vertical todo nó tem
   * praticamente o mesmo `x`, o que empilharia a raia inteira numa coluna. Então
   * a Swimlane é DERIVADA: sempre recalcula, e arrastar lá vale só na sessão.
   * O contrato fica inalterado (nada de posição por lente em `types.ts`).
   */
  savesPos: boolean
  /**
   * A lente aceita o MODO GUIADO (painel de etapas em cartões)?
   *
   * Só onde o diagrama se lê como PERCURSO. Fica de fora: `mind` (é hierarquia,
   * pediria uma árvore indentada em vez de fila de cartões), `er` (não há
   * percurso — viraria índice de entidades, que é outra coisa) e `seq` (a lente
   * já É linear, o painel seria eco dela). Ligar isso nas três exige desenhar
   * uma forma própria pra cada uma; não vale antes de o gesto se provar.
   */
  guiado: boolean
}

export const LENSES: LensDef[] = [
  { key: 'flow', label: 'Fluxograma', model: 'process', layout: 'layered', nodeType: 'flow', edgeType: 'orth', family: 'lente', savesPos: true, guiado: true },
  { key: 'swimlane', label: 'Swimlane', model: 'process', layout: 'swimlane', nodeType: 'flow', edgeType: 'orth', family: 'lente', savesPos: false, guiado: true },
  { key: 'state', label: 'Máq. estados', model: 'state', layout: 'layered', nodeType: 'flow', edgeType: 'orth', family: 'lente', savesPos: true, guiado: true },
  { key: 'er', label: 'ER', model: 'er', layout: 'er', nodeType: 'entity', edgeType: 'er', family: 'conteúdo', savesPos: true, guiado: false },
  { key: 'mind', label: 'Mind map', model: 'mind', layout: 'radial', nodeType: 'mind', edgeType: 'mind', family: 'conteúdo', savesPos: true, guiado: false },
  { key: 'seq', label: 'Sequência', model: 'seq', layout: 'seq', nodeType: 'flow', edgeType: 'orth', family: 'conteúdo', savesPos: false, guiado: false }
]

export const LENS_BY_KEY: Record<LensKey, LensDef> = Object.fromEntries(LENSES.map((l) => [l.key, l])) as Record<
  LensKey,
  LensDef
>
