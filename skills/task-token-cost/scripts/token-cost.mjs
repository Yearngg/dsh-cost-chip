#!/usr/bin/env node
/**
 * task-token-cost: per-task token usage and money for DeepSeek Harness sessions.
 *
 * Data source: $DSH_HOME/sessions/<workspace>/session-<id>/session.v4.jsonl.zstd
 *   - one zstd frame per append, so frames are decoded individually
 *   - every successful model call is an `assistant/message` event carrying
 *     `data.usage` and `data.message.source.{provider,model}`
 *
 * Money: token usage x the price table in ../prices.json. DeepSeek prices differ
 * between peak and idle hours, so each attempt is priced by its own timestamp.
 *
 * No third-party dependencies. Node >= 22 (needs zlib zstd support).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, "..");
const PRICES_PATH = path.join(SKILL_DIR, "prices.json");
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const ZSTD_MAGIC = 0xfd2fb528;

/* ---------------------------------------------------------------- arguments */

const RAW = process.argv.slice(2);
const COMMAND = RAW[0] && !RAW[0].startsWith("-") ? RAW[0] : "report";
const FLAGS = new Map();
for (let i = 0; i < RAW.length; i++) {
  const arg = RAW[i];
  if (!arg.startsWith("--")) continue;
  const eq = arg.indexOf("=");
  if (eq > 0) FLAGS.set(arg.slice(2, eq), arg.slice(eq + 1));
  else if (RAW[i + 1] !== undefined && !RAW[i + 1].startsWith("--")) FLAGS.set(arg.slice(2), RAW[++i]);
  else FLAGS.set(arg.slice(2), "true");
}
const flag = (name, fallback) => (FLAGS.has(name) ? FLAGS.get(name) : fallback);

/* ------------------------------------------------------------------- prices */

function loadPrices() {
  const raw = JSON.parse(fs.readFileSync(PRICES_PATH, "utf8"));
  if (!raw.models || typeof raw.models !== "object") throw new Error(`prices.json 缺少 models: ${PRICES_PATH}`);
  return raw;
}

const PRICES = loadPrices();
const UNIT = PRICES.unit || 1_000_000;
const CURRENCY = PRICES.currency || "CNY";
const PEAK = PRICES.peak || { timeZone: "Asia/Shanghai", weekdays: [1, 2, 3, 4, 5], ranges: [["09:00", "12:00"], ["14:00", "18:00"]], holidays: [] };

function matchModel(model) {
  const wanted = String(model || "").toLowerCase();
  const table = PRICES.models;
  if (table[wanted]) return { key: wanted, def: table[wanted], known: true };
  for (const [key, def] of Object.entries(table)) {
    if (key.toLowerCase() === wanted) return { key, def, known: true };
    for (const alias of def.aliases || []) if (String(alias).toLowerCase() === wanted) return { key, def, known: true };
  }
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  for (const key of keys) if (wanted.startsWith(key.toLowerCase())) return { key, def: table[key], known: true };
  const fallbackKey = PRICES.fallback && table[PRICES.fallback] ? PRICES.fallback : keys[0];
  return { key: fallbackKey, def: table[fallbackKey], known: false };
}

/* -------------------------------------------------------------- time helpers */

const dateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: PEAK.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
});

