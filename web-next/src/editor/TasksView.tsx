// ============================================================================
// TasksView — a lente "Tarefas": o que o CLI tem pra fazer, em que pé está, e o
// que ele FEZ (FF-034 + FF-035).
//
// Só LÊ. Quem escreve é o agente no terminal — `adapters/tasks.js` no
// `<data-dir>/tasks.json`, e o hook do harness (`adapters/activity.js`) no
// `<data-dir>/activity.jsonl` — e o servidor empurra a cada mudança. É a mesma regra
// do resto do canvas — arquivo é a verdade (lei 2) — aplicada ao que não é desenho.
//
// Duas colunas: as listas (uma por publicador) e a linha do tempo. O elo entre elas é
// o `task` de cada ação, carimbado na escrita: é o que põe "arquivos tocados" dentro
// da tarefa sem o agente declarar nada.
//
// Cor: EIXO 2 da pele (execução — `--s-act`, `--s-done`, `--s-wait`), não o eixo de
// co-decisão: "concluída" não é "aprovada", e pintar as duas de verde igual misturaria
// as duas conversas.
// ============================================================================

import { useEffect, useMemo, useState } from 'react'
import type { ActivityEvent, TaskItem, TaskList, TasksFile, TaskStatus } from '../types.js'
import type { LensKey } from './lenses.js'

/** id do nó → como ele se chama e em que lente da sessão ABERTA ele é desenhado. */
export type NosDaSessao = Map<string, { rotulo: string; lens: LensKey }>

const ROTULO: Record<TaskStatus, string> = {
  pending: 'pendente',
  in_progress: 'em andamento',
  completed: 'concluída',
  blocked: 'travada'
}

/** "há 12 s", "há 4 min", "há 2 h" — recalculado pelo relógio do componente. */
function haQuanto(ts: number | undefined, agora: number): string {
  if (!ts) return ''
  const s = Math.max(0, Math.round((agora - ts) / 1000))
  if (s < 5) return 'agora'
  if (s < 60) return `há ${s} s`
  if (s < 3600) return `há ${Math.round(s / 60)} min`
  if (s < 86400) return `há ${Math.round(s / 3600)} h`
  return `há ${Math.round(s / 86400)} d`
}

const hora = (ts: number): string => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

export function contaTarefas(tasks: TasksFile): { feitas: number; total: number; andando: number; travadas: number } {
  let feitas = 0
  let total = 0
  let andando = 0
  let travadas = 0
  for (const l of tasks.lists) {
    for (const t of l.tasks) {
      total++
      if (t.status === 'completed') feitas++
      if (t.status === 'in_progress') andando++
      if (t.status === 'blocked') travadas++
    }
  }
  return { feitas, total, andando, travadas }
}

/**
 * Tira os turnos VAZIOS: "recebeu um pedido" seguido direto de "terminou o turno", sem ação
 * no meio — o agente só conversou. Numa sessão de conversa isso empilhava dez divisórias no
 * topo e escondia o trabalho (visto em uso em 18/09/2026). Turno com ação fica inteiro.
 */
function semTurnosVazios(events: ActivityEvent[]): ActivityEvent[] {
  const out: ActivityEvent[] = []
  for (const e of events) {
    const ant = out[out.length - 1]
    if (e.kind === 'stop' && ant && ant.kind === 'prompt' && ant.source === e.source) out.pop()
    else out.push(e)
  }
  return out
}

/** O que a linha do tempo sabe sobre UMA tarefa: quantas ações, quais arquivos, as últimas. */
interface Rastro {
  acoes: number
  editados: string[]
  lidos: string[]
  ultimas: Acao[]
}

const chave = (source: string, task: string): string => source + '::' + task

/** Uma ação, ou a MESMA ação repetida em sequência (`vezes` > 1). */
type Acao = ActivityEvent & { vezes: number }

/**
 * Junta repetições consecutivas. Um agente dirigindo o browser emite "usou …: computer" dez
 * vezes seguidas; dez linhas iguais empurram pra fora da tela a única que importa. Fica a
 * hora da ÚLTIMA e um "×10". Só junta vizinhas: a ordem da história não muda.
 */
function compacta(events: ActivityEvent[]): Acao[] {
  const out: Acao[] = []
  for (const e of events) {
    const ant = out[out.length - 1]
    if (ant && ant.source === e.source && ant.kind === e.kind && ant.summary === e.summary && ant.task === e.task && !ant.failed === !e.failed) {
      ant.vezes++
      ant.ts = e.ts
    } else out.push({ ...e, vezes: 1 })
  }
  return out
}

