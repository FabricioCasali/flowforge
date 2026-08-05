import type { SeqModel } from '../types.js'

const COLW = 200
const MARGIN = 90
const HEAD = 64
const ROWH = 64

/** Renderer dedicado de Sequência: participantes + linhas-de-vida + mensagens (tempo ↓). */
export function SequenceView({ model }: { model: SeqModel }): JSX.Element {
  const px: Record<string, number> = {}
  model.participants.forEach((p, i) => (px[p.id] = MARGIN + i * COLW + COLW / 2))
  const width = MARGIN * 2 + Math.max(0, model.participants.length - 1) * COLW + COLW
  const height = HEAD + model.messages.length * ROWH + 60
  const lifelineBottom = height - 30

  return (
    <div className="seqview">
      <svg width={width} height={height}>
        {/* linhas-de-vida */}
        {model.participants.map((p) => (
          <line
            key={'ll' + p.id}
            className="seq-lifeline"
            x1={px[p.id]}
            y1={HEAD}
            x2={px[p.id]}
            y2={lifelineBottom}
          />
        ))}
        {/* cabeçalhos dos participantes */}
        {model.participants.map((p) => (
          <g key={'h' + p.id} transform={`translate(${px[p.id]! - 70}, 14)`}>
            <rect className="seq-actor" width={140} height={36} rx={10} />
            <text className="seq-actor-t" x={70} y={23} textAnchor="middle">
              {p.label}
            </text>
          </g>
        ))}
        {/* mensagens */}
        {model.messages.map((m, i) => {
          const y = HEAD + 34 + i * ROWH
          const x1 = px[m.from]!
          const x2 = px[m.to]!
          const dir = x2 >= x1 ? 1 : -1
          const kind = m.kind ?? 'call'
          return (
            <g key={'m' + i} className={'seq-msg ' + kind}>
              <line x1={x1} y1={y} x2={x2 - dir * 7} y2={y} className="seq-line" />
              <path d={`M ${x2} ${y} l ${-dir * 8} -4 l 0 8 z`} className="seq-arrow" />
              <text className="seq-label neon-mono" x={(x1 + x2) / 2} y={y - 8} textAnchor="middle">
                {m.label}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
