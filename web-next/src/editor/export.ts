// ============================================================================
// export.ts — levar o diagrama pra fora: Mermaid, SVG e PNG.
//
// SEM DEPENDÊNCIA NOVA (lei 9). O caminho usual pra exportar React Flow é o
// `html-to-image`, que fotografa o DOM; aqui o SVG é DESENHADO a partir do
// modelo + do layout que já temos, e o PNG sai desse mesmo SVG por um canvas.
// Sai de graça um formato vetorial, que é melhor que PNG pra colar em documento.
//
// O que isso NÃO é: um screenshot. É uma reprodução — as formas, as cores de
// status e os rótulos batem com a tela, mas efeito de vidro, sombra e glow
// ficam de fora. Pra diagrama colado em ticket isso é o que se quer.
//
// O Mermaid é porte direto do `toMermaid` do editor antigo (`app.js:1349`),
// inclusive o mapeamento de forma por kind.
// ============================================================================

import type { Diagram, DNode, NodeStatus } from '../types.js'
import { labelPoint, labelRect, toRect, type LayoutResult } from './layout.js'
import { shapeOf } from './shapes.js'

// ---------------------------------------------------------------------------
// Mermaid
// ---------------------------------------------------------------------------

/** Delimitadores de forma do Mermaid por kind — mesma tabela do editor antigo. */
function mermaidWrap(kind: string): [string, string] {
  switch (shapeOf(kind)) {
    case 'diamond':
    case 'gate':
      return ['{', '}']
    case 'idea':
      return ['((', '))']
    case 'data':
      return ['[(', ')]']
    case 'pill':
    case 'event':
      return ['([', '])']
    default:
      return ['[', ']']
  }
}