function clock(timeMs) {
  const parts = Object.fromEntries(dateFmt.formatToParts(new Date(timeMs)).map((p) => [p.type, p.value]));
  const weekday = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.weekday];
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    weekday,
    label: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`,
  };
}

const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

function isPeak(timeMs) {
  const at = clock(timeMs);
  if (!PEAK.weekdays.includes(at.weekday)) return false;
  if ((PEAK.holidays || []).includes(at.date)) return false;
  return PEAK.ranges.some(([from, to]) => at.minutes >= toMinutes(from) && at.minutes < toMinutes(to));
}

/* ------------------------------------------------------------ session reader */

/** Split a concatenated-zstd log into exact frame spans. */
function frameSpans(buf) {
  const spans = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    if (buf.readUInt32LE(off) !== ZSTD_MAGIC) { off += 1; continue; }
    const start = off;
    let p = off + 4;
    const descriptor = buf[p++];
    const contentSizeFlag = descriptor >> 6;
    const singleSegment = (descriptor >> 5) & 1;
    const contentChecksum = (descriptor >> 2) & 1;
    const dictionaryFlag = descriptor & 3;
    if (!singleSegment) p += 1;
    p += [0, 1, 2, 4][dictionaryFlag];
    p += singleSegment ? [1, 2, 4, 8][contentSizeFlag] : [0, 2, 4, 8][contentSizeFlag];
    let complete = true;
    while (p + 3 <= buf.length) {
      const header = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
      p += 3;
      const last = header & 1;
      const type = (header >> 1) & 3;
      const size = header >>> 3;
      if (type === 3) { complete = false; break; }
      p += type === 1 ? 1 : size;
      if (p > buf.length) { complete = false; break; }
      if (last) break;
    }
    if (contentChecksum) p += 4;
    if (!complete || p > buf.length || p <= start) { off = start + 4; continue; }
    spans.push([start, p]);
    off = p;
  }
  return spans;
}

function readLog(file) {
  const buf = fs.readFileSync(file);
  const chunks = [];
  for (const [from, to] of frameSpans(buf)) {
    try { chunks.push(zlib.zstdDecompressSync(buf.subarray(from, to)).toString("utf8")); } catch { /* skip torn tail */ }
  }
  return chunks.join("");
}

function foldSession(text) {
  const header = { id: undefined, createdAt: undefined, cwd: undefined };
  const turns = [];
  let current;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "session") { Object.assign(header, event); continue; }
    const data = event.data || {};
    if (event.type === "turn/start") {
      current = { turn: data.turn, startTime: event.time, prompt: "", attempts: [] };
      turns.push(current);
      continue;
    }
    if (!current) continue;
    if (event.type === "user/message" && !current.prompt) {
      const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
      if (text && !text.startsWith("Current runtime context.")) current.prompt = text;
      continue;
    }
    if (event.type === "assistant/message" && data.usage && data.message) {
      current.attempts.push({
        time: event.time,
        provider: data.message.source?.provider || "",
        model: data.message.source?.model || "",
        usage: data.usage,
      });
    }
  }
  return { header, turns };
}

function readTitles() {
  const dir = path.join(DSH_HOME, "storages", "session_projcache", "sessions");
  const titles = new Map();
  if (!fs.existsSync(dir)) return titles;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      const title = record?.record?.rows?.title?.val;
      if (typeof title === "string" && title.trim()) titles.set(name.replace(/\.json$/, ""), title.trim());
    } catch { /* ignore corrupt cache */ }
  }
  return titles;
}

function readWorkspaces() {
  const file = path.join(DSH_HOME, "storages", "workspace.json");
  const bySession = new Map();
  if (!fs.existsSync(file)) return bySession;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const ws of Object.values(data?.tables?.workspaces || {})) {
      for (const id of ws.sessionIds || []) bySession.set(id, { title: ws.title, path: ws.path });
    }
  } catch { /* ignore */ }
  return bySession;
}

const truncate = (text, max) => {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  const chars = [...clean];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : clean;
};

/* ------------------------------------------------------------------ collects */

const PRICED_ATTEMPT = Symbol("priced");

function priceAttempt(attempt) {
  const route = matchModel(attempt.model);
  const peak = isPeak(attempt.time);
  const table = peak ? route.def.peak : route.def.idle;
  const usage = attempt.usage;
  const miss = usage.inputTokens || 0;
  const hit = usage.cacheReadTokens || 0;
  const write = usage.cacheWriteTokens || 0;
  const out = usage.outputTokens || 0;
  const writeRate = route.def.cacheWrite ?? 0;
  const cost = (miss * table.cacheMiss + hit * table.cacheHit + write * writeRate + out * table.output) / UNIT;
  return { ...attempt, [PRICED_ATTEMPT]: { route, peak, miss, hit, write, out, cost } };
}

function collectSessions() {
  const root = path.join(DSH_HOME, "sessions");
  if (!fs.existsSync(root)) throw new Error(`找不到会话目录: ${root}`);
  const titles = readTitles();
  const workspaces = readWorkspaces();
  const sessions = [];
  for (const slug of fs.readdirSync(root)) {
    const slugDir = path.join(root, slug);
    if (!fs.statSync(slugDir).isDirectory()) continue;
    for (const name of fs.readdirSync(slugDir)) {
      const dir = path.join(slugDir, name);
      let stat;
      try { stat = fs.statSync(dir); } catch { continue; }
      if (!stat.isDirectory()) continue;
      const log = path.join(dir, "session.v4.jsonl.zstd");
      if (!fs.existsSync(log)) continue;
      let folded;
      try { folded = foldSession(readLog(log)); } catch { continue; }
      const { header, turns } = folded;
      const id = header.id || name;
      const priced = turns.map((turn) => ({ ...turn, attempts: turn.attempts.map(priceAttempt) }));
      const meta = workspaces.get(id) || {};
      const title = titles.get(id) || (priced.find((t) => t.prompt)?.prompt ?? "未命名任务");
      sessions.push({
        id, slug, cwd: header.cwd,
        createdAt: header.createdAt || stat.birthtimeMs || stat.mtimeMs,
        title, workspace: meta.title || path.basename(String(header.cwd || slug).replace(/[\\/]+$/, "")) || slug,
        workspacePath: meta.path || header.cwd || "",
        file: log, updatedAt: stat.mtimeMs, turns: priced,
      });
    }
  }
  return sessions;
}

const ZERO = { miss: 0, hit: 0, write: 0, out: 0, cost: 0 };
const sum = (items) => items.reduce((acc, a) => {
  const c = a[PRICED_ATTEMPT];
  acc.miss += c.miss; acc.hit += c.hit; acc.write += c.write; acc.out += c.out; acc.cost += c.cost;
  return acc;
}, { ...ZERO });

function modelsOf(attempts) {
  const set = new Set(attempts.map((a) => a.model).filter(Boolean));
  if (set.size === 0) return "-";
  const names = [...set];
  return names.length <= 2 ? names.join("+") : `${names.slice(0, 2).join("+")}+${names.length - 2}`;
}

function routeFlags(attempts) {
  return attempts.some((a) => !a[PRICED_ATTEMPT].route.known) ? "*" : "";
}

function sinceCutoff(value) {
  if (!value) return 0;
  const relative = /^(\d+(?:\.\d+)?)([dhm])$/i.exec(value);
  if (relative) {
    const units = { h: 3_600_000, d: 86_400_000, m: 60_000 };
    return Date.now() - Number(relative[1]) * units[relative[2].toLowerCase()];
  }
  const at = Date.parse(value);
  if (Number.isNaN(at)) throw new Error(`无法解析 --since: ${value}`);
  return at;
}

function buildRows(sessions, by) {
  const rows = [];
  for (const session of sessions) {
    const attempts = session.turns.flatMap((t) => t.attempts);
    if (by === "turn") {
      for (const turn of session.turns) {
        if (turn.attempts.length === 0) continue;
        rows.push({
          task: truncate(session.title, 22),
          detail: truncate(`#${turn.turn} ${turn.prompt || "（无文本提示）"}`, 26),
          when: turn.startTime,
          model: modelsOf(turn.attempts),
          tokens: sum(turn.attempts),
          flag: routeFlags(turn.attempts),
          sessionId: session.id, workspace: session.workspace, exportedAt: session.updatedAt,
        });
      }
      continue;
    }
    if (attempts.length === 0) continue;
    rows.push({
      task: truncate(session.title, 22),
      detail: truncate(session.workspacePath || session.workspace, 26),
      when: Math.max(...attempts.map((a) => a.time)),
      model: modelsOf(attempts),
      tokens: sum(attempts),
      flag: routeFlags(attempts),
      sessionId: session.id, workspace: session.workspace, exportedAt: session.updatedAt,
    });
  }
  return rows;
}