function rastros(activity: ActivityEvent[]): Map<string, Rastro> {
  const out = new Map<string, Rastro>()
  for (const e of activity) {
    if (!e.task || e.kind === 'prompt' || e.kind === 'stop') continue
    const k = chave(e.source, e.task)
    let r = out.get(k)
    if (!r) out.set(k, (r = { acoes: 0, editados: [], lidos: [], ultimas: [] }))
    r.acoes++
    for (const f of e.files ?? []) {
      const alvo = e.kind === 'edit' ? r.editados : r.lidos
      if (!alvo.includes(f)) alvo.push(f)
    }
    r.ultimas.push({ ...e, vezes: 1 })
  }
  for (const r of out.values()) {
    r.ultimas = compacta(r.ultimas).slice(-3)
    r.lidos = r.lidos.filter((f) => !r.editados.includes(f)) // editado não reaparece como "lido"
  }
  return out
}

export interface TasksViewProps {
  tasks: TasksFile
  activity: ActivityEvent[]
  /** O slug da sessão aberta — é dele que sai "este elo é daqui" (issue #8). */
  session: string
  nosDaSessao: NosDaSessao
  /** Leva ao desenho: troca de lente e centraliza o nó. */
  onIrParaNo: (id: string) => void
}

export function TasksView({ tasks, activity, session, nosDaSessao, onIrParaNo }: TasksViewProps): JSX.Element {
  // o "há 12 s" envelhece sozinho, sem depender de chegar arquivo novo
  const [agora, setAgora] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setAgora(Date.now()), 5000)
    return () => clearInterval(t)
  }, [])

  const porTarefa = useMemo(() => rastros(activity), [activity])

  // Quem está trabalhando AGORA vem primeiro; entre iguais, a mexida mais recente. Uma lista
  // 100% concluída de meia hora atrás não pode empurrar pra fora da tela a que está andando.
  const viva = (l: TaskList): number => (l.tasks.some((t) => t.status === 'in_progress' || t.status === 'blocked') ? 1 : 0)
  const listas = tasks.lists
    .filter((l) => l.tasks.length > 0)
    .sort((a, b) => viva(b) - viva(a) || b.updatedAt - a.updatedAt)

  if (listas.length === 0 && activity.length === 0) {
    return (
      <div className="tasksview">
        <div className="tk-vazio">
          <div className="tk-vazio-t">Nenhum agente publicou tarefas neste projeto.</div>
          <p>
            As tarefas vêm do terminal: o agente que está trabalhando no projeto publica o plano dele e vai marcando o
            andamento. Peça a ele, ou rode você mesmo:
          </p>
          <pre className="neon-mono">
            {'node <flowforge>/adapters/tasks.js plan "objetivo" "primeira tarefa" "segunda tarefa"\n'}
            {'node <flowforge>/adapters/tasks.js start 1\n'}
            {'node <flowforge>/adapters/tasks.js done 1'}
          </pre>
        </div>
      </div>
    )
  }

  return (
    <div className="tasksview com-tempo">
      <div className="tk-cols">
        {listas.map((l) => (
          <Lista key={l.id} lista={l} agora={agora} porTarefa={porTarefa} session={session} nosDaSessao={nosDaSessao} onIrParaNo={onIrParaNo} />
        ))}
      </div>
      <LinhaDoTempo activity={activity} tasks={tasks} agora={agora} />
    </div>
  )
}

function Lista({
  lista,
  agora,
  porTarefa,
  session,
  nosDaSessao,
  onIrParaNo
}: {
  lista: TaskList
  agora: number
  porTarefa: Map<string, Rastro>
  session: string
  nosDaSessao: NosDaSessao
  onIrParaNo: (id: string) => void
}): JSX.Element {
  const feitas = lista.tasks.filter((t) => t.status === 'completed').length
  const total = lista.tasks.length
  const andando = lista.tasks.some((t) => t.status === 'in_progress')
  const pct = total ? Math.round((feitas / total) * 100) : 0
  return (
    <section className={'tk-lista' + (andando ? ' viva' : '')}>
      <header className="tk-head">
        <div className="tk-quem neon-mono">
          {andando && <span className="tk-pulso" />}
          {lista.label}
          <span className="tk-quando">{haQuanto(lista.updatedAt, agora)}</span>
        </div>
        {lista.title && <h2 className="tk-titulo">{lista.title}</h2>}
        <div className="tk-barra" title={`${feitas} de ${total} concluídas`}>
          <span style={{ width: pct + '%' }} />
        </div>
        <div className="tk-placar neon-mono">
          {feitas}/{total} · {pct}%
        </div>
      </header>
      <ol className="tk-itens">
        {lista.tasks.map((t, i) => (
          <Item
            key={t.id}
            tarefa={t}
            n={i + 1}
            agora={agora}
            rastro={porTarefa.get(chave(lista.id, t.id))}
            session={session}
            nosDaSessao={nosDaSessao}
            onIrParaNo={onIrParaNo}
          />
        ))}
      </ol>
    </section>
  )
}

