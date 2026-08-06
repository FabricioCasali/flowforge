// Side-effects de estilo do editor. A ORDEM importa:
//   0) fontes — auto-hospedadas, antes de qualquer folha que as use;
//   1) base do React Flow — precisa vir primeiro pra nossa pele vencer;
//   2) pele NEON (tokens, reset, fundo);
//   3) css do editor (usa os tokens da pele);
//   4) css do shell — topbar/conversa; vem por último porque REPOSICIONA o
//      `.neon-editor` do editor.css (abre espaço pro painel).
//
// As fontes vêm de @fontsource (arquivos no bundle), não do Google Fonts: o
// FlowForge é ferramenta local do dia a dia e não pode depender de rede pra
// renderizar direito. Mesmo caminho da origem do porte
// (`packages/canvas/src/styles.ts`).
//
// Recorte deliberado: só o subset `latin` e só os pesos que a pele usa
// (400/500/600/700 no display, 400/500/600 no mono). O import sem subset traz
// cyrillic, greek e vietnamese junto — 24 arquivos de fonte pra um editor de
// diagramas em PT-BR. Acento português mora todo no latin; o que sair disso cai
// no fallback do sistema, que é o comportamento certo pra um caso raro.
import '@fontsource/space-grotesk/latin-400.css'
import '@fontsource/space-grotesk/latin-500.css'
import '@fontsource/space-grotesk/latin-600.css'
import '@fontsource/space-grotesk/latin-700.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import '@fontsource/jetbrains-mono/latin-500.css'
import '@fontsource/jetbrains-mono/latin-600.css'

import '@xyflow/react/dist/style.css'
import './skin.css'
import './editor.css'
import './shell.css'
