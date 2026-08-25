// ============================================================================
// GuidePanel — o MODO GUIADO (FF-015).
//
// Um grafo mostra a estrutura e esconde a ordem de leitura: quem abre um
// diagrama de 22 nós não sabe por onde começar. Este painel dá o percurso — os
// nós viram cartões numerados, clicar num cartão voa a tela até o nó.
//
// A DIVISÃO DE CONTEÚDO é o coração da coisa (decisão do Fabricio, 06/08/2026):
//     painel → `concept`      = a TEORIA, pra entender o fluxo
//     card   → `description`  = o EXEMPLO REAL, pra implementar
// São duas frentes, não dois recortes do mesmo texto. Por isso o cartão daqui
// mostra `concept` e NÃO cai pra `description` quando ele falta: fingir que tem
// teoria escrita mostrando o texto técnico é pior que dizer que falta.
//
// A ORDEM é por POSIÇÃO (y, e x como desempate), não topológica. Medido nos 11
// diagramas reais: 3 têm ciclo e 4 têm mais de uma raiz — seguir as setas
// quebraria neles. Já a posição sempre existe, e é do Fabricio (FF-001): ele
// desenha de cima pra baixo, então a ordem do painel é a leitura que ele já faz.
// ============================================================================

import { useEffect, useRef } from 'react'
import type { DNode } from '../types.js'
import { KIND_LABEL, shapeOf } from './shapes.js'
import { STLBL } from './status.js'
import { ordenarParaGuia } from './model.js'

export interface GuidePanelProps {
  nodes: DNode[]
  /** Nó selecionado no canvas — o painel acompanha e rola até ele. */
  selecionado?: string | null
  onIr: (id: string) => void
  onFechar: () => void
}

/** Anotação não é etapa de percurso: entra no fim, marcada como nota à margem. */
function ehNota(n: DNode): boolean {
  return shapeOf(n.kind) === 'annotation'
}

export function GuidePanel({ nodes, selecionado, onIr, onFechar }: GuidePanelProps): JSX.Element {
  const lista = ordenarParaGuia(nodes, ehNota)
  const caixa = useRef<HTMLDivElement>(null)

  // seguir a seleção do canvas: clicar num nó lá rola o painel até o cartão dele.
  // O guia é de mão dupla — senão você navega no canvas e perde o fio no painel.
  useEffect(() => {
    if (!selecionado) return
    const el = caixa.current?.querySelector(`[data-no="${CSS.escape(selecionado)}"]`)
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selecionado])

  const semTeoria = lista.filter((n) => !n.concept?.trim()).length

  return (
    <aside className="guia">
      <div className="guia-head neon-mono">
        <span>modo guiado</span>
        <span className="guia-cont">{lista.length}</span>
        <button className="guia-x" title="fechar o painel" onClick={onFechar}>
          ✕
        </button>
      </div>

      {semTeoria === lista.length && lista.length > 0 && (
        <p className="guia-vazio">
          Nenhuma etapa tem <b>teoria</b> escrita ainda. Peça ao agente no “Analisar” para
          explicar o fluxo — ou escreva você, na aba <b>teoria</b> do card de cada nó.
        </p>
      )}

      <div className="guia-lista" ref={caixa}>
        {lista.map((n, i) => {
          const nota = ehNota(n)
          return (
            <button
              key={n.id}
              data-no={n.id}
              className={'guia-card st-' + n.status + (nota ? ' nota' : '') + (selecionado === n.id ? ' on' : '')}
              onClick={() => onIr(n.id)}
            >
              <div className="guia-card-topo neon-mono">
                <span className="guia-num">{nota ? '·' : i + 1}</span>
                <span className="guia-kind">{KIND_LABEL[n.kind] ?? n.kind}</span>
                <span className="guia-st">{STLBL[n.status]}</span>
              </div>
              <div className="guia-titulo">{n.label}</div>
              {n.concept?.trim() ? (
                <div className="guia-teoria">{n.concept}</div>
              ) : (
                <div className="guia-falta neon-mono">sem teoria escrita</div>
              )}
            </button>
          )
        })}
      </div>
    </aside>
  )
}
