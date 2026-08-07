import type { Diagram } from '../types.js'

// Diagrama-semente do editor: o plano de correção de um bug (o caso do briefing),
// que o Líder proporia. Nós entram `proposed`; o usuário crava nó a nó.
// `description` = a frase curta que aparece na FACE do nó.
export function seedDiagram(): Diagram {
  return {
    type: 'flowchart',
    title: 'Plano · corrigir bug #12345',
    rev: 1,
    updatedBy: 'claude',
    lanes: [],
    nodes: [
      { id: 'n_start', label: 'Bug reportado', kind: 'start', status: 'proposed', description: 'entrada do fluxo', comments: [] },
      {
        id: 'n_inv',
        label: 'Investigar causa-raiz',
        kind: 'task',
        status: 'approved',
        description: 'lê o repo e mapeia a origem do erro',
        comments: [{ author: 'claude', kind: 'note', text: 'Suspeito da classe X — validação nula', ts: 1 }]
      },
      { id: 'n_fix', label: 'Aplicar correção', kind: 'task', status: 'proposed', description: 'implementa o patch', comments: [] },
      { id: 'n_test', label: 'Rodar testes', kind: 'task', status: 'proposed', description: 'suíte + regressão do bug', comments: [] },
      { id: 'n_dec', label: 'Passou?', kind: 'decision', status: 'proposed', description: 'gate de qualidade', comments: [] },
      { id: 'n_azure', label: 'Atualizar card', kind: 'task', status: 'proposed', description: 'move o card no Azure DevOps', comments: [] },
      { id: 'n_doc', label: 'Documentar', kind: 'task', status: 'proposed', description: 'registra o fix na wiki', comments: [] },
      { id: 'n_end', label: 'Concluído', kind: 'end', status: 'proposed', description: 'fim do fluxo', comments: [] }
    ],
    edges: [
      { id: 'e1', source: 'n_start', target: 'n_inv', label: '', status: 'proposed' },
      { id: 'e2', source: 'n_inv', target: 'n_fix', label: '', status: 'proposed' },
      { id: 'e3', source: 'n_fix', target: 'n_test', label: '', status: 'proposed' },
      { id: 'e4', source: 'n_test', target: 'n_dec', label: '', status: 'proposed' },
      { id: 'e5', source: 'n_dec', target: 'n_azure', label: 'sim', status: 'proposed' },
      { id: 'e6', source: 'n_dec', target: 'n_fix', label: 'não', status: 'proposed' },
      { id: 'e7', source: 'n_azure', target: 'n_doc', label: '', status: 'proposed' },
      { id: 'e8', source: 'n_doc', target: 'n_end', label: '', status: 'proposed' }
    ]
  }
}
