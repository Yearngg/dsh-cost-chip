# dsh-cost-chip

**English** | [中文](#中文)

Token usage and money, where you already look: one compact line under every completed answer, and the running session total above the composer — priced the way DeepSeek actually bills, with peak/idle rates applied per turn.

## What it does

DeepSeek Harness already counts tokens, but the numbers live in a popover. This plugin puts them on screen and turns them into money:

- **Per-turn line** under each completed answer: `本轮 12.3k tok · ¥0.0345` (`Turn 12.3k tok · ¥0.0345` in English).
- **Session line** above the composer: `会话 2.11M tok · ¥0.2498`, updating as the turn streams and settles.
- **Hover for the breakdown**: uncached input, cache read, output, the model, and whether that reading was priced at the peak or idle rate.
- **Each turn keeps its own price.** DeepSeek bills peak and idle hours differently, so a reading is priced by its own timestamp instead of the current clock; a session that crosses 12:00 or 18:00 prices every turn correctly.
- **A bundled skill.** Installing the plugin also registers `task-token-cost`, so you can ask the agent for cross-session reports, per-day totals, or CSV/JSON — the same numbers, aggregated over every session on disk.

Zero dependencies, zero network calls, no files written: everything is read from the session projections the harness already maintains.

## How to use

1. Install it (below) and open any conversation. Finished turns get the line automatically; the composer line appears as soon as the session has a model call.
2. Point at either line to see the split. Nothing to configure, no panel to open.
3. To go beyond the current session, just ask in natural language — the bundled skill handles it:

   ```
   最近三天每个任务花了多少 token 和钱？
   把这个月的用量导出成 CSV
   哪个会话最贵？
   ```

   The skill answers from `$DSH_HOME/sessions`, so it also covers sessions you are not looking at, and can emit per-turn, per-day or per-model totals.

4. Price change? Edit `PRICES` at the top of `client.js` for the on-screen readings and
   `skills/task-token-cost/prices.json` for the reports. Models missing from the table fall back to the Flash rate and are marked with `≈`.

## Screenshots

A real screenshot of the two readings is not committed yet — the repository owner is adding
`docs/chip.png` plus a `screenshots.json` (1–8 repository-relative paths). Those two files are all
the market needs to show them on this plugin's card.

## Install

- **Market (recommended once listed):** Plugins → Discover, search `dsh-cost-chip`, install.
- **From this repository:**
  ```sh
  dsh plugin add github:Yearngg/dsh-cost-chip
  ```
- **From npm, after it is published there:**
  ```sh
  dsh plugin add dsh-cost-chip
  ```

Requires DeepSeek Harness `0.2.1-rc.1` or newer — it uses the `conversation.chat.turnTail` and
`conversation.composer.dock` slots. Reload the page after installing; no restart needed.

## Pricing

Prices are CNY per 1,000,000 tokens and mirror the public DeepSeek list (checked 2026-10):

| Model | Idle: miss / hit / output | Peak: miss / hit / output |
| --- | --- | --- |
| `deepseek-flash` | ¥1 / ¥0.02 / ¥4 | ¥2 / ¥0.04 / ¥8 |
| `deepseek-v4-pro` | ¥4.5 / ¥0.15 / ¥13.5 | ¥9 / ¥0.3 / ¥27 |

Peak hours are Beijing time, Monday–Friday, 09:00–12:00 and 14:00–18:00; everything else is idle.
Cache writes are not billed. Figures are estimates: they follow the list price, not your invoice, and
statutory holidays are priced as peak because the plugin cannot know the holiday calendar.

## The bundled skill

`skills/task-token-cost/` ships the `task-token-cost` skill and its CLI:

```sh
node <skill-dir>/scripts/token-cost.mjs report              # per-session tokens + cost
node <skill-dir>/scripts/token-cost.mjs report --by turn    # per-turn detail
node <skill-dir>/scripts/token-cost.mjs report --since 7d --csv report.csv
node <skill-dir>/scripts/token-cost.mjs prices              # show the active price table
```

The plugin registers it as a runtime skill, so it outranks a same-named copy under `~/.dsh/skills`.
Two skills with one name would shadow each other; delete the user-level copy if you installed one earlier.

## Privacy

The readings come from the running session's `tokenUsage` projection and each completed turn's folded
usage; the skill reads `$DSH_HOME/sessions/**/session.v4.jsonl.zstd`. Nothing leaves the machine and
nothing is written.

## Development

The package is a plain Cordis bundle: `cordis.patch.yml` inserts the `token-cost` row, `index.js`
registers the skill, `client.js` registers the two slots. No build step — a git install runs the
source directly. Edit `client.js`, reload the page, done.

## License

MIT

---

## 中文

**作用**：把 DeepSeek Harness 已经统计的 token 用量直接摆到界面里，并折算成金额。

- 每条回答完成后的尾部加一行 `本轮 12.3k tok · ¥0.0345`；
- 输入框上方显示整个会话累计 `会话 2.11M tok · ¥0.2498`；
- 鼠标悬停看拆分：未命中输入 / 缓存命中 / 输出、模型、当时按高峰还是闲时计价；
- 每轮按它**自己的时间戳**定价，跨 12:00、18:00 的会话不会算错；
- 顺带把 `task-token-cost` 技能注册进来，可以让 agent 跨会话出报表、导 CSV/JSON。

零依赖、不联网、不写文件。

**怎么用**：

1. 安装后打开任意会话，完成的轮次自动出现那一行，输入框上方随会话出现累计行，无需配置。
2. 鼠标指上去看明细。
3. 想看更大范围，直接用自然语言问 agent，例如「最近三天每个任务花了多少」「导出这个月用量」「哪个会话最贵」——由内置技能回答。
4. 调价改 `client.js` 顶部的 `PRICES`（界面）和 `skills/task-token-cost/prices.json`（报表）。

**安装**：

```sh
dsh plugin add github:Yearngg/dsh-cost-chip   # 本仓库
dsh plugin add dsh-cost-chip                  # 发布到 npm 之后
```

也可以在市场里搜索 `dsh-cost-chip` 一键安装（收录后）。需要 dsh `0.2.1-rc.1` 及以上，装完刷新页面即可，不用重启。

**口径**：金额 = Σ 每次调用（未命中输入×未命中价 + 缓存命中×命中价 + 输出×输出价）÷ 1,000,000，高峰为北京时间工作日 9:00–12:00、14:00–18:00，其余闲时；缓存写入不计费；法定节假日无法识别，按高峰计。
