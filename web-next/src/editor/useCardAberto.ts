// ============================================================================
// useCardAberto — o ciclo de vida do card do nó, fora do EditorView.
//
// Selecionar serve para mover o nó e ler suas ligações; abrir o card é OUTRO
// gesto. No hover ele é temporário (abre e fecha com 1s de folga), enquanto
// duplo clique ou clique dentro do próprio card o tornam persistente até o
// próximo clique fora.
//
// Quem está aberto chega aos nós por CONTEXTO (`CardAbertoCtx`), não pelo `data`
// de cada nó. Pelo `data`, passar o mouse em cima de um nó refazia a lista
// inteira de nós do React Flow — duas vezes por hover, num diagrama de 22.
// Pelo contexto, só re-renderiza quem lê o contexto, e só o card muda.
// ============================================================================

import { createContext, useCallback, useContext, useEffect, useRef, useState, type MouseEvent } from 'react'
import type { Node } from '@xyflow/react'

/** Id do nó com o card aberto, ou `null`. */
export const CardAbertoCtx = createContext<string | null>(null)

/** O card DESTE nó está aberto? */
export function useCardAbertoDe(id: string): boolean {
  return useContext(CardAbertoCtx) === id
}

interface CardAberto {
  id: string | null
  persistente: boolean
}

export interface CicloDoCard {
  cardId: string | null
  persistirCard: (id: string) => void
  fecharCard: () => void
  onNodeMouseEnter: (event: MouseEvent, node: Node) => void
  onNodeMouseLeave: (event: MouseEvent, node: Node) => void
  onNodeDoubleClick: (event: MouseEvent, node: Node) => void
}

const ESPERA_MS = 1000

/** `lens` entra só para fechar o card ao trocar de lente. */
export function useCardAberto(lens: string): CicloDoCard {
  const [cardAberto, setCardAberto] = useState<CardAberto>({ id: null, persistente: false })
  const cardRef = useRef<CardAberto>(cardAberto)
  const timerAbre = useRef<ReturnType<typeof setTimeout> | null>(null)
  const timerFecha = useRef<ReturnType<typeof setTimeout> | null>(null)
  const gestoPonteiro = useRef<{ x: number; y: number; moveu: boolean } | null>(null)

  const trocarCard = useCallback((next: CardAberto) => {
    cardRef.current = next
    setCardAberto(next)
  }, [])
  const cancelarTimers = useCallback(() => {
    if (timerAbre.current) clearTimeout(timerAbre.current)
    if (timerFecha.current) clearTimeout(timerFecha.current)
    timerAbre.current = null
    timerFecha.current = null
  }, [])
  const fecharCard = useCallback(() => {
    cancelarTimers()
    trocarCard({ id: null, persistente: false })
  }, [cancelarTimers, trocarCard])
  const persistirCard = useCallback(
    (id: string) => {
      cancelarTimers()
      trocarCard({ id, persistente: true })
    },
    [cancelarTimers, trocarCard]
  )

  const onNodeMouseEnter = useCallback(
    (_event: MouseEvent, node: Node) => {
      if (timerFecha.current) clearTimeout(timerFecha.current)
      timerFecha.current = null
      const atual = cardRef.current
      if (atual.id === node.id || atual.persistente) return
      if (atual.id) trocarCard({ id: null, persistente: false })
      if (timerAbre.current) clearTimeout(timerAbre.current)
      timerAbre.current = setTimeout(() => {
        timerAbre.current = null
        trocarCard({ id: node.id, persistente: false })
      }, ESPERA_MS)
    },
    [trocarCard]
  )
  const onNodeMouseLeave = useCallback(
    (_event: MouseEvent, node: Node) => {
      if (timerAbre.current) clearTimeout(timerAbre.current)
      timerAbre.current = null
      const atual = cardRef.current
      if (atual.id !== node.id || atual.persistente) return
      timerFecha.current = setTimeout(() => {
        timerFecha.current = null
        const corrente = cardRef.current
        if (corrente.id === node.id && !corrente.persistente) trocarCard({ id: null, persistente: false })
      }, ESPERA_MS)
    },
    [trocarCard]
  )
  const onNodeDoubleClick = useCallback(
    (event: MouseEvent, node: Node) => {
      event.stopPropagation()
      persistirCard(node.id)
    },
    [persistirCard]
  )

  useEffect(() => () => cancelarTimers(), [cancelarTimers])
  useEffect(() => fecharCard(), [lens, fecharCard])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) return
      gestoPonteiro.current = { x: event.clientX, y: event.clientY, moveu: false }
    }
    const onPointerMove = (event: PointerEvent): void => {
      const gesto = gestoPonteiro.current
      if (!gesto || gesto.moveu) return
      if (Math.hypot(event.clientX - gesto.x, event.clientY - gesto.y) > 5) gesto.moveu = true
    }
    const onClick = (event: globalThis.MouseEvent): void => {
      const moveu = gestoPonteiro.current?.moveu ?? false
      gestoPonteiro.current = null
      if (moveu) return
      if (!cardRef.current.id) return
      if (event.target instanceof Element && event.target.closest('.fpanel')) return
      fecharCard()
    }
    // Fecha depois do click completo. Pointerdown desmontava as arestas antes
    // do mouseup, quebrava a seleção da linha e fechava ao começar um pan.
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointermove', onPointerMove, true)
    document.addEventListener('click', onClick)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointermove', onPointerMove, true)
      document.removeEventListener('click', onClick)
    }
  }, [fecharCard])

  return { cardId: cardAberto.id, persistirCard, fecharCard, onNodeMouseEnter, onNodeMouseLeave, onNodeDoubleClick }
}
