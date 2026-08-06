// Tokens do eixo de CO-DECISÃO (proposto → aprovado / questionado / reprovado).
// Vive fora dos componentes porque o nó, o card e as arestas leem os três.
import type { NodeStatus } from '../types.js'

export const SC: Record<NodeStatus, string> = {
  proposed: '--s-proposed',
  approved: '--s-approved',
  questioned: '--s-questioned',
  rejected: '--s-rejected'
}

export const STLBL: Record<NodeStatus, string> = {
  proposed: 'proposto',
  approved: 'aprovado',
  questioned: 'questionado',
  rejected: 'reprovado'
}

/** Status que acendem o nó no canvas (o que saiu do neutro e tem veredito). */
export const LIVE = new Set<NodeStatus>(['approved', 'questioned'])
