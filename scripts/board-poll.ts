/**
 * 看板轮询器 — systemd user timer 每天 09:00 驱动一次的入口。
 *
 * 职责（单轮内按序）：
 *   1. sync：入板新工单、归档已关闭；
 *   2. 清「待办」：逐张起 dsh headless 评估循环（每张 10 分钟超时，单轮封顶 12 张）；
 *   3. 有「待开工」且 WIP 空闲 → 起 dsh headless 跑一轮实现循环（45 分钟超时，每轮至多一件）；
 *   4. 失败（超时/非零退出/阶段未推进）→ 计数；同一工单自动重试上限 2 次后移「受阻」。
 *
 * 状态文件：~/.local/state/paseo-dsh-direct/board-state.json（尝试计数）
 * 日志：~/.local/state/paseo-dsh-direct/logs/<ts>-<phase>-<N>.log 与 journald。
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const STATE_DIR = process.env.BOARD_STATE_DIR ?? resolve(process.env.HOME ?? '.', '.local/state/paseo-dsh-direct')
const STATE_FILE = resolve(STATE_DIR, 'board-state.json')
const LOCK_FILE = resolve(STATE_DIR, 'board-poll.lock')
const LOG_DIR = resolve(STATE_DIR, 'logs')
const DSH_PATCH = process.env.BOARD_DSH_PATCH ?? resolve(process.env.HOME ?? '.', '.config/paseo-dsh-direct/board-patch.yml')
const MAX_ATTEMPTS = 2
const MAX_ANALYSES_PER_RUN = 12
const ANALYSIS_TIMEOUT_MS = 10 * 60 * 1000
const WORK_TIMEOUT_MS = 45 * 60 * 1000

interface Attempt { phase: 'analysis' | 'work'; attempts: number; ts: string }
type PollState = Record<string, Attempt>

/** Simple pid lockfile; abort if another live poller holds it. */
function acquireLock(): void {
  mkdirSync(STATE_DIR, { recursive: true })
  if (existsSync(LOCK_FILE)) {
    const holder = Number.parseInt(readFileSync(LOCK_FILE, 'utf8').trim(), 10)
    if (Number.isInteger(holder)) {
      try {
        process.kill(holder, 0)
        console.log(`board-poll: 另一轮询在运行（pid ${holder}），退出`)
        process.exit(0)
      } catch { /* holder 已死，锁过期 */ }
    }
    unlinkSync(LOCK_FILE)
  }
  closeSync(openSync(LOCK_FILE, 'wx'))
  process.on('exit', () => { try { unlinkSync(LOCK_FILE) } catch { /* 已清理 */ } })
}

function loadState(): PollState {
  if (!existsSync(STATE_FILE)) return {}
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as PollState
}

function saveState(state: PollState): void {
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`)
}

/** Run npm run board <args> and parse its JSON stdout. */
function board<T>(...args: string[]): T {
  const run = spawnSync('npm', ['run', '--silent', 'board', '--', ...args], { cwd: REPO_ROOT, encoding: 'utf8' })
  if (run.status !== 0) throw new Error(`board ${args.join(' ')} 失败：${(run.stderr || '').trim()}`)
  return JSON.parse(run.stdout) as T
}

interface Card { number: number; title: string; priority: string | null; url: string; itemId: string }

function stageOf(number: number): string | null {
  const status = board<{ stages: Record<string, Card[]> }>('status')
  for (const [stage, cards] of Object.entries(status.stages)) {
    if (cards.some((c) => c.number === number)) return stage
  }
  return null
}

/** Run one dsh headless session and log everything; returns true on exit 0 within timeout. */
function runHeadless(phase: 'analysis' | 'work', number: number, prompt: string, timeoutMs: number): { ok: boolean; reason: string } {
  mkdirSync(LOG_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const logPath = resolve(LOG_DIR, `${stamp}-${phase}-${number}.log`)
  console.log(`board-poll: ${phase} #${number} 开始，日志 ${logPath}`)
  const run = spawnSync('dsh', ['headless', '--patch', DSH_PATCH, prompt], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  })
  const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`
  writeFileSync(logPath, `# ${phase} #${number}\n# prompt: ${prompt}\n${output}`)
  if (run.error?.name === 'TimeoutError' || run.signal === 'SIGTERM') {
    return { ok: false, reason: `超时（>${Math.round(timeoutMs / 60000)} 分钟）被终止` }
  }
  if (run.status !== 0) {
    return { ok: false, reason: `dsh 退出码 ${run.status}` }
  }
  return { ok: true, reason: 'exit 0' }
}

