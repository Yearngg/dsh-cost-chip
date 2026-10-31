/**
 * Host half of dsh-cost-chip.
 *
 * The readings themselves are pure Client UI (client.js). This half exists for
 * one reason: installing the plugin also teaches the agent the bundled
 * `task-token-cost` skill, so cross-session reports and CSV exports work out of
 * the box instead of only the ambient chips.
 *
 * The skill is registered as a runtime skill, which outranks a same-named copy
 * under ~/.dsh/skills, and its resource base points at the shipped directory so
 * `scripts/token-cost.mjs` keeps resolving `../prices.json`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.join(ROOT, 'skills', 'task-token-cost');

const DESCRIPTION = '查询每个任务（会话）消耗的 token 与对应金额，按 DeepSeek 峰谷价自动计价。当用户问「这个任务/这次对话花了多少钱」「消耗了多少 token」「统计最近花费」「哪个会话最贵」「token 用量与费用」「cost / token usage / billing」时使用。只读本地会话日志，无需联网。';

export const inject = ['skills'];

/** Strip the YAML frontmatter: the registry wants the body only. */
function skillBody(raw) {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw);
  return match === null ? raw : raw.slice(match[0].length);
}

export function apply(ctx) {
  let content;
  try {
    content = skillBody(fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8'));
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-cost-chip] bundled skill not readable: ${String(error)}`);
    return;
  }
  ctx.effect(() => ctx.skills.register({
    name: 'task-token-cost',
    description: DESCRIPTION,
    content,
    source: 'runtime',
    resourceBase: { kind: 'directory', path: SKILL_DIR },
  }));
}
