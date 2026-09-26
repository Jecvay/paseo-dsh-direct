/**
 * GitHub Projects 看板操作台 — paseo-dsh-pi 工单循环的脚本面。
 *
 * 状态机权威在「阶段」单选字段：待办 → 已评估 → 待开工 → 进行中 → 待审 / 受阻；
 * issue 关闭即归档（合并即完成）。人只在看板上拖「待开工」（开工令）。
 *
 * 用法（tsx scripts/board.ts <子命令>）：
 *   status                       看板概览（JSON：各阶段卡数 + 每张卡的编号/标题/优先级/父子）
 *   sync                         开着的 issue 全量入板、补默认阶段(待办)与优先级(从正文 P0-P3)、归档已关闭项
 *   pick --for analysis          待办列未评估卡（优先级升序）
 *   pick --for work              待开工卡；已存在进行中卡时输出空列表（WIP=1）
 *   move <number> <stage>        设置阶段（stage ∈ 待办|已评估|待开工|进行中|待审|受阻）
 *   attach <parent> <child>      把 child 挂为 parent 的 sub-issue（并单）
 *   children <number>            列出 sub-issue（JSON）
 *   archive <number>             归档该 issue 的看板项
 */

import { spawnSync } from 'node:child_process'

const STAGES = ['待办', '已评估', '待开工', '进行中', '待审', '受阻'] as const
type Stage = (typeof STAGES)[number]

const REPO = process.env.BOARD_REPO ?? 'Jecvay/paseo-dsh-pi'
const PROJECT_OWNER = process.env.BOARD_OWNER ?? 'Jecvay'
const PROJECT_NUMBER = Number(process.env.BOARD_PROJECT ?? 1)
const STAGE_FIELD = '阶段'
const PRIORITY_FIELD = '优先级'
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const

/** Run gh and return parsed stdout JSON; abort with stderr on failure. */
function ghJson<T>(args: string[], what: string): T {
  const run = spawnSync('gh', args, { encoding: 'utf8' })
  if (run.status !== 0) {
    console.error(`board: ${what} 失败：${(run.stderr || run.stdout || '').trim()}`)
    process.exit(1)
  }
  return run.stdout ? (JSON.parse(run.stdout) as T) : ({} as T)
}

/** Run a GraphQL request via gh. */
function gql<T>(query: string, variables: Record<string, unknown> = {}): T {
  const args = ['api', 'graphql', '-f', `query=${query}`]
  for (const [key, value] of Object.entries(variables)) args.push('-F', `${key}=${value}`)
  return ghJson<T>(args, 'graphql')
}

// ---------- project metadata (discovered by name, ids cached per-run) ----------

interface FieldOption { id: string; name: string }
interface Field { id: string; name: string; options?: FieldOption[] }

let cachedProjectId: string | undefined
const fieldCache = new Map<string, Field>()

function projectId(): string {
  if (cachedProjectId) return cachedProjectId
  const data = ghJson<{ id: string }>(
    ['project', 'view', String(PROJECT_NUMBER), '--owner', PROJECT_OWNER, '--format', 'json'],
    '读取项目',
  )
  cachedProjectId = data.id
  return data.id
}

function field(name: string): Field {
  const hit = fieldCache.get(name)
  if (hit) return hit
  const data = ghJson<{ fields: Field[] }>(
    ['project', 'field-list', String(PROJECT_NUMBER), '--owner', PROJECT_OWNER, '--format', 'json', '--limit', '50'],
    '读取字段',
  )
  for (const f of data.fields) fieldCache.set(f.name, f)
  const found = fieldCache.get(name)
  if (!found) {
    console.error(`board: 项目缺少字段「${name}」`)
    process.exit(1)
  }
  return found
}

// ---------- board items ----------

interface BoardIssue {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED'
  url: string
  labels: string[]
  body: string
}
interface BoardItem {
  itemId: string
  number: number
  stage: string | null
  priority: string | null
  archived: boolean
  issue: BoardIssue
}