export function toMermaid(d: Diagram): string {
  const lines = ['flowchart TD']
  const idmap: Record<string, string> = {}
  d.nodes.forEach((n, i) => {
    const nid = 'N' + i
    idmap[n.id] = nid
    const lbl = (n.label || '').replace(/"/g, "'")
    const [o, c] = mermaidWrap(n.kind)
    lines.push('  ' + nid + o + '"' + lbl + '"' + c)
  })
  for (const e of d.edges) {
    const s = idmap[e.source]
    const t = idmap[e.target]
    if (!s || !t) continue
    const lbl = (e.label || '').replace(/"/g, "'")
    lines.push('  ' + s + (lbl ? ' -->|"' + lbl + '"| ' : ' --> ') + t)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

/** Cores literais (o SVG tem de se bastar fora da página, sem var(--…)). */
const COR: Record<NodeStatus, string> = {
  proposed: '#8b93a3',
  approved: '#2fbf71',
  questioned: '#f5a623',
  rejected: '#e5484d'
}
const BG = '#0f1115'
const SURFACE = '#1b1f27'
const FG = '#e6e9ef'
const MUTED = '#9aa2b1'
const PAD = 40

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Quebra o rótulo em linhas que caibam na largura dada (estimativa por caractere). */
function wrap(txt: string, larguraPx: number, fonte = 12): string[] {
  const porLinha = Math.max(6, Math.floor(larguraPx / (fonte * 0.56)))
  const palavras = (txt || '').split(/\s+/).filter(Boolean)
  const linhas: string[] = []
  let atual = ''
  for (const p of palavras) {
    if (!atual) atual = p
    else if ((atual + ' ' + p).length <= porLinha) atual += ' ' + p
    else {
      linhas.push(atual)
      atual = p
    }
  }
  if (atual) linhas.push(atual)
  return linhas.slice(0, 4)
}

function textoCentrado(txt: string, cx: number, cy: number, larg: number, fonte: number, cor: string): string {
  const linhas = wrap(txt, larg, fonte)
  const alturaLinha = fonte * 1.25
  const y0 = cy - ((linhas.length - 1) * alturaLinha) / 2
  return linhas
    .map(
      (l, i) =>
        `<text x="${cx.toFixed(1)}" y="${(y0 + i * alturaLinha).toFixed(1)}" fill="${cor}" font-size="${fonte}" ` +
        `text-anchor="middle" dominant-baseline="middle" font-family="Space Grotesk, system-ui, sans-serif">${esc(l)}</text>`
    )
    .join('')
}

function formaSvg(n: DNode, x: number, y: number, w: number, h: number): string {
  const sc = COR[n.status]
  const shape = shapeOf(n.kind)
  const cx = x + w / 2
  const cy = y + h / 2
  const base = `fill="${SURFACE}" stroke="${sc}" stroke-width="1.6"`

  switch (shape) {
    case 'pill':
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" ${base}/>` +
        textoCentrado(n.label, cx, cy, w - 24, 12, FG)
    case 'diamond':
      return `<path d="M ${cx} ${y} L ${x + w} ${cy} L ${cx} ${y + h} L ${x} ${cy} Z" ${base}/>` +
        textoCentrado(n.label, cx, cy, w * 0.66, 11.5, FG)
    case 'gate': {
      const m = Math.min(w, h) * 0.21
      const marca =
        n.kind === 'gateway-parallel'
          ? `<path d="M ${cx} ${cy - m} L ${cx} ${cy + m} M ${cx - m} ${cy} L ${cx + m} ${cy}" stroke="${FG}" stroke-width="3" stroke-linecap="round"/>`
          : `<path d="M ${cx - m} ${cy - m} L ${cx + m} ${cy + m} M ${cx + m} ${cy - m} L ${cx - m} ${cy + m}" stroke="${FG}" stroke-width="3" stroke-linecap="round"/>`
      return `<path d="M ${cx} ${y} L ${x + w} ${cy} L ${cx} ${y + h} L ${x} ${cy} Z" ${base}/>` + marca +
        textoCentrado(n.label, cx, y + h + 14, 130, 11, MUTED)
    }
    case 'event': {
      const r = Math.min(w, h) / 2 - 2
      const grossa = n.kind === 'event-end' ? 4.5 : 1.8
      const dupla =
        n.kind === 'event-intermediate'
          ? `<circle cx="${cx}" cy="${cy}" r="${r - 4}" fill="none" stroke="${sc}" stroke-width="1.6"/>`
          : ''
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${SURFACE}" stroke="${sc}" stroke-width="${grossa}"/>` + dupla +
        textoCentrado(n.label, cx, y + h + 14, 130, 11, MUTED)
    }
    case 'idea':
      return `<ellipse cx="${cx}" cy="${cy}" rx="${w / 2}" ry="${h / 2}" ${base}/>` +
        textoCentrado(n.label, cx, cy, w - 20, 11.5, FG)
    case 'data': {
      const c = 11
      return `<path d="M ${x + c} ${y} L ${x + w - c} ${y} L ${x + w} ${y + c} L ${x + w} ${y + h - c} L ${x + w - c} ${y + h} L ${x + c} ${y + h} L ${x} ${y + h - c} L ${x} ${y + c} Z" ${base}/>` +
        textoCentrado(n.label, cx, cy, w - 22, 11.5, FG)
    }
    case 'annotation':
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="none" stroke="${sc}" stroke-width="1.6" stroke-dasharray="5 3"/>` +
        textoCentrado(n.label, cx, cy, w - 20, 11, MUTED)
    case 'entity': {
      const linhas = (n.fields ?? [])
        .map(
          (f, i) =>
            `<text x="${x + 12}" y="${y + 40 + i * 22}" fill="${MUTED}" font-size="11" font-family="JetBrains Mono, monospace">` +
            `${esc((f.key ? f.key.toUpperCase() + ' ' : '') + f.name + ' : ' + f.type)}</text>`
        )
        .join('')
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" ${base}/>` +
        `<line x1="${x}" y1="${y + 28}" x2="${x + w}" y2="${y + 28}" stroke="${sc}" stroke-width="1"/>` +
        `<text x="${x + 12}" y="${y + 19}" fill="${FG}" font-size="12.5" font-weight="600" font-family="Space Grotesk, system-ui, sans-serif">${esc(n.label)}</text>` +
        linhas
    }
    case 'subprocess':
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" ${base}/>` +
        textoCentrado(n.label, cx, cy - 4, w - 20, 12, FG) +
        `<path d="M ${cx} ${y + h - 12} L ${cx} ${y + h - 4} M ${cx - 4} ${y + h - 8} L ${cx + 4} ${y + h - 8}" stroke="${MUTED}" stroke-width="1.6" stroke-linecap="round"/>`
    default:
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" ${base}/>` +
        textoCentrado(n.label, cx, cy, w - 20, 12, FG)
  }
}

/** O diagrama inteiro como SVG autossuficiente. */
export function toSvg(d: Diagram, layout: LayoutResult): string {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of d.nodes) {
    const p = layout.positions[n.id]
    const s = layout.sizes[n.id]
    if (!p || !s) continue
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x + s.width)
    maxY = Math.max(maxY, p.y + s.height + 20) // folga pro rótulo de fora
  }
  if (!Number.isFinite(minX)) {
    minX = 0
    minY = 0
    maxX = 400
    maxY = 300
  }
  const w = maxX - minX + PAD * 2
  const h = maxY - minY + PAD * 2
  const dx = -minX + PAD
  const dy = -minY + PAD

  // o rótulo exportado mora onde o canvas o põe: no trecho mais comprido, longe dos nós
  const caixas = d.nodes.flatMap((n) => {
    const p = layout.positions[n.id]
    const s = layout.sizes[n.id]
    return p && s ? [toRect(p, s)] : []
  })
  const arestas = d.edges
    .map((e) => {
      const pts = layout.edgePoints[e.id]
      if (!pts || pts.length < 2) return ''
      const cor = COR[e.status]
      const path = pts.map((p, i) => `${i ? 'L' : 'M'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
      const meio = e.label ? labelPoint(pts, e.label, caixas) : pts[0]!
      if (e.label) caixas.push(labelRect(meio, e.label))
      const rotulo = e.label
        ? `<text x="${meio.x.toFixed(1)}" y="${(meio.y + 3.5).toFixed(1)}" fill="${MUTED}" font-size="10.5" text-anchor="middle" font-family="JetBrains Mono, monospace">${esc(e.label)}</text>`
        : ''
      return `<path d="${path}" fill="none" stroke="${cor}" stroke-width="1.6" marker-end="url(#seta-${e.status})"/>` + rotulo
    })
    .join('')

  const nos = d.nodes
    .map((n) => {
      const p = layout.positions[n.id]
      const s = layout.sizes[n.id]
      return p && s ? formaSvg(n, p.x, p.y, s.width, s.height) : ''
    })
    .join('')

  const markers = (Object.keys(COR) as NodeStatus[])
    .map(
      (st) =>
        `<marker id="seta-${st}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">` +
        `<path d="M 0 0 L 10 5 L 0 10 z" fill="${COR[st]}"/></marker>`
    )
    .join('')

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(w)}" height="${Math.round(h)}" viewBox="0 0 ${Math.round(w)} ${Math.round(h)}">` +
    `<defs>${markers}</defs>` +
    `<rect width="100%" height="100%" fill="${BG}"/>` +
    `<g transform="translate(${dx.toFixed(1)} ${dy.toFixed(1)})">${arestas}${nos}</g>` +
    `</svg>`
  )
}

// ---------------------------------------------------------------------------
// download
// ---------------------------------------------------------------------------

export function baixarTexto(nome: string, texto: string, mime = 'text/plain;charset=utf-8'): void {
  baixarUrl(nome, `data:${mime},` + encodeURIComponent(texto))
}

function baixarUrl(nome: string, url: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = nome
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/**
 * PNG a partir do próprio SVG, por canvas. Escala 2× pra não sair borrado numa
 * tela retina ou num zoom de documento.
 */
export async function baixarPng(nome: string, svg: string, escala = 2): Promise<void> {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  try {
    const img = await new Promise<HTMLImageElement>((ok, erro) => {
      const i = new Image()
      i.onload = () => ok(i)
      i.onerror = () => erro(new Error('não consegui rasterizar o SVG'))
      i.src = url
    })
    const cv = document.createElement('canvas')
    cv.width = Math.round(img.width * escala)
    cv.height = Math.round(img.height * escala)
    const ctx = cv.getContext('2d')
    if (!ctx) throw new Error('sem contexto 2d')
    ctx.scale(escala, escala)
    ctx.drawImage(img, 0, 0)
    baixarUrl(nome, cv.toDataURL('image/png'))
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Nome de arquivo seguro a partir do título da sessão. */
export function nomeSeguro(titulo: string): string {
  return (
    (titulo || 'diagrama')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'diagrama'
  )
}
