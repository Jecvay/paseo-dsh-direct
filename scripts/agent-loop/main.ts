/**
 * GitHub-driven agent loop — the long-running service (systemd user unit
 * `paseo-dsh-direct-agent.service`). Every minute it asks GitHub for new
 * owner instructions, queues them, and runs them one at a time: a throwaway
 * clone, a sandboxed `dsh --profile headless` run (read-only host, no
 * credentials), then the commits come back as a git bundle and gates /
 * push / PR / comments are done here from the service's own repo.
 *
 * All decisions live in ./core.ts; this file only does I/O.
 * Mechanism and operations: docs/board.md.
 *
 * Environment overrides:
 *   PASEO_AGENT_CONFIG     machine-local config (default ~/.config/paseo-dsh-direct/agent.json)
 *   PASEO_AGENT_STATE_DIR  state, logs and worktrees (default ~/.local/state/paseo-dsh-direct/agent)
 *   PASEO_AGENT_ONCE=1     run a single poll + at most one task, then exit
 */

import { spawn, spawnSync } from 'node:child_process'
import { constants as fsConstants, existsSync, lstatSync, mkdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, appendFileSync, openSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  EMPTY_CURSOR,
  GO_LABEL,
  baseBranchFor,
  OUT_MAX_BYTES,
  buildPrompt,
  clipOut,
  isInside,
  bwrapArgv,
  decideOutcome,
  dshArgv,
  enqueue,
  inScope,
  issueBranch,
  logId,
  parseConfig,
  parseDshEvents,
  rememberHandled,
  scanBoard,
  scanComments,
  scanEvents,
  scrubEnv,
  selectDsh,
  stageAfterReply,
  tail,
  withMarker,
  type Cursor,
  type GhComment,
  type GhIssueEvent,
  type LoopConfig,
  type Outcome,
  type ThreadEntry,
  type Trigger,
} from './core.ts'

const HOME = homedir()
const REPO_ROOT = resolve(import.meta.dirname, '../..')
const CONFIG_PATH = process.env.PASEO_AGENT_CONFIG ?? join(HOME, '.config/paseo-dsh-direct/agent.json')
const STATE_DIR = process.env.PASEO_AGENT_STATE_DIR ?? join(HOME, '.local/state/paseo-dsh-direct/agent')
const SERVICE_DIR = join(STATE_DIR, 'service')
const STATE_FILE = join(SERVICE_DIR, 'state.json')
const LOCK_FILE = join(SERVICE_DIR, 'lock')
const LOG_DIR = join(STATE_DIR, 'logs')
const WORKTREE_DIR = join(STATE_DIR, 'worktrees')
const TASK_DIR = join(STATE_DIR, 'tasks')
const EMPTY_GH_DIR = join(STATE_DIR, 'empty-gh-config')
const ONCE = process.env.PASEO_AGENT_ONCE === '1'

const TASK_TIMEOUT_MS = 60 * 60 * 1000
const REPLY_TIMEOUT_MS = 15 * 60 * 1000
const GATE_TIMEOUT_MS = 20 * 60 * 1000

// ---------- state ----------

interface ThreadState {
  sessionId?: string
  dshLine?: string
  branch?: string
  base?: string
  issue?: number
  pr?: number
  inScope?: boolean
}

interface Running { trigger: Trigger; logId: string; startedAt: string }

interface LoopState {
  cursor: Cursor
  queue: Trigger[]
  handled: string[]
  running?: Running
  threads: Record<string, ThreadState>
  prThreads: Record<string, string>
  boardSeq: number
}

function loadState(): LoopState {
  const empty: LoopState = { cursor: { ...EMPTY_CURSOR }, queue: [], handled: [], threads: {}, prThreads: {}, boardSeq: 0 }
  if (!existsSync(STATE_FILE)) return empty
  return { ...empty, ...(JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Partial<LoopState>) }
}