const ITEMS_QUERY = `
query($number: Int!, $repoOwner: String!, $repoName: String!) {
  viewer {
    projectV2(number: $number) {
      items(first: 100) {
        nodes {
          id
          isArchived
          content {
            ... on Issue {
              number title state url body
              labels(first: 20) { nodes { name } }
            }
          }
          fieldValues(first: 30) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2SingleSelectField { name } }
              }
            }
          }
        }
      }
    }
  }
  repository(owner: $repoOwner, name: $repoName) {
    issues(first: 100, states: OPEN) {
      nodes { number title url }
    }
  }
}`

interface RawItem {
  id: string
  isArchived: boolean
  content: {
    number: number
    title: string
    state: 'OPEN' | 'CLOSED'
    url: string
    body?: string
    labels?: { nodes: { name: string }[] }
    subIssues?: { nodes: { number: number; title: string; state: string }[] }
  } | null
  fieldValues: {
    nodes: { name: string; field?: { name?: string } }[]
  }
}

interface ItemsResult {
  data: {
    viewer: {
      projectV2: {
        items: { nodes: RawItem[] }
      }
    }
    repository: { issues: { nodes: { number: number; title: string; url: string }[] } }
  }
}

function items(): BoardItem[] {
  const [repoOwner, repoName] = REPO.split('/')
  const result = gql<ItemsResult>(ITEMS_QUERY, { number: PROJECT_NUMBER, repoOwner, repoName })
  return result.data.viewer.projectV2.items.nodes
    .filter((node): node is RawItem & { content: NonNullable<RawItem['content']> } => node.content !== null)
    .map((node) => {
      const selects = node.fieldValues.nodes.filter((v) => v.field?.name)
      const stage = selects.find((v) => v.field?.name === STAGE_FIELD)?.name ?? null
      const priority = selects.find((v) => v.field?.name === PRIORITY_FIELD)?.name ?? null
      return {
        itemId: node.id,
        number: node.content.number,
        stage,
        priority,
        archived: node.isArchived,
        issue: {
          number: node.content.number,
          title: node.content.title,
          state: node.content.state,
          url: node.content.url,
          labels: node.content.labels?.nodes.map((l) => l.name) ?? [],
          body: node.content.body ?? '',
        },
      }
    })
}

// ---------- mutations ----------

function setStage(itemId: string, number: number, stage: Stage): void {
  const f = field(STAGE_FIELD)
  const option = f.options?.find((o) => o.name === stage)
  if (!option) {
    console.error(`board: 阶段字段缺少选项「${stage}」`)
    process.exit(1)
  }
  ghJson(
    [
      'project', 'item-edit',
      '--id', itemId,
      '--project-id', projectId(),
      '--field-id', f.id,
      '--single-select-option-id', option.id,
    ],
    `设置 #${number} 阶段=${stage}`,
  )
}

function setPriority(itemId: string, number: number, priority: string): void {
  const f = field(PRIORITY_FIELD)
  const option = f.options?.find((o) => o.name === priority)
  if (!option) return
  ghJson(
    [
      'project', 'item-edit',
      '--id', itemId,
      '--project-id', projectId(),
      '--field-id', f.id,
      '--single-select-option-id', option.id,
    ],
    `设置 #${number} 优先级=${priority}`,
  )
}

function itemAdd(url: string): { id: string } {
  return ghJson<{ id: string }>(
    ['project', 'item-add', String(PROJECT_NUMBER), '--owner', PROJECT_OWNER, '--url', url, '--format', 'json'],
    `入板 ${url}`,
  )
}

function archive(item: BoardItem): void {
  ghJson(
    ['api', 'graphql', '-f', `query=mutation($project: ID!, $item: ID!) { archiveProjectV2Item(input: {projectId: $project, itemId: $item}) { item { id } } }`, '-F', `project=${projectId()}`, '-F', `item=${item.itemId}`],
    `归档 #${item.number}`,
  )
}