/**
 * A marca do status, DESENHADA (svg), não glifo de fonte nem truque de gradiente: o
 * "✓" feito com uma faixa diagonal em CSS lia como sinal de proibido (visto em uso
 * em 18/09/2026). Forma + cor, pra não depender só da cor.
 */
function Marca({ status }: { status: TaskStatus }): JSX.Element {
  return (
    <svg className="tk-marca" viewBox="0 0 14 14" role="img" aria-label={ROTULO[status]}>
      {status === 'completed' && (
        <>
          <circle cx="7" cy="7" r="6.25" className="tk-m-cheia" />
          <path d="M4 7.3 L6.2 9.4 L10.1 4.9" className="tk-m-visto" />
        </>
      )}
      {status === 'in_progress' && (
        <>
          <circle cx="7" cy="7" r="5.5" className="tk-m-anel tk-m-gira" />
          <circle cx="7" cy="7" r="2.2" className="tk-m-cheia" />
        </>
      )}
      {status === 'blocked' && (
        <>
          <rect x="1.5" y="1.5" width="11" height="11" rx="2.5" className="tk-m-anel" />
          <path d="M7 3.8 V8 M7 10 V10.4" className="tk-m-visto tk-m-alerta" />
        </>
      )}
      {status === 'pending' && <circle cx="7" cy="7" r="5.5" className="tk-m-anel" />}
    </svg>
  )
}

const nomeCurto = (f: string): string => f.split('/').pop() || f

/**
 * O ELO com o desenho (issue #8). Na sessão aberta vira botão: clicar troca para
 * a lente que desenha o nó e voa até ele. Fora dela é só texto `sessão/nó` — o
 * desenho está noutra prancheta, e trocar de sessão é gesto da topbar, não um
 * efeito colateral de clicar numa tarefa.
 */
function Elo({
  tarefa,
  session,
  nosDaSessao,
  onIrParaNo
}: {
  tarefa: TaskItem
  session: string
  nosDaSessao: NosDaSessao
  onIrParaNo: (id: string) => void
}): JSX.Element | null {
  const elo = tarefa.node
  if (!elo) return null
  const aqui = elo.session === session
  const no = aqui ? nosDaSessao.get(elo.id) : undefined
  if (!aqui) {
    return (
      <span className="tk-elo fora neon-mono" title={`esta etapa está no desenho "${elo.session}" — abra essa sessão lá em cima para vê-la`}>
        ↳ {elo.session}/{elo.id}
      </span>
    )
  }
  if (!no) {
    // o agente ligou a tarefa a um nó que ainda não existe (ou que foi apagado):
    // o elo fica visível, dizendo o que houve, em vez de sumir sem explicação
    return (
      <span className="tk-elo orfao neon-mono" title="o elo aponta um nó que esta sessão não tem (ainda não foi desenhado, ou foi apagado)">
        ↳ {elo.id} · sem nó
      </span>
    )
  }
  return (
    <button className="tk-elo neon-mono" onClick={() => onIrParaNo(elo.id)} title={`ir até "${no.rotulo}" no desenho`}>
      ↳ {no.rotulo}
    </button>
  )
}

