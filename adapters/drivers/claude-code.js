// Driver do Claude Code: `claude -p` (modo nao-interativo), pedido por stdin,
// `--resume <session_id>` para continuar a conversa daquela sessao do FlowForge.
// Doc: https://code.claude.com/docs/en/headless

module.exports = {
  id: 'claude-code',
  label: 'Claude Code',

  // Padrao pensado pra CONVERSA de canvas, nao pra tarefa de engenharia: medido em
  // 18/09/2026, o modelo e o esforco padrao da maquina (Fable, high) gastaram ~30 s so
  // pensando num "Analisar" comum. `--model` / `--effort` no adapter sobem quando
  // a pergunta pedir profundidade.
  defaults: { model: 'sonnet', effort: 'medium' },

  async run({ cwd, prompt, resumeId, model, effort, extraArgs, runProcess, parseJsonLines }) {
    const args = [
      '-p',
      '--output-format', 'json',
      // edita arquivo sem perguntar; o resto (shell, rede) continua negado, que e
      // o que um pedido de "Analisar" precisa: ler o projeto e gravar dois JSON.
      '--permission-mode', 'acceptEdits',
      '--allowedTools', 'Read,Edit,Write,Glob,Grep',
    ];
    if (resumeId) args.push('--resume', resumeId);
    args.push('--model', model || this.defaults.model);
    args.push('--effort', effort || this.defaults.effort);
    args.push(...extraArgs);

    const r = await runProcess('claude', args, { cwd, stdin: prompt });
    if (r.timedOut) return { ok: false, error: 'claude excedeu o tempo limite' };

    // `--output-format json` devolve UM objeto; versoes com --verbose devolvem a lista de eventos
    let result = null;
    try {
      const parsed = JSON.parse(r.stdout);
      result = Array.isArray(parsed) ? parsed.filter((e) => e && e.type === 'result').pop() : parsed;
    } catch (e) {
      result = parseJsonLines(r.stdout).filter((e) => e.type === 'result').pop() || null;
    }
    if (!result) {
      return { ok: false, error: ('claude saiu com codigo ' + r.code + ': ' + (r.stderr || r.stdout)).slice(0, 600) };
    }
    if (r.code !== 0 || result.is_error) {
      return { ok: false, resumeId: null, error: String(result.result || r.stderr || 'erro sem detalhe').slice(0, 600) };
    }
    return { ok: true, resumeId: result.session_id || null, text: result.result || '' };
  },
};