/** Detect P0-P3 mention in issue title/body so sync can backfill Priority. */
function priorityFromText(text: string): string | null {
  const match = text.match(/\bP([0-3])\b/)
  return match ? `P${match[1]}` : null
}

function priorityRank(priority: string | null): number {
  const index = priority ? PRIORITIES.indexOf(priority as (typeof PRIORITIES)[number]) : -1
  return index === -1 ? PRIORITIES.length : index
}

// ---------- subcommands ----------

function cmdStatus(): void {
  const board = items().filter((i) => !i.archived)
  const byStage: Record<string, BoardItem[]> = {}
  for (const stage of STAGES) byStage[stage] = []
  for (const item of board) {
    const stage = item.stage && STAGES.includes(item.stage as Stage) ? item.stage : '待办'
    byStage[stage].push(item)
  }
  const view = Object.fromEntries(
    Object.entries(byStage).map(([stage, list]) => [
      stage,
      list
        .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.number - b.number)
        .map((i) => ({ number: i.number, title: i.issue.title, priority: i.priority, url: i.issue.url })),
    ]),
  )
  console.log(JSON.stringify({ repo: REPO, project: PROJECT_NUMBER, counts: Object.fromEntries(Object.entries(view).map(([s, l]) => [s, l.length])), stages: view }, null, 2))
}

function cmdSync(): void {
  const board = items()
  const onBoard = new Map(board.map((i) => [i.number, i]))
  const openIssues = ghJson<{ number: number; title: string; url: string }[]>(
    ['issue', 'list', '--repo', REPO, '--state', 'open', '--json', 'number,title,url', '--limit', '500'],
    '列出 issue',
  )

  const added: number[] = []
  for (const issue of openIssues) {
    if (!onBoard.has(issue.number)) {
      const created = itemAdd(issue.url)
      const detail = ghJson<{ body: string }>(
        ['issue', 'view', String(issue.number), '--repo', REPO, '--json', 'body'],
        `读取 #${issue.number} 正文`,
      )
      setStage(created.id, issue.number, '待办')
      const inferred = priorityFromText(`${issue.title}\n${detail.body}`)
      if (inferred) setPriority(created.id, issue.number, inferred)
      added.push(issue.number)
    }
  }

  // Existing items: archive closed, repair missing stage/priority.
  const after = items()
  const staged: number[] = []
  const prioritized: number[] = []
  const archived: number[] = []
  for (const item of after) {
    if (item.issue.state === 'CLOSED' && !item.archived) {
      archive(item)
      archived.push(item.number)
      continue
    }
    if (item.issue.state === 'OPEN' && item.archived) continue
    if (!item.stage || !STAGES.includes(item.stage as Stage)) {
      setStage(item.itemId, item.number, '待办')
      staged.push(item.number)
    }
    if (!item.priority) {
      const inferred = priorityFromText(`${item.issue.title}\n${item.issue.body}`)
      if (inferred) {
        setPriority(item.itemId, item.number, inferred)
        prioritized.push(item.number)
      }
    }
  }
  console.log(JSON.stringify({ added, staged, prioritized, archived }, null, 2))
}

function cmdPick(forWhat: 'analysis' | 'work'): void {
  const board = items().filter((i) => !i.archived && i.issue.state === 'OPEN')
  if (forWhat === 'analysis') {
    const queue = board
      .filter((i) => i.stage === '待办')
      .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.number - b.number)
    console.log(JSON.stringify(queue.map(pickView), null, 2))
    return
  }
  const wip = board.filter((i) => i.stage === '进行中' || i.stage === '待审')
  if (wip.length > 0) {
    console.log(JSON.stringify({ wip: wip.map(pickView), queue: [] }, null, 2))
    return
  }
  const queue = board
    .filter((i) => i.stage === '待开工')
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.number - b.number)
  console.log(JSON.stringify({ wip: [], queue: queue.map(pickView) }, null, 2))
}

function pickView(item: BoardItem) {
  return { number: item.number, title: item.issue.title, priority: item.priority, url: item.issue.url, itemId: item.itemId }
}

