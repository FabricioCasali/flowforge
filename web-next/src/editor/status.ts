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

/**
 * Status que ACENDEM o nó no canvas — só o que ainda pede a atenção do usuário.
 *
 * `approved` saiu daqui: aprovado é assunto RESOLVIDO, e a regra-mãe da pele é
 * "só brilha o que está vivo". Com ele dentro, um diagrama maduro (20 de 21 nós
 * aprovados no `arquitetura-flowforge`) brilhava inteiro e o único questionado —
 * o que importa — sumia no meio do verde.
 */
export const LIVE = new Set<NodeStatus>(['questioned'])

/**
 * Status que levam BADGE escrito no nó. O aprovado fica só com o ponto verde:
 * é o estado de repouso, e repetir "APROVADO" em toda caixa é ruído. Quem ainda
 * espera veredito (ou levou um negativo) continua dizendo isso por extenso.
 */
export const BADGED = new Set<NodeStatus>(['proposed', 'questioned', 'rejected'])

/**
 * Cor da SETA por status. A aprovada é neutra pelo mesmo motivo do nó: num
 * diagrama resolvido a malha de setas verdes competia com os próprios nós. A cor
 * fica para a seta que discorda do repouso (lei 10: a seta tem status próprio,
 * e é justamente essa que precisa saltar aos olhos).
 */
export const EDGE_COLOR: Record<NodeStatus, string> = {
  proposed: 'var(--s-proposed)',
  approved: 'var(--edge-quiet)',
  questioned: 'var(--s-questioned)',
  rejected: 'var(--s-rejected)'
}
