## What this adds

`dsh-cost-chip` puts token usage and money where people already look, and prices it the way DeepSeek actually bills.

- **Per-turn reading** under every completed answer (`本轮 12.3k tok · ¥0.0345`) and a **session
  reading** above the composer (`会话 2.11M tok · ¥0.2498`), both updating live.
- **Price locked per turn**: each reading is priced by that turn's own end time against DeepSeek's
  peak/idle rates, with cache-hit and cache-miss input priced separately, so a session that crosses
  12:00 or 18:00 is not flattened onto one rate.
- **Hover detail**: uncached input, cache read, output, model, and peak vs idle.
- **Bundled `task-token-cost` skill**: installing the plugin also registers a runtime skill that
  aggregates the whole session log per task/turn/day/model and exports CSV/JSON, so "这个月花了多少"
  works without a second install.

## Category

`usage` — Usage & Billing.

## How it differs from what is already listed

Several listed plugins report usage; they differ in placement and pricing model:

- `@zzerx/dsh-plugin-usage-billing` — sidebar card and a composer pill with monthly/today budgets and
  a settings page. This one stays ambient-only: one line per turn, one line above the composer.
- `dsh-api-dashboard` — multi-platform balances plus estimates. This one has no balances and no
  provider keys; it reads only the session's own token counts.
- `model-usage-plugin` — a settings page tab. This one has no panel at all.
- `dsh-usage-dashboard-plus` — a per-session dashboard with TTFT and CSV export. This one adds the
  per-turn chip and ships the reporting as an agent skill instead of a dashboard.

None of them price each turn by its own timestamp while also exposing the same numbers to the agent.

## Implementation

- `index.js` (Host): registers the bundled `task-token-cost` runtime skill with its directory as the
  resource base. The skill body and CLI (`scripts/token-cost.mjs`) ship inside `skills/`.
- `client.js` (Client): registers `conversation.chat.turnTail` and `conversation.composer.dock`
  entries. Readings come from the `tokenUsage` projection and each turn-tail node's folded usage —
  no new events, no files, no network.
- Zero dependencies, no build step, no install scripts.

## Checklist

- [x] `package.json` declares `dsh.bundle.patch` and `dsh.client`; `cordis.patch.yml` at the root
- [x] `engines.dsh` matches the slots used (`>=0.2.1-rc.1 <0.3.0-0`)
- [x] bilingual `locale/{en,zh}.json` with title and description, plus a package icon
- [x] single entry file, `category: usage`, only allowed keys
- [x] verified locally: both readings render and update, the skill appears in the catalog
