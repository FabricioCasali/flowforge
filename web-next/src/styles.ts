// Side-effects de estilo do editor. A ORDEM importa:
//   1) base do React Flow — precisa vir primeiro pra nossa pele vencer;
//   2) pele NEON (tokens, reset, fundo);
//   3) css do editor (usa os tokens da pele);
//   4) css do shell — topbar/conversa; vem por último porque REPOSICIONA o
//      `.neon-editor` do editor.css (abre espaço pro painel).
import '@xyflow/react/dist/style.css'
import './skin.css'
import './editor.css'
import './shell.css'