/** Move a card to 受阻 and leave an explanatory comment for the human. */
function markBlocked(number: number, reason: string, attempts: number): void {
  board('move', String(number), '受阻')
  const body = `board-poll：第 ${attempts} 次自动尝试未完成（${reason}）。已移入**受阻**。处置后请拖回对应阶段（评估→待办，实现→待开工）。`
  const comment = spawnSync('gh', ['issue', 'comment', String(number), '--repo', 'Jecvay/paseo-dsh-direct', '--body', body], { cwd: REPO_ROOT, encoding: 'utf8' })
  if (comment.status !== 0) console.error(`board-poll: 评论 #${number} 失败：${comment.stderr}`)
}

function conclude(state: PollState, phase: 'analysis' | 'work', number: number, successStages: string[]): boolean {
  const stage = stageOf(number)
  if (stage !== null && successStages.includes(stage)) {
    delete state[String(number)]
    return true
  }
  const entry = state[String(number)] ?? { phase, attempts: 0, ts: '' }
  entry.attempts += 1
  entry.phase = phase
  entry.ts = new Date().toISOString()
  state[String(number)] = entry
  if (entry.attempts >= MAX_ATTEMPTS) {
    markBlocked(number, `阶段停在「${stage ?? '未知'}」`, entry.attempts)
    delete state[String(number)]
    console.log(`board-poll: #${number} 连续 ${entry.attempts} 次未推进，已移受阻`)
  }
  return false
}

function main(): void {
  acquireLock()
  const state = loadState()

  const sync = board<{ added: number[]; archived: number[] }>('sync')
  if (sync.added.length > 0 || sync.archived.length > 0) console.log(`board-poll: sync ${JSON.stringify(sync)}`)

  // 每轮先清待评估（封顶防失控），一轮跑完整个待办。
  for (let i = 0; i < MAX_ANALYSES_PER_RUN; i++) {
    const analysis = board<Card[]>('pick', '--for', 'analysis')
    const queue = analysis.filter((card) => {
      const entry = state[String(card.number)]
      return !(entry && entry.attempts >= MAX_ATTEMPTS)
    })
    if (queue.length === 0) break
    const card = queue[0]
    const prompt = `读 .agents/skills/gh-board/SKILL.md，执行评估循环，工单 #${card.number}。`
    const { reason } = runHeadless('analysis', card.number, prompt, ANALYSIS_TIMEOUT_MS)
    console.log(`board-poll: analysis #${card.number} → ${reason}`)
    conclude(state, 'analysis', card.number, ['已评估', '受阻'])
    saveState(state)
  }

  const work = board<{ wip: Card[]; queue: Card[] }>('pick', '--for', 'work')
  if (work.queue.length > 0) {
    const card = work.queue[0]
    const attempts = state[String(card.number)]?.phase === 'work' ? state[String(card.number)] : undefined
    if (attempts && attempts.attempts >= MAX_ATTEMPTS) {
      console.log(`board-poll: #${card.number} 重试次数用尽，跳过（应在受阻列）`)
      return
    }
    board('move', String(card.number), '进行中')
    const prompt = `读 .agents/skills/gh-board/SKILL.md，执行实现循环，工单 #${card.number}。`
    const { ok, reason } = runHeadless('work', card.number, prompt, WORK_TIMEOUT_MS)
    console.log(`board-poll: work #${card.number} → ${reason}`)
    if (!conclude(state, 'work', card.number, ['待审', '受阻'])) {
      if (ok) console.log(`board-poll: #${card.number} 阶段未推进，已计数`)
    }
    saveState(state)
    return
  }

  if (work.wip.length > 0) {
    console.log(`board-poll: WIP 占用中（${work.wip.map((c) => `#${c.number}`).join(', ')}），本轮不开新工`)
    return
  }
  console.log('board-poll: 无可做的工作（无待开工、无可评估的待办）')
}

try {
  main()
} catch (error) {
  console.error(`board-poll: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
