// Driver do OpenCode: `opencode run --format json` (modo nao-interativo), pedido
// por stdin, `--session <id>` para continuar a conversa daquela sessao do FlowForge.
// Doc: https://opencode.ai/docs/cli/  (formato conferido na versao 1.18)
//
// Eventos JSONL: { type: 'step_start' | 'text' | 'tool_use' | 'step_finish' | 'error',
//                  sessionID, part: { type, text, ... } }

module.exports = {
  id: 'opencode',
  label: 'OpenCode',

  async run({ cwd, prompt, resumeId, model, extraArgs, runProcess, parseJsonLines }) {
    const args = ['run', '--format', 'json'];
    if (resumeId) args.push('--session', resumeId);
    if (model) args.push('--model', model); // provider/model
    args.push(...extraArgs);

    const r = await runProcess('opencode', args, { cwd, stdin: prompt });
    if (r.timedOut) return { ok: false, error: 'opencode excedeu o tempo limite' };

    const events = parseJsonLines(r.stdout);
    const sessionId = (events.find((e) => e.sessionID) || {}).sessionID || null;
    const failure = events.find((e) => e.type === 'error');
    if (r.code !== 0 || failure || !events.length) {
      const detail = failure ? JSON.stringify(failure.error || failure).slice(0, 500) : (r.stderr || r.stdout).slice(0, 500);
      return { ok: false, resumeId: null, error: 'opencode saiu com codigo ' + r.code + ': ' + detail };
    }
    // a resposta e o texto do ULTIMO passo; os anteriores sao a narracao entre ferramentas
    const texts = events.filter((e) => e.type === 'text' && e.part && e.part.text).map((e) => e.part.text);
    return { ok: true, resumeId: sessionId, text: texts.length ? texts[texts.length - 1] : '' };
  },
};
