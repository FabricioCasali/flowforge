// =============================================================================
// adapters/prompt.js — o pedido que o harness recebe a cada "Analisar".
//
// Neutro de fornecedor de proposito: e o mesmo texto para Claude Code, OpenCode e
// Codex. O contrato completo esta em docs/SCHEMA.md; aqui vai so o que o agente
// precisa para responder RAPIDO e sem quebrar o desenho.
//
// Duas licoes medidas (18/09/2026, mapa de 33 nos, 113 s):
//   - editar o workspace.json no por no custou ~50 s -> a resposta vai num
//     arquivo so (reply.json, ver reply.js) e o adapter aplica;
//   - "teste de analise" virou auditoria do projeto -> o pedido manda responder
//     na medida do que foi pedido.
// =============================================================================

const path = require('path');
const { replyPath } = require('./reply.js');

const SCHEMA_PATH = path.resolve(__dirname, '..', 'docs', 'SCHEMA.md');

function buildPrompt(evt, { continuing }) {
  const note = String(evt.note || '').trim();
  const head = continuing
    ? 'O usuario clicou em "Analisar" de novo no FlowForge, na mesma sessao desta conversa.'
    : 'Voce e o interlocutor de um canvas do FlowForge: o usuario desenha um problema no navegador, '
      + 'clica em "Analisar" e espera a sua resposta OLHANDO PRA TELA. Seja rapido.';

  return [
    head,
    '',
    'Sessao: ' + evt.session + (evt.workspaceTitle ? ' ("' + evt.workspaceTitle + '")' : ''),
    'Pedido do usuario: ' + (note || '(sem texto — olhe o que ele marcou no canvas)'),
    '',
    'Leia:  ' + evt.workspacePath + '   (5 modelos: process, state, er, mind, seq)',
    '       ' + evt.threadPath + '   (a conversa ate aqui)',
    '',
    'RESPONDA GRAVANDO UM ARQUIVO SO — ' + replyPath(evt) + ' — e pare. O adapter aplica no',
    'workspace, sobe o rev, recalcula as setas dos nos mexidos e poe a mensagem no chat:',
    '',
    '{ "model": "mind",            // o modelo que voce altera: process | state | er | mind',
    '  "message": "sua resposta pro chat: curta, em portugues — o que mudou e por que",',
    '  "update":      [{ "id": "<id existente>", "status": "approved|questioned|rejected|proposed",',
    '                    "label": "...", "description": "...", "comment": "...", "commentKind": "note|question|reject" }],',
    '  "addNodes":    [{ "id": "<id novo>", "label": "...", "kind": "idea|task|decision|...", "description": "...", "comment": "..." }],',
    '  "addEdges":    [{ "source": "<id>", "target": "<id>", "label": "" }],',
    '  "updateEdges": [{ "id": "<id>", "status": "...", "label": "..." }],',
    '  "removeNodes": ["<id>"], "removeEdges": ["<id>"] }',
    '',
    'So "message" e obrigatorio; omita o que nao usar. So "message" = resposta sem mexer no desenho.',
    'Nao escreva no workspace nem na conversa quando usar este arquivo — o adapter faz isso.',
    '',
    'Como responder:',
    '- NA MEDIDA DO PEDIDO. Pergunta curta ou teste -> resposta curta, poucas operacoes. So pesquise o',
    '  codigo do projeto (o diretorio atual) se o pedido depender disso.',
    '- Olhe primeiro os nos "rejected"/"questioned" e os comments de author "user": e ali que ele discorda.',
    '- Seja interlocutor, nao eco: se discordar, diga por que e ponha a alternativa NO DESENHO (addNodes',
    '  + addEdges), com o seu raciocinio em "comment" no no.',
    '- Aprovar/reprovar e gesto do usuario. Mude "status" quando ele pedir, ou pra marcar "questioned"',
    '  o que voce contesta.',
    '- No novo nao leva x/y. Nao apague nem reescreva o que e do usuario sem ele pedir.',
    '',
    'Excecao: o que o arquivo de resposta nao cobre (fields de entidade ER, lanes, o modelo seq e o',
    '"title" do topo, que e o titulo da sessao) voce edita direto no workspace, seguindo',
    SCHEMA_PATH + ' — "rev": ' + (Number(evt.workspaceRev) + 1) + ', "updatedBy": "agent".',
  ].join('\n');
}

module.exports = { buildPrompt, SCHEMA_PATH };
