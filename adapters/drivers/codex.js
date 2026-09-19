// Driver do Codex: `codex exec --json` (modo nao-interativo), pedido por stdin
// (o `-` final), `codex exec resume <thread_id>` para continuar a conversa.
// Doc: `codex exec --help`  (formato conferido na versao 0.154)
//
// Eventos JSONL: { type: 'thread.started', thread_id }
//                { type: 'item.completed', item: { type: 'agent_message', text } }
//                { type: 'turn.completed' | 'turn.failed' | 'error', ... }

module.exports = {
  id: 'codex',
  label: 'Codex',

  async run({ cwd, prompt, resumeId, model, extraArgs, runProcess, parseJsonLines }) {
    const args = ['exec'];
    if (resumeId) args.push('resume', resumeId);
    args.push(
      '--json',
      '--skip-git-repo-check', // o projeto do usuario pode nao ser um repo git
      // `resume` nao aceita -s nem -C: o sandbox vai por config e o diretorio pelo cwd
      // do processo. workspace-write = edita dentro do projeto, sem rede.
      '-c', 'sandbox_mode=workspace-write',
    );
    if (model) args.push('-m', model);
    args.push(...extraArgs, '-');

    const r = await runProcess('codex', args, { cwd, stdin: prompt });
    if (r.timedOut) return { ok: false, error: 'codex excedeu o tempo limite' };

    const events = parseJsonLines(r.stdout);
    const started = events.find((e) => e.type === 'thread.started');
    const failure = events.find((e) => e.type === 'turn.failed' || e.type === 'error');
    if (r.code !== 0 || failure || !events.length) {
      const detail = failure ? JSON.stringify(failure.error || failure.message || failure).slice(0, 500) : (r.stderr || r.stdout).slice(0, 500);
      return { ok: false, resumeId: null, error: 'codex saiu com codigo ' + r.code + ': ' + detail };
    }
    const messages = events
      .filter((e) => e.type === 'item.completed' && e.item && e.item.type === 'agent_message')
      .map((e) => e.item.text);
    return {
      ok: true,
      resumeId: (started && started.thread_id) || resumeId || null,
      text: messages.length ? messages[messages.length - 1] : '',
    };
  },
};