function saveState(state: LoopState): void {
  const tmp = `${STATE_FILE}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(tmp, STATE_FILE)
}

function acquireLock(): void {
  if (existsSync(LOCK_FILE)) {
    const holder = Number.parseInt(readFileSync(LOCK_FILE, 'utf8').trim(), 10)
    if (Number.isInteger(holder) && holder !== process.pid) {
      try {
        process.kill(holder, 0)
        say(`另一个实例在运行（pid ${holder}），退出`)
        process.exit(0)
      } catch { /* stale lock */ }
    }
    unlinkSync(LOCK_FILE)
  }
  const fd = openSync(LOCK_FILE, 'wx')
  writeFileSync(fd, String(process.pid))
  closeSync(fd)
  process.on('exit', () => { try { unlinkSync(LOCK_FILE) } catch { /* gone */ } })
}

// ---------- process helpers ----------

function say(message: string): void {
  console.log(`agent-loop: ${message}`)
}

interface RunResult { status: number | null; stdout: string; stderr: string }

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeout?: number } = {}): RunResult {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd ?? REPO_ROOT,
    env: opts.env ?? process.env,
    input: opts.input,
    encoding: 'utf8',
    timeout: opts.timeout,
    maxBuffer: 64 * 1024 * 1024,
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: `${result.stderr ?? ''}${result.error ? `\n${result.error.message}` : ''}` }
}

function must(result: RunResult, what: string): string {
  if (result.status !== 0) throw new Error(`${what} 失败：${(result.stderr || result.stdout).trim().slice(0, 2000)}`)
  return result.stdout
}

/** git with hooks disabled: the service never runs hooks the agent could have written. */
function git(args: string[], cwd = REPO_ROOT): RunResult {
  return run('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd })
}

let config: LoopConfig

/** gh with a short retry on GitHub 5xx / connection errors; anything else fails at once. */
function gh(args: string[], what: string): string {
  for (let attempt = 1; ; attempt++) {
    const result = run('gh', args)
    const transient = /HTTP 5\d\d|Server Error|timeout|connection reset|EOF/i.test(result.stderr)
    if (result.status === 0 || !transient || attempt >= 3) return must(result, what)
    say(`${what} 遇到 GitHub 临时错误，${attempt * 5} 秒后重试：${result.stderr.trim().slice(0, 200)}`)
    spawnSync('sleep', [String(attempt * 5)])
  }
}

function ghApiLines<T>(path: string, jq: string, paginate = false): T[] {
  const args = ['api', path, '--jq', jq]
  if (paginate) args.splice(2, 0, '--paginate')
  const out = gh(args, `GitHub API ${path}`)
  return out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as T)
}

function board(args: string[]): RunResult {
  return run(join(REPO_ROOT, 'node_modules/.bin/tsx'), [join(REPO_ROOT, 'scripts/board.ts'), ...args])
}

function stageOf(number: number): string | null {
  const result = board(['stage', String(number)])
  if (result.status !== 0) return null
  return (JSON.parse(result.stdout) as { stage: string | null }).stage
}

function moveCard(number: number | undefined, stage: string, log: (m: string) => void): void {
  if (!number) return
  const result = board(['move', String(number), stage])
  log(result.status === 0 ? `卡片 #${number} → ${stage}` : `挪卡 #${number} → ${stage} 失败：${result.stderr.trim()}`)
}

function comment(number: number, body: string): string {
  const out = gh(['api', `repos/${config.repo}/issues/${number}/comments`, '-f', `body=${withMarker(body)}`, '--jq', '.html_url'], `评论 #${number}`)
  return out.trim()
}

// ---------- polling ----------

interface IssueInfo {
  number: number
  title: string
  body: string
  author: string
  labels: string[]
  isPr: boolean
  state: string
}

function issueInfo(number: number): IssueInfo {
  const [info] = ghApiLines<IssueInfo>(
    `repos/${config.repo}/issues/${number}`,
    '{number, title, body: (.body // ""), author: .user.login, labels: [.labels[].name], isPr: (.pull_request != null), state}',
  )
  return info
}

function threadKeyFor(state: LoopState, number: number, isPr: boolean): string {
  return isPr ? (state.prThreads[String(number)] ?? `pr-${number}`) : `issue-${number}`
}

function initCursor(state: LoopState): void {
  if (state.cursor.lastCommentId === 0) {
    const [latest] = ghApiLines<{ id: number }>(`repos/${config.repo}/issues/comments?sort=created&direction=desc&per_page=1`, '.[] | {id}')
    state.cursor.lastCommentId = latest?.id ?? 1
    say(`初始化评论游标 ${state.cursor.lastCommentId}`)
  }
  if (state.cursor.lastEventId === 0) {
    const [latest] = ghApiLines<{ id: number }>(`repos/${config.repo}/issues/events?per_page=1`, '.[] | {id}')
    state.cursor.lastEventId = latest?.id ?? 1
    say(`初始化事件游标 ${state.cursor.lastEventId}`)
  }
}

