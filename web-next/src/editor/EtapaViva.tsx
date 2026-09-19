// ============================================================================
// MarcaViva — a marca discreta de "o agente está NESTA etapa" (issue #8).
//
// O realce grande (o anel em volta do nó) é CSS no invólucro do React Flow, para
// valer em qualquer lente de grafo sem cada nó saber disso. Esta marca é o resto:
// diz QUAL tarefa está no nó e DE QUEM ela é, no `title` — a informação só
// aparece para quem for atrás dela.
//
// Ela não pode competir com a CO-DECISÃO (o eixo aprovado/questionado/reprovado,
// que mora na borda e no badge do nó): por isso é pequena, fica FORA da borda e
// pinta com os tokens do EIXO 2 — `--s-act` para quem está andando, `--s-wait`
// para quem travou. Desenhada em SVG, não glifo de fonte, para ficar nítida em
// qualquer zoom (a mesma razão da `Marca` da lente Tarefas).
// ============================================================================

import type { EtapaViva } from './model.js'

/** "Claude Code · 2. escrever o teste — em andamento · cobrindo o refresh" */
export function dizerEtapa(v: EtapaViva): string {
  return (
    `${v.quem} · ${v.n}. ${v.titulo} — ${v.estado === 'andando' ? 'em andamento' : 'travada'}` +
    (v.nota ? ` · ${v.nota}` : '')
  )
}

export function MarcaViva({ viva }: { viva: EtapaViva }): JSX.Element {
  const andando = viva.estado === 'andando'
  return (
    <span className={'ff-viva-marca ' + (andando ? 'andando' : 'travada')} title={dizerEtapa(viva)}>
      <svg viewBox="0 0 14 14" role="img" aria-label={dizerEtapa(viva)}>
        <circle cx="7" cy="7" r="6.25" className="ff-vm-fundo" />
        {andando ? (
          // seta de "tocando": é o que a lente Tarefas usa para em andamento
          <path d="M5.4 4.2 L10 7 L5.4 9.8 Z" className="ff-vm-mk" />
        ) : (
          // duas barras: parado à espera de alguma coisa
          <path d="M5.4 4.4 V9.6 M8.6 4.4 V9.6" className="ff-vm-mk barras" />
        )}
      </svg>
    </span>
  )
}