function cmdMove(number: number, stage: string): void {
  if (!STAGES.includes(stage as Stage)) {
    console.error(`board: 未知阶段「${stage}」，可选：${STAGES.join(' | ')}`)
    process.exit(1)
  }
  const board = items()
  const item = board.find((i) => i.number === number)
  if (!item) {
    console.error(`board: #${number} 不在看板上，先运行 sync`)
    process.exit(1)
  }
  setStage(item.itemId, number, stage as Stage)
  console.log(`#${number} → ${stage}`)
}

function cmdAttach(parentNumber: number, childNumber: number): void {
  const parent = ghJson<{ id: string }>(['issue', 'view', String(parentNumber), '--repo', REPO, '--json', 'id'], `读取 #${parentNumber}`)
  const child = ghJson<{ id: string }>(['issue', 'view', String(childNumber), '--repo', REPO, '--json', 'id'], `读取 #${childNumber}`)
  ghJson(
    [
      'api', 'graphql',
      '-f', `query=mutation($parent: ID!, $child: ID!) { addSubIssue(input: {issueId: $parent, subIssueId: $child}) { issue { number } subIssue { number } } }`,
      '-F', `parent=${parent.id}`,
      '-F', `child=${child.id}`,
    ],
    `并单 #${childNumber} → #${parentNumber}`,
  )
  console.log(`#${childNumber} 已挂为 #${parentNumber} 的 sub-issue`)
}

function cmdChildren(number: number): void {
  const data = ghJson<{ data: { repository: { issue: { subIssues: { nodes: { number: number; title: string; state: string; url: string }[] } } } } }>(
    [
      'api', 'graphql',
      '-f', `query=query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { issue(number: $number) { subIssues(first: 30) { nodes { number title state url } } } } }`,
      '-F', `owner=${REPO.split('/')[0]}`,
      '-F', `repo=${REPO.split('/')[1]}`,
      '-F', `number=${number}`,
    ],
    `读取 #${number} sub-issues`,
  )
  console.log(JSON.stringify(data.data.repository.issue.subIssues.nodes, null, 2))
}

function cmdArchive(number: number): void {
  const board = items()
  const item = board.find((i) => i.number === number)
  if (!item) {
    console.error(`board: #${number} 不在看板上`)
    process.exit(1)
  }
  archive(item)
  console.log(`#${number} 已归档`)
}

// ---------- entry ----------

const argv = process.argv.slice(2)
const command = argv[0]
try {
  switch (command) {
    case 'status': cmdStatus(); break
    case 'sync': cmdSync(); break
    case 'pick':
      if (argv[1] === '--for' && (argv[2] === 'analysis' || argv[2] === 'work')) cmdPick(argv[2])
      else { console.error('board: 用法 pick --for analysis|work'); process.exit(1) }
      break
    case 'move': {
      const number = Number(argv[1])
      if (!Number.isInteger(number) || !argv[2]) { console.error('board: 用法 move <number> <stage>'); process.exit(1) }
      cmdMove(number, argv[2]); break
    }
    case 'attach': {
      const parent = Number(argv[1]); const child = Number(argv[2])
      if (!Number.isInteger(parent) || !Number.isInteger(child)) { console.error('board: 用法 attach <parent> <child>'); process.exit(1) }
      cmdAttach(parent, child); break
    }
    case 'children': {
      const number = Number(argv[1])
      if (!Number.isInteger(number)) { console.error('board: 用法 children <number>'); process.exit(1) }
      cmdChildren(number); break
    }
    case 'archive': {
      const number = Number(argv[1])
      if (!Number.isInteger(number)) { console.error('board: 用法 archive <number>'); process.exit(1) }
      cmdArchive(number); break
    }
    default:
      console.error('board: 未知命令。可用：status | sync | pick --for analysis|work | move | attach | children | archive')
      process.exit(1)
  }
} catch (error) {
  console.error(`board: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