function poll(state: LoopState): void {
  initCursor(state)
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const comments = ghApiLines<GhComment>(
    `repos/${config.repo}/issues/comments?sort=created&direction=asc&per_page=100&since=${since}`,
    '.[] | {id, body, user: (if .user then {login: .user.login} else null end), issue_url, html_url, created_at}',
    true,
  )
  const byComments = scanComments(comments, state.cursor.lastCommentId, config.owner)

  const events = ghApiLines<GhIssueEvent>(
    `repos/${config.repo}/issues/events?per_page=100`,
    '.[] | {id, event, actor: (if .actor then {login: .actor.login} else null end), label: (if .label then {name: .label.name} else null end), issue: (if .issue then {number: .issue.number} else null end)}',
  )
  const byEvents = scanEvents(events, state.cursor.lastEventId, config.owner)

  let byBoard = { triggers: [] as Trigger[], boardReady: state.cursor.boardReady }
  const status = board(['status'])
  if (status.status === 0) {
    const view = JSON.parse(status.stdout) as { stages: Record<string, { number: number }[]> }
    byBoard = scanBoard((view.stages['待开工'] ?? []).map((c) => c.number), state.cursor.boardReady, state.boardSeq + 1)
    if (byBoard.triggers.length > 0) state.boardSeq += 1
  } else {
    say(`读取看板失败（本轮跳过看板）：${status.stderr.trim().slice(0, 300)}`)
  }

  const accepted: Trigger[] = []
  for (const trigger of [...byComments.triggers, ...byEvents.triggers, ...byBoard.triggers]) {
    let info: IssueInfo
    try {
      info = issueInfo(trigger.number)
    } catch (error) {
      say(`读取 #${trigger.number} 失败，丢弃 ${trigger.id}：${String(error)}`)
      continue
    }
    const key = threadKeyFor(state, trigger.number, info.isPr)
    const known = state.threads[key]?.inScope === true
    if (!inScope(info.labels, config.onlyLabel, known)) {
      say(`${trigger.id} 在 #${trigger.number}，不在范围内（只处理带 ${config.onlyLabel} 标签的），跳过`)
      continue
    }
    accepted.push(trigger)
    say(`收到指令 ${trigger.id}（#${trigger.number}）${trigger.instruction ? `：${trigger.instruction.slice(0, 80)}` : ''}`)
  }

  state.queue = enqueue(state.queue, state.handled, accepted)
  state.cursor = { lastCommentId: byComments.lastCommentId, lastEventId: byEvents.lastEventId, boardReady: byBoard.boardReady }
}

// ---------- sandboxed child processes ----------

/**
 * What one task's sandboxed processes may write. Everything else on the
 * host is read-only inside bubblewrap, and credential files are hidden.
 */
interface Box { writable: string[]; dshHome: string; npmCache: string }

function hiddenPaths(): { path: string; isDir: boolean }[] {
  return config.hidePaths
    .filter((p) => existsSync(p))
    .map((p) => ({ path: p, isDir: statSync(p).isDirectory() }))
}

/** Agent DSH_HOME for one dsh line, with a placeholder the real credentials file is bound over. */
function agentDshHome(line: string): string {
  const home = join(config.dshHome, line)
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const placeholder = join(home, '.credentials.yaml')
  if (!existsSync(placeholder)) writeFileSync(placeholder, '', { mode: 0o600 })
  return home
}

function sandboxArgv(command: string[], cwd: string, box: Box): string[] {
  const readOnlyFiles = existsSync(config.credentials) ? [{ src: config.credentials, dest: join(box.dshHome, '.credentials.yaml') }] : []
  return bwrapArgv(command, { writable: box.writable, readOnlyFiles, hide: hiddenPaths(), cwd })
}

function boxEnv(box: Box): Record<string, string> {
  mkdirSync(EMPTY_GH_DIR, { recursive: true })
  return scrubEnv(process.env, { ghConfigDir: EMPTY_GH_DIR, dshHome: box.dshHome, npmCache: box.npmCache })
}

function runSandboxed(command: string[], cwd: string, box: Box, timeout: number): RunResult {
  const [cmd, ...args] = sandboxArgv(command, cwd, box)
  return run(cmd, args, { cwd: '/', env: boxEnv(box), timeout })
}

let activeChild: ReturnType<typeof spawn> | undefined

interface DshRun { exitCode: number | null; killedFor?: 'timeout' | 'reply-timeout'; jsonl: string }