function groupBy(rows, keyOf, labelOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, { task: labelOf(row), detail: "", when: row.when, models: new Set(), tokens: { ...ZERO }, flag: "", count: 0 });
    const g = groups.get(key);
    g.when = Math.min(g.when, row.when);
    g.count += 1;
    g.models.add(row.model);
    g.flag ||= row.flag;
    g.tokens.miss += row.tokens.miss; g.tokens.hit += row.tokens.hit;
    g.tokens.write += row.tokens.write; g.tokens.out += row.tokens.out; g.tokens.cost += row.tokens.cost;
  }
  return [...groups.values()].map((g) => ({
    task: g.task, detail: `${g.count} 个任务`, when: g.when,
    model: [...g.models].join("+"), tokens: g.tokens, flag: g.flag,
    sessionId: "", workspace: "", exportedAt: 0,
  }));
}

/* ------------------------------------------------------------------ printing */

const CJK = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1faff}]/u;
const width = (text) => [...String(text)].reduce((n, ch) => n + (CJK.test(ch) ? 2 : 1), 0);
const pad = (text, size, align = "left") => {
  const gap = Math.max(0, size - width(text));
  return align === "right" ? " ".repeat(gap) + text : text + " ".repeat(gap);
};
const int = (n) => n.toLocaleString("en-US");
const money = (n) => `${n.toFixed(4)}`;