function Item({
  tarefa,
  n,
  agora,
  rastro,
  session,
  nosDaSessao,
  onIrParaNo
}: {
  tarefa: TaskItem
  n: number
  agora: number
  rastro?: Rastro
  session: string
  nosDaSessao: NosDaSessao
  onIrParaNo: (id: string) => void
}): JSX.Element {
  const andando = tarefa.status === 'in_progress'
  return (
    <li className={'tk-item st-' + tarefa.status} title={ROTULO[tarefa.status]}>
      <span className="tk-n neon-mono">{n}</span>
      <Marca status={tarefa.status} />
      <div className="tk-corpo">
        <div className="tk-nome">{tarefa.title}</div>
        {tarefa.note && <div className="tk-nota">{tarefa.note}</div>}
        <Elo tarefa={tarefa} session={session} nosDaSessao={nosDaSessao} onIrParaNo={onIrParaNo} />
        {rastro && (
          <div className="tk-rastro neon-mono">
            {/* na tarefa viva, o que ele está fazendo AGORA; nas outras, só o saldo */}
            {andando && rastro.ultimas.length > 0 && (
              <ul className="tk-agora">
                {rastro.ultimas.map((e, i) => (
                  <li key={e.ts + ':' + i} className={e.failed ? 'falhou' : ''}>
                    {e.summary}
                    {e.vezes > 1 && <span className="tk-vezes"> ×{e.vezes}</span>}
                  </li>
                ))}
              </ul>
            )}
            {rastro.editados.length > 0 && (
              <div className="tk-arqs" title={rastro.editados.join('\n')}>
                <span className="tk-arqs-l">editou</span>
                {rastro.editados.slice(0, 6).map((f) => (
                  <span key={f} className="tk-arq">
                    {nomeCurto(f)}
                  </span>
                ))}
                {rastro.editados.length > 6 && <span className="tk-arq mais">+{rastro.editados.length - 6}</span>}
              </div>
            )}
            <div className="tk-saldo">
              {rastro.acoes} {rastro.acoes === 1 ? 'ação' : 'ações'}
              {rastro.lidos.length > 0 && ` · leu ${rastro.lidos.length} arquivo${rastro.lidos.length === 1 ? '' : 's'}`}
            </div>
          </div>
        )}
      </div>
      {(andando || tarefa.status === 'blocked') && <span className="tk-ha neon-mono">{haQuanto(tarefa.updatedAt, agora)}</span>}
    </li>
  )
}

/**
 * A linha do tempo: o que o agente fez, a mais nova em cima. `prompt` e `stop` viram
 * divisórias de turno — é o que deixa ler "neste pedido ele fez isto".
 */
function LinhaDoTempo({ activity, tasks, agora }: { activity: ActivityEvent[]; tasks: TasksFile; agora: number }): JSX.Element {
  const numeroDaTarefa = useMemo(() => {
    const m = new Map<string, string>()
    for (const l of tasks.lists) l.tasks.forEach((t, i) => m.set(chave(l.id, t.id), `${i + 1}`))
    return m
  }, [tasks])
  const recentes = useMemo(() => compacta(semTurnosVazios(activity.slice(-160))).slice(-80).reverse(), [activity])
  const ultima = activity.length ? activity[activity.length - 1]! : null
  const trabalhando = !!ultima && ultima.kind !== 'stop' && agora - ultima.ts < 120000

  return (
    <aside className={'tk-tempo' + (trabalhando ? ' viva' : '')}>
      <header className="tk-tempo-head neon-mono">
        {trabalhando && <span className="tk-pulso" />}
        linha do tempo
        <span className="tk-quando">{ultima ? haQuanto(ultima.ts, agora) : ''}</span>
      </header>
      {recentes.length === 0 ? (
        <p className="tk-tempo-vazio">
          Nenhuma ação registrada. A linha do tempo é alimentada por um hook do harness:
          <code className="neon-mono"> node &lt;flowforge&gt;/adapters/activity.js install claude-code</code>
        </p>
      ) : (
        <ol className="tk-eventos">
          {recentes.map((e, i) =>
            e.kind === 'prompt' || e.kind === 'stop' ? (
              <li key={e.ts + ':' + i} className={'tk-ev marco k-' + e.kind}>
                <span className="tk-ev-h neon-mono">{hora(e.ts)}</span>
                <span className="tk-ev-marco">{e.kind === 'prompt' ? `${e.label} recebeu um pedido` : `${e.label} terminou o turno`}</span>
              </li>
            ) : (
              <li key={e.ts + ':' + i} className={'tk-ev k-' + e.kind + (e.failed ? ' falhou' : '')}>
                <span className="tk-ev-h neon-mono">{hora(e.ts)}</span>
                <span className="tk-ev-dot" aria-hidden="true" />
                <span className="tk-ev-t">
                  {e.summary}
                  {e.vezes > 1 && <span className="tk-vezes"> ×{e.vezes}</span>}
                  {e.failed && <em> · falhou</em>}
                </span>
                {e.task && numeroDaTarefa.has(chave(e.source, e.task)) && (
                  <span className="tk-ev-task neon-mono" title="tarefa em andamento quando isto aconteceu">
                    #{numeroDaTarefa.get(chave(e.source, e.task))}
                  </span>
                )}
              </li>
            )
          )}
        </ol>
      )}
    </aside>
  )
}
