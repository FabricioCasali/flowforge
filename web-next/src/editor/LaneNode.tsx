import type { NodeProps } from '@xyflow/react'

export interface LaneNodeData {
  label: string
  width: number
  height: number
  [key: string]: unknown
}

/** Banda de raia (swimlane) — fundo não-interativo com o rótulo do ator. */
export function LaneNode({ data }: NodeProps): JSX.Element {
  const { label, width, height } = data as LaneNodeData
  return (
    <div className="lane-band" style={{ width, height }}>
      <span className="lane-label neon-mono">{label}</span>
    </div>
  )
}
