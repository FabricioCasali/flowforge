// ============================================================================
// useHistorico — desfazer/refazer (FF-007), fora do EditorView.
//
// 20 níveis, como no editor antigo. Guarda o modelo ANTES de cada escrita, junto
// com a lente — desfazer numa lente não pode escrever noutra. Não guarda o eco
// do servidor: histórico é do que EU fiz, e o que o agente escreve não é meu pra
// desfazer.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Diagram, ModelKey, Workspace } from '../types.js'

type GraphModel = Exclude<ModelKey, 'seq'>
interface Passo {
  model: GraphModel
  antes: Diagram
}

const MAX_HIST = 20

export interface Historico {
  /** Chamado por quem escreve, ANTES de aplicar: empilha o estado que vai sumir. */
  registra: (model: GraphModel, antes: Diagram) => void
  desfazer: () => void
  refazer: () => void
  podeDesfazer: boolean
  podeRefazer: boolean
}

export function useHistorico(
  data: Workspace,
  busy: boolean,
  aplica: (model: GraphModel, next: Diagram) => void
): Historico {
  const undoRef = useRef<Passo[]>([])
  const redoRef = useRef<Passo[]>([])
  // as pilhas moram em ref (não precisam re-renderizar), mas os BOTÕES precisam
  // saber se estão vivos — daí este par de contadores em state
  const [hist, setHist] = useState({ undo: 0, redo: 0 })
  const marca = useCallback(() => setHist({ undo: undoRef.current.length, redo: redoRef.current.length }), [])

  const registra = useCallback(
    (model: GraphModel, antes: Diagram) => {
      undoRef.current.push({ model, antes })
      if (undoRef.current.length > MAX_HIST) undoRef.current.shift()
      redoRef.current = [] // ramo novo: o que estava pra frente morreu
      marca()
    },
    [marca]
  )

  const desfazer = useCallback(() => {
    if (busy) return // lei 7
    const passo = undoRef.current.pop()
    if (!passo) return
    redoRef.current.push({ model: passo.model, antes: data[passo.model] })
    marca()
    aplica(passo.model, passo.antes)
  }, [busy, data, aplica, marca])

  const refazer = useCallback(() => {
    if (busy) return
    const passo = redoRef.current.pop()
    if (!passo) return
    undoRef.current.push({ model: passo.model, antes: data[passo.model] })
    marca()
    aplica(passo.model, passo.antes)
  }, [busy, data, aplica, marca])

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

  return { registra, desfazer, refazer, podeDesfazer: hist.undo > 0, podeRefazer: hist.redo > 0 }
}