function runDsh(argv: string[], prompt: string, cwd: string, box: Box, jsonlPath: string, logPath: string, startHead: string): Promise<DshRun> {
  return new Promise((resolvePromise) => {
    const [cmd, ...args] = sandboxArgv(argv, cwd, box)
    const child = spawn(cmd, args, { cwd: '/', env: boxEnv(box), detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    activeChild = child
    let jsonl = ''
    let killedFor: DshRun['killedFor']
    const started = Date.now()
    child.stdout.on('data', (chunk: Buffer) => {
      jsonl += chunk.toString('utf8')
      appendFileSync(jsonlPath, chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => appendFileSync(logPath, chunk))
    child.stdin.end(prompt)
    const kill = (why: 'timeout' | 'reply-timeout'): void => {
      if (killedFor) return
      killedFor = why
      appendFileSync(logPath, `\n[agent-loop] 终止 dsh：${why}\n`)
      try { process.kill(-child.pid!, 'SIGTERM') } catch { /* already gone */ }
      setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL') } catch { /* gone */ } }, 10_000).unref()
    }
    const timer = setInterval(() => {
      const elapsed = Date.now() - started
      if (elapsed > TASK_TIMEOUT_MS) kill('timeout')
      else if (elapsed > REPLY_TIMEOUT_MS && !killedFor) {
        // The worktree is dsh-writable: inspect it only from inside the sandbox.
        const head = runSandboxed(['git', 'rev-parse', 'HEAD'], cwd, box, 60_000).stdout.trim()
        const dirty = runSandboxed(['git', 'status', '--porcelain'], cwd, box, 60_000).stdout.trim()
        if (head === startHead && !dirty) kill('reply-timeout')
      }
    }, 30_000)
    child.on('close', (code) => {
      clearInterval(timer)
      activeChild = undefined
      resolvePromise({ exitCode: code, killedFor, jsonl })
    })
  })
}

// ---------- one task ----------

/**
 * Read a result file dsh left behind as plain data: a regular file directly
 * under a real `.agent-out/` directory (no symlinks), clipped in size.
 */
function readOut(worktree: string, name: string): string | undefined {
  const dir = join(worktree, '.agent-out')
  try {
    if (!lstatSync(dir).isDirectory()) return undefined
    const path = join(dir, name)
    if (!lstatSync(path).isFile()) return undefined
    if (!isInside(realpathSync(dir), realpathSync(path))) return undefined
    const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    try {
      const buffer = Buffer.alloc(OUT_MAX_BYTES + 1)
      const size = readSync(fd, buffer, 0, buffer.length, 0)
      return clipOut(buffer.subarray(0, size).toString('utf8'))
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
}

function threadEntries(number: number): ThreadEntry[] {
  return ghApiLines<ThreadEntry>(
    `repos/${config.repo}/issues/${number}/comments?per_page=100`,
    '.[] | {author: (.user.login // "ghost"), body: (.body // ""), createdAt: .created_at}',
    true,
  )
}

function reviewEntries(number: number): ThreadEntry[] {
  return ghApiLines<ThreadEntry>(
    `repos/${config.repo}/pulls/${number}/reviews?per_page=100`,
    '.[] | select((.body // "") != "") | {author: (.user.login // "ghost"), body: ("[review " + .state + "] " + .body), createdAt: .submitted_at}',
    true,
  )
}

/** A fresh standalone clone (`--shared` with the service clone's objects) checked out at `sha`. */
function freshClone(path: string, sha: string, branch: string | undefined): void {
  rmSync(path, { recursive: true, force: true })
  must(git(['clone', '--quiet', '--shared', '--no-checkout', REPO_ROOT, path]), '创建工作树')
  must(git(branch ? ['checkout', '--quiet', '-B', branch, sha] : ['checkout', '--quiet', '--detach', sha], path), '检出工作树')
  appendFileSync(join(path, '.git/info/exclude'), '\n.agent-out/\n')
}

const sha = (ref: string): string | undefined => {
  const result = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  return result.status === 0 ? result.stdout.trim() : undefined
}

interface Start { startSha: string; compareSha: string; from: string }

/**
 * Where the task starts: this thread's unpushed commits (refs/agent/<key>)
 * when they build on the remote branch, else the remote branch, else the base.
 */
function resolveStart(key: string, branch: string, base: string): Start {
  const remote = sha(`refs/remotes/origin/${branch}`)
  const compareSha = remote ?? sha(`refs/remotes/origin/${base}`)
  if (!compareSha) throw new Error(`远端没有分支 ${base}`)
  const agent = sha(`refs/agent/${key}`)
  if (agent && agent !== compareSha && git(['merge-base', '--is-ancestor', compareSha, agent]).status === 0) {
    return { startSha: agent, compareSha, from: `上次没推送的提交 refs/agent/${key}` }
  }
  return { startSha: compareSha, compareSha, from: remote ? `origin/${branch}` : `origin/${base}` }
}

const MAX_BUNDLE_BYTES = 200 * 1024 * 1024

/**
 * Carry dsh's commits out of the dsh-writable repo: a sandboxed
 * `git bundle create`, then a fetch of that bundle into the service's own
 * repo as refs/agent/<key>. Returns how many commits it has beyond compareSha.
 */
function collectCommits(worktree: string, outDir: string, box: Box, key: string, compareSha: string, log: (m: string) => void): number {
  const agentRef = `refs/agent/${key}`
  const bundle = join(outDir, 'work.bundle')
  const made = runSandboxed(['git', 'bundle', 'create', bundle, 'HEAD', `^${compareSha}`], worktree, box, 5 * 60_000)
  let stat
  try { stat = lstatSync(bundle) } catch { stat = undefined }
  if (!stat) {
    log(`没有可收集的提交（git bundle：${tail(made.stderr, 3).trim()}）`)
    git(['update-ref', '-d', agentRef])
    return 0
  }
  if (!stat.isFile() || stat.size > MAX_BUNDLE_BYTES) throw new Error(`收集提交失败：bundle 不是普通文件或超过 ${MAX_BUNDLE_BYTES} 字节`)
  must(git(['bundle', 'verify', '--quiet', bundle]), '校验 bundle')
  must(git(['fetch', '--quiet', '--no-tags', bundle, `+HEAD:${agentRef}`]), '从 bundle 取回提交')
  return Number(git(['rev-list', '--count', `${compareSha}..${agentRef}`]).stdout.trim() || '0')
}

interface Gate { name: string; ok: boolean; summary: string; output: string }

/** Run the gates on a clean checkout of exactly the commit that will be pushed. */
function runGates(gateDir: string, agentRef: string, box: Box, log: (m: string) => void): Gate[] {
  // The gate clone has no refs/agent/*; check out the commit id (objects come via alternates).
  const commit = sha(agentRef)
  if (!commit) throw new Error(`找不到 ${agentRef}`)
  freshClone(gateDir, commit, undefined)
  const install = runSandboxed(['npm', 'ci', '--no-audit', '--no-fund'], gateDir, box, GATE_TIMEOUT_MS)
  if (install.status !== 0) return [{ name: 'ci', ok: false, summary: '', output: `${install.stdout}\n${install.stderr}` }]
  const gates: Gate[] = []
  for (const name of ['build', 'typecheck', 'test', 'verify:notes', 'verify:docs']) {
    const args = name === 'build' ? ['npm', 'run', '--if-present', name] : ['npm', 'run', name]
    const result = runSandboxed(args, gateDir, box, GATE_TIMEOUT_MS)
    const output = `${result.stdout}\n${result.stderr}`
    const counts = name === 'test' ? output.match(/^(?:ℹ|#) (?:pass|fail) \d+$/gm)?.map((l) => l.slice(2)).join(', ') ?? '' : ''
    const gate = { name, ok: result.status === 0, summary: counts, output }
    log(`门禁 npm run ${name}：${gate.ok ? '通过' : `失败（退出码 ${result.status}）`} ${counts}`)
    gates.push(gate)
    if (!gate.ok) break
  }
  return gates
}

async function runTask(state: LoopState, trigger: Trigger): Promise<void> {
  const info = issueInfo(trigger.number)
  const key = threadKeyFor(state, trigger.number, info.isPr)
  const thread: ThreadState = (state.threads[key] ??= {})
  thread.inScope = true
  if (!info.isPr) thread.issue = trigger.number
  const id = logId(new Date(), key)
  const logPath = join(LOG_DIR, `${id}.log`)
  const log = (message: string): void => {
    appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`)
    say(`[${id}] ${message}`)
  }
  state.running = { trigger, logId: id, startedAt: new Date().toISOString() }
  saveState(state)
  log(`开始 ${trigger.id}（${info.isPr ? 'PR' : 'issue'} #${trigger.number}，线程 ${key}）`)

  const cardIssue = info.isPr ? thread.issue : trigger.number
  const previousStage = cardIssue ? stageOf(cardIssue) : null
  comment(trigger.number, `收到，开始。日志编号 \`${id}\`。`)
  if (trigger.source === 'label') run('gh', ['api', '-X', 'DELETE', `repos/${config.repo}/issues/${trigger.number}/labels/${encodeURIComponent(GO_LABEL)}`])
  moveCard(cardIssue, '进行中', log)

  // Stable per-thread path: a dsh session's cwd cannot change between follow-ups.
  const worktree = join(WORKTREE_DIR, key)
  const taskDir = join(TASK_DIR, id)
  const outDir = join(taskDir, 'out')
  const npmCache = join(taskDir, 'npm-cache')
  const gateDir = join(taskDir, 'gate')
  const agentRef = `refs/agent/${key}`
  const report = (text: string, stage: string | null): void => {
    const url = comment(trigger.number, `${text}\n\n日志编号 \`${id}\`。`)
    log(`已评论 ${url}`)
    if (stage) moveCard(cardIssue, stage, log)
  }

  try {
    mkdirSync(outDir, { recursive: true })
    mkdirSync(npmCache, { recursive: true })
    mkdirSync(gateDir, { recursive: true })
    must(git(['fetch', '--quiet', '--prune', 'origin']), 'git fetch')
    let branch: string
    let base: string
    if (info.isPr) {
      const pr = JSON.parse(gh(['pr', 'view', String(trigger.number), '--repo', config.repo, '--json', 'headRefName,baseRefName,isCrossRepository,state'], '读取 PR')) as { headRefName: string; baseRefName: string; isCrossRepository: boolean; state: string }
      if (pr.isCrossRepository) { report('这个 PR 来自 fork，服务只处理本仓库分支上的 PR，没有开工。', null); return }
      if (pr.state !== 'OPEN') { report(`这个 PR 已经是 ${pr.state} 状态，没有开工。`, null); return }
      branch = pr.headRefName
      base = pr.baseRefName
      thread.pr = trigger.number
      state.prThreads[String(trigger.number)] = key
    } else {
      base = baseBranchFor(info.labels)
      branch = thread.branch ?? issueBranch(trigger.number, info.title)
    }
    thread.branch = branch
    thread.base = base
    const start = resolveStart(key, branch, base)

    // Pick dsh from the service's own copy of package.json, not from the worktree.
    const pkg = JSON.parse(must(git(['show', `${start.startSha}:package.json`]), '读取 package.json')) as { version: string }
    const choice = selectDsh(pkg.version, config.dsh)
    if (!choice.ok) { log(`选 dsh 失败：${choice.reason}`); report(`没有开工：${choice.reason}。`, '受阻'); return }
    const dshHome = agentDshHome(choice.line)
    const box: Box = { writable: [worktree, outDir, npmCache, dshHome], dshHome, npmCache }
    const gateBox: Box = { writable: [gateDir, npmCache], dshHome, npmCache }

    freshClone(worktree, start.startSha, branch)
    log(`工作树 ${worktree}（独立 clone）：分支 ${branch} 从 ${start.from} 开始`)
    const version = runSandboxed([choice.exe, '--version'], worktree, box, 60_000)
    if (version.status !== 0) { report(`没有开工：dsh（${choice.exe}）跑 --version 失败：${tail(version.stderr, 10)}`, '受阻'); return }
    const dshVersion = version.stdout.trim()
    log(`基线 ${base}，package.json ${pkg.version} → dsh ${choice.line} 线：${choice.exe}（--version ${dshVersion}），DSH_HOME ${dshHome}`)

    const install = runSandboxed(['npm', 'ci', '--no-audit', '--no-fund'], worktree, box, GATE_TIMEOUT_MS)
    if (install.status !== 0) { log(`npm ci 失败：${tail(install.stderr, 20)}`); report(`没有开工：工作树里 \`npm ci\` 失败。\n\n\`\`\`\n${tail(install.stderr, 30)}\n\`\`\``, '受阻'); return }
    log('npm ci 完成')

    const resume = thread.sessionId && thread.dshLine === choice.line ? thread.sessionId : undefined
    const entries = [...threadEntries(trigger.number), ...(info.isPr ? reviewEntries(trigger.number) : [])]
    const prompt = buildPrompt({
      owner: config.owner, repo: config.repo, kind: info.isPr ? 'pr' : 'issue', number: trigger.number, title: info.title,
      body: info.body, author: info.author, entries, instruction: trigger.instruction, branch, base, resumed: !!resume,
    })
    writeFileSync(join(LOG_DIR, `${id}.prompt.md`), prompt)
    const argv = dshArgv(choice.exe, config.patch, resume)
    log(`启动 dsh：${argv.join(' ')}${resume ? `（接着会话 ${resume}）` : '（新会话）'}`)
    const dsh = await runDsh(argv, prompt, worktree, box, join(LOG_DIR, `${id}.jsonl`), logPath, start.startSha)
    const summary = parseDshEvents(dsh.jsonl)
    if (summary.sessionId) {
      thread.sessionId = summary.sessionId
      thread.dshLine = choice.line
    }
    log(`dsh 结束：退出码 ${dsh.exitCode}${dsh.killedFor ? `，被终止（${dsh.killedFor}）` : ''}，会话 ${summary.sessionId ?? '未知'}，turn_end=${summary.turnEnd ?? '无'}`)
    saveState(state)

    const newCommits = collectCommits(worktree, outDir, box, key, start.compareSha, log)
    const outcome: Outcome = decideOutcome({
      exitCode: dsh.exitCode, killedFor: dsh.killedFor, newCommits,
      reply: readOut(worktree, 'reply.md'), prTitle: readOut(worktree, 'pr-title.txt'), blocked: readOut(worktree, 'blocked.md'),
    })
    log(`新提交 ${newCommits} 个，结论 ${outcome.kind}`)
    const sessionLine = `dsh ${dshVersion}，会话 \`${summary.sessionId ?? '未知'}\``

    switch (outcome.kind) {
      case 'failed':
        report(`任务没完成：${outcome.reason}。${newCommits > 0 ? `有 ${newCommits} 个提交没有推送。` : ''}同一条指令不会自动重试，要重来请再发一次 \`@agent ...\`。\n\n${sessionLine}。`, '受阻')
        return
      case 'blocked':
        report(`**需要你拍板**（回复 \`@agent ...\` 后接着同一个会话继续）：\n\n${outcome.question}${outcome.reply ? `\n\n---\n\n${outcome.reply}` : ''}\n\n${sessionLine}。`, '受阻')
        return
      case 'no-output':
        report(`dsh 正常结束，但既没有提交也没有写 \`.agent-out/reply.md\`，不知道结果是什么。\n\n${sessionLine}。`, '受阻')
        return
      case 'reply':
        report(`${outcome.reply}\n\n${sessionLine}。`, null)
        moveCard(cardIssue, stageAfterReply(previousStage), log)
        return
      case 'push':
        break
    }

    const gates = runGates(gateDir, agentRef, gateBox, log)
    const failed = gates.find((g) => !g.ok)
    if (failed) {
      report(`改动已经提交，但门禁 \`npm run ${failed.name}\` 没过，所以没有推送。\n\n\`\`\`\n${tail(failed.output, 60)}\n\`\`\`\n\n${sessionLine}。`, '受阻')
      return
    }
    // Everything below runs in the service's own repo, never in the dsh-writable clone.
    const commits = git(['log', '--reverse', '--format=- %h %s', `${start.compareSha}..${agentRef}`]).stdout.trim()
    must(git(['push', '--quiet', '--no-verify', 'origin', `${agentRef}:refs/heads/${branch}`]), 'git push')
    log(`已推送 ${branch}：\n${commits}`)
    const tested = gates.map((g) => `- \`npm run ${g.name}\` 通过${g.summary ? `（${g.summary}）` : ''}`).join('\n')

    const existing = JSON.parse(gh(['pr', 'list', '--repo', config.repo, '--head', branch, '--state', 'open', '--json', 'number,url'], '查 PR')) as { number: number; url: string }[]
    if (existing.length === 0 && !info.isPr) {
      const title = outcome.prTitle ?? git(['log', '-1', '--format=%s', agentRef]).stdout.trim()
      const body = withMarker([
        `Closes #${trigger.number}`, '', '## 改了什么', '', outcome.reply, '', '## 提交', '', commits, '',
        '## 怎么测的', '', '服务在推送前重新跑了门禁，全部通过：', '', tested, '', `${sessionLine}，日志编号 \`${id}\`。`,
      ].join('\n'))
      const bodyPath = join(LOG_DIR, `${id}.pr-body.md`)
      writeFileSync(bodyPath, body)
      const url = gh(['pr', 'create', '--repo', config.repo, '--base', base, '--head', branch, '--title', title, '--body-file', bodyPath], '开 PR').trim().split('\n').pop()!
      const prNumber = Number(url.match(/\/pull\/(\d+)/)?.[1])
      if (prNumber) { thread.pr = prNumber; state.prThreads[String(prNumber)] = key }
      log(`已开 PR ${url}`)
      report(`已开 PR：${url}\n\n${outcome.reply}\n\n${sessionLine}。`, '待审')
    } else {
      const prNumber = info.isPr ? trigger.number : existing[0].number
      const text = `已推送到 \`${branch}\`：\n\n${commits}\n\n${outcome.reply}\n\n门禁：\n\n${tested}\n\n${sessionLine}。`
      if (prNumber !== trigger.number) comment(prNumber, `${text}\n\n日志编号 \`${id}\`。`)
      report(text, '待审')
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(`出错：${message}`)
    try { report(`服务出错，任务没完成：${tail(message, 20)}\n\n同一条指令不会自动重试。`, '受阻') } catch (inner) { log(`报告失败：${String(inner)}`) }
  } finally {
    rmSync(worktree, { recursive: true, force: true })
    rmSync(taskDir, { recursive: true, force: true })
    log('结束')
  }
}

// ---------- main loop ----------

function recoverInterrupted(state: LoopState): void {
  if (!state.running) return
  const { trigger, logId: id } = state.running
  say(`上次的任务 ${trigger.id} 被中断（日志编号 ${id}），不自动重试`)
  try {
    comment(trigger.number, `服务重启，这条指令的任务被中断了，没有完成。同一条指令不会自动重试，要重来请再发一次 \`@agent ...\`。\n\n日志编号 \`${id}\`。`)
  } catch (error) {
    say(`报告中断失败：${String(error)}`)
  }
  state.handled = rememberHandled(state.handled, trigger.id)
  state.running = undefined
  saveState(state)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  for (const dir of [SERVICE_DIR, LOG_DIR, WORKTREE_DIR, TASK_DIR]) mkdirSync(dir, { recursive: true })
  acquireLock()
  config = parseConfig(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')), HOME)
  say(`启动：仓库 ${config.repo}，owner ${config.owner}，dsh 线 ${Object.keys(config.dsh).join('/')}，DSH_HOME ${config.dshHome}/<线>${config.onlyLabel ? `，只处理带 ${config.onlyLabel} 标签的` : ''}，每 ${config.pollSeconds} 秒轮询`)
  const state = loadState()
  recoverInterrupted(state)

  let busy: Promise<void> | undefined
  let stopping = false
  const stop = (): void => {
    stopping = true
    say('收到停止信号')
    if (activeChild?.pid) { try { process.kill(-activeChild.pid, 'SIGTERM') } catch { /* gone */ } }
    // running stays recorded so the next start reports the interruption.
    process.exit(0)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)

  while (!stopping) {
    try {
      poll(state)
      saveState(state)
    } catch (error) {
      say(`轮询出错：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!busy && state.queue.length > 0) {
      const trigger = state.queue.shift()!
      state.handled = rememberHandled(state.handled, trigger.id)
      saveState(state)
      busy = runTask(state, trigger)
        .catch((error) => say(`任务 ${trigger.id} 异常：${String(error)}`))
        .finally(() => { state.running = undefined; saveState(state); busy = undefined })
    }
    if (ONCE) { if (busy) await busy; break }
    await sleep(config.pollSeconds * 1000)
  }
}

/**
 * `main.ts --sandbox-probe <line> -- <command...>`: run one command with the
 * exact sandbox a task on that dsh line gets (worktree, out dir, npm cache
 * and agent DSH_HOME writable; everything else read-only), for checking the
 * boundary by hand. Uses a throwaway `probe` worktree.
 */
function sandboxProbe(argv: string[]): void {
  config = parseConfig(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')), HOME)
  const line = argv[0]
  const command = argv.slice(argv.indexOf('--') + 1)
  const worktree = join(WORKTREE_DIR, 'probe')
  const taskDir = join(TASK_DIR, 'probe')
  const outDir = join(taskDir, 'out')
  const npmCache = join(taskDir, 'npm-cache')
  for (const dir of [worktree, outDir, npmCache]) mkdirSync(dir, { recursive: true })
  const dshHome = agentDshHome(line)
  const box: Box = { writable: [worktree, outDir, npmCache, dshHome], dshHome, npmCache }
  const full = sandboxArgv(command, worktree, box)
  console.log(`# ${full.join(' ')}`)
  const [cmd, ...args] = full
  const result = spawnSync(cmd, args, { cwd: '/', env: boxEnv(box), stdio: 'inherit' })
  rmSync(worktree, { recursive: true, force: true })
  rmSync(taskDir, { recursive: true, force: true })
  process.exit(result.status ?? 1)
}

if (process.argv[2] === '--sandbox-probe') sandboxProbe(process.argv.slice(3))
else main().catch((error) => {
  console.error(`agent-loop: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exit(1)
})