function renderTable(rows, by) {
  const headers = by === "turn"
    ? ["任务", "轮次提示", "开始(北京)", "模型", "未命中输入", "缓存命中", "输出", "合计 tokens", "金额(¥)"]
    : ["任务", "工作区", "最后调用(北京)", "模型", "未命中输入", "缓存命中", "输出", "合计 tokens", "金额(¥)"];
  const body = rows.map((row) => [
    row.task, row.detail, clock(row.when).label, `${row.model}${row.flag}`,
    int(row.tokens.miss), int(row.tokens.hit), int(row.tokens.out),
    int(row.tokens.miss + row.tokens.hit + row.tokens.write + row.tokens.out), money(row.tokens.cost),
  ]);
  const totals = rows.reduce((acc, r) => {
    acc.miss += r.tokens.miss; acc.hit += r.tokens.hit; acc.write += r.tokens.write;
    acc.out += r.tokens.out; acc.cost += r.tokens.cost; return acc;
  }, { ...ZERO });
  const footer = ["合计", "", "", "", int(totals.miss), int(totals.hit), int(totals.out),
    int(totals.miss + totals.hit + totals.write + totals.out), money(totals.cost)];

  const sizes = headers.map((h, i) => Math.max(width(h), ...body.map((r) => width(r[i])), width(footer[i])));
  const line = (cells) => cells.map((cell, i) => pad(cell, sizes[i], i >= 4 ? "right" : "left")).join("  ").trimEnd();
  const out = [line(headers), sizes.map((s) => "-".repeat(s)).join("  ")];
  for (const row of body) out.push(line(row));
  out.push(sizes.map((s) => "-".repeat(s)).join("  "));
  out.push(line(footer));
  return { text: out.join("\n"), totals, footer };
}

/* --------------------------------------------------------------------- main */

function printPrices() {
  console.log(`价格表: ${PRICES_PATH}`);
  console.log(`货币: ${CURRENCY} / 计价单位: ${int(UNIT)} tokens`);
  if (PRICES.note) console.log(`说明: ${PRICES.note}`);
  console.log(`高峰时段: 周${PEAK.weekdays.join(",")} ${PEAK.ranges.map(([a, b]) => `${a}-${b}`).join(" ")} (${PEAK.timeZone}); 其余为空闲时段`);
  if (PEAK.holidays?.length) console.log(`已声明节假日(按闲时计价): ${PEAK.holidays.join(", ")}`);
  console.log("");
  const rows = Object.entries(PRICES.models).map(([name, def]) => [
    name + (def.aliases?.length ? ` (${def.aliases.join(", ")})` : ""),
    `¥${def.idle.cacheMiss} / ¥${def.idle.cacheHit} / ¥${def.idle.output}`,
    `¥${def.peak.cacheMiss} / ¥${def.peak.cacheHit} / ¥${def.peak.output}`,
  ]);
  const headers = ["模型", "空闲 输入未命中/缓存命中/输出", "高峰 输入未命中/缓存命中/输出"];
  const sizes = headers.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i]))));
  console.log(headers.map((h, i) => pad(h, sizes[i])).join("  "));
  for (const row of rows) console.log(row.map((c, i) => pad(c, sizes[i])).join("  "));
  console.log("");
  console.log(`未知模型回退到: ${PRICES.fallback || Object.keys(PRICES.models)[0]}（报表中标记 *）`);
}

const USAGE = `用法: node token-cost.mjs <report|prices|help> [选项]

report   按任务汇总 token 与金额（默认命令）
prices   显示当前价格表、峰谷时段与配置路径
help     显示本说明

选项:
  --by session|turn|model|day   汇总维度，默认 session（每个会话=一个任务）
  --since 7d|36h|2026-10-01     只看该时间之后的任务
  --workspace <关键字>          按工作区名称/路径过滤
  --session <id前缀>            只看某个会话
  --model <关键字>              按模型名过滤
  --limit N                     最多显示 N 行
  --json                        输出 JSON（便于二次处理）
  --csv <路径>                  另存 CSV（UTF-8 BOM，Excel 可直接打开）

示例:
  node token-cost.mjs report
  node token-cost.mjs report --by turn --since 3d
  node token-cost.mjs report --json --csv .\\token-cost.csv
`;

