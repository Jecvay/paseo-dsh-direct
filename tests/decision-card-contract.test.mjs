import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const followup = readFileSync(new URL('../.agents/skills/paseo-followup/SKILL.md', import.meta.url), 'utf8');
const issue = readFileSync(new URL('../.agents/skills/issue-handler/SKILL.md', import.meta.url), 'utf8');

test('release approval is bound to the exact candidate and scoped action', () => {
  for (const field of ['repo', 'issue', 'PR', '完整候选 HEAD SHA', 'base', 'version', 'dist-tag', 'action']) {
    assert.ok(issue.includes(field), `issue skill must bind ${field}`);
  }
  assert.match(followup, /不得用插件组合 hash 冒充 issue 编号/);
  assert.match(followup, /repo\/PR\/HEAD\/base\/version\/dist-tag\/action 任一变化，旧答复失效/);
  assert.match(issue, /当前 HEAD、base、version、dist-tag、repo、PR 或 action 与卡片不一致，旧答案不适用/);
  assert.match(issue, /已有同一候选的 open 卡片时不重复创建/);
  assert.match(issue, /本轮涉及多个编号或事件与答复指向不同 issue 时，先厘清本轮目标，不猜编号/);
  assert.match(followup, /最多复查 3 次或 30 分钟/);
  assert.match(followup, /同一 run 最多复查 3 次或 30 分钟/);
  assert.match(issue, /跟踪同一个 run/);
  assert.match(issue, /批准只覆盖卡片明确列出的动作/);
});
