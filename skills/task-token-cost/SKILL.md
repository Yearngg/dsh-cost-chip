---
name: task-token-cost
description: "查询每个任务（会话）消耗的 token 与对应金额，按 DeepSeek 峰谷价自动计价。当用户问「这个任务/这次对话花了多少钱」「消耗了多少 token」「统计最近花费」「哪个会话最贵」「token 用量与费用」「cost / token usage / billing」时使用。只读本地会话日志，无需联网。"
version: 1.0.0
---

# 任务 Token 与金额统计

把 DeepSeek Harness 的本地会话日志折算成「每个任务用了多少 token、花了多少钱」。

## 数据来源（全部只读）

| 数据 | 位置 |
|---|---|
| 每次模型调用的 usage 与模型路由 | `%DSH_HOME%\sessions\<工作区>\session-<id>\session.v4.jsonl.zstd` |
| 任务标题 | `%DSH_HOME%\storages\session_projcache\sessions\*.json` |
| 工作区名称 | `%DSH_HOME%\storages\workspace.json` |
| 单价 | 本技能目录的 `prices.json` |

`DSH_HOME` 默认 `~/.dsh`，技能脚本自动读取环境变量。

## 用法

`<SKILL_DIR>` 为本文件所在目录。Windows 下：

```powershell
node "<SKILL_DIR>\scripts\token-cost.mjs" report
```

| 需求 | 命令 |
|---|---|
| 每个任务（会话）的花费 | `report` |
| 任务内每一轮的明细 | `report --by turn` |
| 最近 3 天 | `report --since 3d` |
| 只看某工作区 | `report --workspace DeepSeek` |
| 单个会话 | `report --session session-b0b26` |
| 按模型 / 按天汇总 | `report --by model` / `report --by day` |
| 导出 CSV（Excel 直接打开） | `report --csv .\token-cost.csv` |
| 机器可读 | `report --json` |
| 查看单价、峰谷时段、价格表路径 | `prices` |

输出示例：

```
任务                       工作区          最后调用(北京)    模型             未命中输入   缓存命中    输出  合计 tokens  金额(¥)
爬取抖音图文-10.31         H:\AI\DeepSeek  2026-10-31 15:13  deepseek-flash        77,871  4,543,616  39,227    4,660,714   0.3257
合计                                                                              219,780  7,952,640 100,761    8,273,181   0.7819
```

`--json` 的每行包含 `uncachedInputTokens / cacheReadTokens / cacheWriteTokens / outputTokens / totalTokens / cost / sessionId / model`，可直接喂给表格或图表。

## 金额口径

```
金额 = Σ 每次调用 ( 未命中输入×未命中价 + 缓存命中×命中价 + 输出×输出价 ) ÷ 1,000,000
```

- 每次调用按**自身时间戳**判定高峰/空闲，所以跨时段的会话会自动分段计价。
- 高峰：北京时间周一至周五 09:00–12:00、14:00–18:00；其余时段与周末为闲时价（约为高峰一半）。
- `cacheWriteTokens` 默认按 0 计——DeepSeek 不单独收取缓存写入费用。

## 价格表维护

改 `prices.json` 立即生效，无需改代码：

- `models.<模型>.peak` / `.idle`：`cacheMiss` 未命中输入、`cacheHit` 缓存命中、`output` 输出，单位「元 / 百万 tokens」
- `aliases`：旧模型名、中转站模型名映射到该价目
- `peak.ranges` / `peak.weekdays`：峰谷时段定义
- `peak.holidays`：法定节假日填 `YYYY-MM-DD`，当天按闲时计
- `fallback`：未在表中的模型回退到该价目，报表中模型名后带 `*`

调价时只改数字，并同步 `note` 里的核对日期。

## 边界

- 只统计模型调用的 token。Search/Fetch 按次计费、账户余额扣减不包含在内。
- 子代理（subagent）会话是独立会话文件，会作为单独任务列出，不并入父任务。
- 标题取自会话标题缓存；没有标题的用首条提示词代替。
- 金额是「按当前价格表估算」，与官方账单可能因调价、节假日或特殊计费规则存在差异。
- 会话日志是追加式 zstd 帧，脚本逐帧解压，正在写入的会话也能读取。