function main() {
  if (COMMAND === "help" || flag("help")) { console.log(USAGE); return; }
  if (COMMAND === "prices") return printPrices();
  if (COMMAND !== "report") {
    console.error(`未知命令: ${COMMAND}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  const by = flag("by", "session");
  if (!["session", "turn", "model", "day"].includes(by)) throw new Error(`--by 只支持 session|turn|model|day`);
  const cutoff = sinceCutoff(flag("since"));
  const workspaceFilter = flag("workspace");
  const sessionFilter = flag("session");
  const modelFilter = flag("model");
  const limit = Number(flag("limit", "0")) || 0;

  let sessions = collectSessions();

  let rows = buildRows(sessions, by === "turn" ? "turn" : "session");
  if (cutoff) rows = rows.filter((r) => (r.when || r.exportedAt) >= cutoff);
  if (workspaceFilter) rows = rows.filter((r) => `${r.workspace} ${r.sessionId}`.toLowerCase().includes(workspaceFilter.toLowerCase()));
  if (sessionFilter) rows = rows.filter((r) => r.sessionId.startsWith(sessionFilter));
  if (modelFilter) rows = rows.filter((r) => r.model.toLowerCase().includes(modelFilter.toLowerCase()));
  rows.sort((a, b) => b.when - a.when);
  if (limit) rows = rows.slice(0, limit);

  if (by === "model") rows = groupBy(rows, (r) => r.model, (r) => r.model);
  if (by === "day") rows = groupBy(rows, (r) => clock(r.when).date, (r) => clock(r.when).date);
  if (by === "model" || by === "day") rows.sort((a, b) => b.when - a.when);

  if (flag("json")) {
    const totals = rows.reduce((acc, r) => {
      acc.uncachedInputTokens += r.tokens.miss; acc.cacheReadTokens += r.tokens.hit;
      acc.cacheWriteTokens += r.tokens.write; acc.outputTokens += r.tokens.out;
      acc.totalTokens += r.tokens.miss + r.tokens.hit + r.tokens.write + r.tokens.out;
      acc.cost += r.tokens.cost; return acc;
    }, { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 });
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      currency: CURRENCY, unit: UNIT, by,
      rows: rows.map((r) => ({
        task: r.task, detail: r.detail, startedAt: new Date(r.when).toISOString(),
        model: r.model, unknownModel: Boolean(r.flag), sessionId: r.sessionId,
        workspace: r.workspace,
        uncachedInputTokens: r.tokens.miss, cacheReadTokens: r.tokens.hit,
        cacheWriteTokens: r.tokens.write, outputTokens: r.tokens.out,
        totalTokens: r.tokens.miss + r.tokens.hit + r.tokens.write + r.tokens.out,
        cost: Number(r.tokens.cost.toFixed(6)),
      })),
      totals: { ...totals, cost: Number(totals.cost.toFixed(6)) },
      prices: PRICES_PATH,
    }, null, 2));
    return;
  }

  const csvPath = flag("csv");
  if (csvPath) {
    const header = "任务,细节,时间,模型,未命中输入,缓存命中,输出,合计tokens,金额CNY,会话ID,工作区,未知模型";
    const lines = rows.map((r) => [
      r.task, r.detail, clock(r.when).label, r.model,
      r.tokens.miss, r.tokens.hit, r.tokens.out,
      r.tokens.miss + r.tokens.hit + r.tokens.write + r.tokens.out,
      r.tokens.cost.toFixed(6), r.sessionId, r.workspace, r.flag ? "yes" : "no",
    ].map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","));
    fs.mkdirSync(path.dirname(path.resolve(csvPath)), { recursive: true });
    fs.writeFileSync(csvPath, `\uFEFF${[header, ...lines].join("\n")}`, "utf8");
    console.log(`已写入 ${lines.length} 行: ${path.resolve(csvPath)}`);
  }

  if (rows.length === 0) {
    console.log("没有匹配的任务记录。尝试去掉 --since / --workspace 过滤条件。");
    return;
  }
  const { text, totals } = renderTable(rows, by);
  console.log(text);
  console.log("");
  console.log(`任务数 ${rows.length} · 金额合计 ¥${totals.cost.toFixed(4)} ${CURRENCY}`);
  console.log(`计价口径: 每次调用按其发生时段的高峰/空闲单价计费 · 价格表 ${path.basename(PRICES_PATH)}（node ${path.join(SKILL_DIR, "scripts", "token-cost.mjs")} prices 查看）`);
  if (rows.some((r) => r.flag)) console.log("注: 带 * 的模型未在价格表中，按回退价估算。");
}

try { main(); } catch (error) {
  console.error(`错误: ${error.message}`);
  process.exitCode = 1;
}
