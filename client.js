/**
 * Token & Cost — client half.
 *
 * Renders two ambient readings inside the Conversation:
 *  - conversation.chat.turnTail  → this completed turn's tokens and cost
 *  - conversation.composer.dock  → the session's running tokens and cost
 *
 * Token counts come from the durable `tokenUsage` projection (whole session) and
 * from each turn-tail Chat node's `tokenUsage` (folded from that turn's attempts).
 * Costs use the same list prices as the `task-token-cost` skill; DeepSeek bills
 * peak and idle hours differently, so each reading is priced by its own end time.
 */

let React = null;

/** Prices in CNY per 1,000,000 tokens. Keep in sync with the skill's prices.json. */
const PRICES = {
  'deepseek-flash': {
    aliases: ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4.1-flash', 'x-deepseek-v4.1-flash'],
    peak: { miss: 2, hit: 0.04, out: 8 },
    idle: { miss: 1, hit: 0.02, out: 4 },
  },
  'deepseek-v4-pro': {
    aliases: ['deepseek-v4-pro-0813'],
    peak: { miss: 9, hit: 0.3, out: 27 },
    idle: { miss: 4.5, hit: 0.15, out: 13.5 },
  },
};
const FALLBACK_MODEL = 'deepseek-flash';

/** Peak windows: Beijing time, Monday–Friday 09:00–12:00 and 14:00–18:00. */
const PEAK_ZONE = 'Asia/Shanghai';
const PEAK_WEEKDAYS = [1, 2, 3, 4, 5];
const PEAK_RANGES = [[9 * 60, 12 * 60], [14 * 60, 18 * 60]];
const WEEKDAY_INDEX = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const CLOCK = new Intl.DateTimeFormat('en-CA', {
  timeZone: PEAK_ZONE, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

const TEXT = {
  zh: {
    turn: (tokens, money) => `本轮 ${tokens} tok · ${money}`,
    session: (tokens, money) => `会话 ${tokens} tok · ${money}`,
    sessionTokensOnly: (tokens) => `会话 ${tokens} tok`,
    input: '未命中输入',
    cache: '缓存命中',
    output: '输出',
    model: '模型',
    peak: '高峰价',
    idle: '闲时价',
    approx: '约',
    partial: '金额只统计已加载的轮次',
    unknown: '未在价格表中的模型，按 DeepSeek Flash 价估算',
    turnHint: '本轮消耗',
    sessionHint: '本次会话累计消耗',
  },
  en: {
    turn: (tokens, money) => `Turn ${tokens} tok · ${money}`,
    session: (tokens, money) => `Session ${tokens} tok · ${money}`,
    sessionTokensOnly: (tokens) => `Session ${tokens} tok`,
    input: 'Uncached input',
    cache: 'Cache read',
    output: 'Output',
    model: 'Model',
    peak: 'peak rate',
    idle: 'idle rate',
    approx: '~',
    partial: 'Cost covers loaded turns only',
    unknown: 'Model not in the price table; priced as DeepSeek Flash',
    turnHint: 'This turn',
    sessionHint: 'Session total',
  },
};

let localeService = null;

function languageOf(active) {
  const tag = String(active || '');
  if (tag.toLowerCase().startsWith('zh')) return 'zh';
  return 'en';
}

function useLanguage() {
  const subscribe = React.useCallback(
    (notify) => (localeService ? localeService.subscribe(notify) : () => {}),
    [],
  );
  const getSnapshot = React.useCallback(
    () => (localeService ? localeService.getLocale() : null),
    [],
  );
  const snapshot = React.useSyncExternalStore(subscribe, getSnapshot);
  const fallback = typeof navigator !== 'undefined' ? navigator.language : 'en';
  return languageOf(snapshot && snapshot.active ? snapshot.active : fallback);
}

function isPeak(at) {
  if (!Number.isFinite(at)) return false;
  const parts = CLOCK.formatToParts(new Date(at));
  let weekday;
  let minutes = 0;
  for (const part of parts) {
    if (part.type === 'weekday') weekday = WEEKDAY_INDEX[part.value];
    if (part.type === 'hour') minutes += Number(part.value) * 60;
    if (part.type === 'minute') minutes += Number(part.value);
  }
  if (!PEAK_WEEKDAYS.includes(weekday)) return false;
  return PEAK_RANGES.some(([from, to]) => minutes >= from && minutes < to);
}

function ratesFor(model) {
  const wanted = String(model || '').toLowerCase();
  const keys = Object.keys(PRICES);
  if (wanted && PRICES[wanted]) return { key: wanted, def: PRICES[wanted], known: true };
  for (const key of keys) {
    if (key.toLowerCase() === wanted) return { key, def: PRICES[key], known: true };
    for (const alias of PRICES[key].aliases || []) {
      if (alias.toLowerCase() === wanted) return { key, def: PRICES[key], known: true };
    }
  }
  for (const key of keys) {
    if (wanted && wanted.startsWith(key.toLowerCase())) return { key, def: PRICES[key], known: true };
  }
  return { key: FALLBACK_MODEL, def: PRICES[FALLBACK_MODEL], known: false };
}

function readUsage(usage) {
  return {
    miss: Number(usage.uncachedInputTokens) || 0,
    hit: Number(usage.cacheReadTokens) || 0,
    write: Number(usage.cacheWriteTokens) || 0,
    out: Number(usage.outputTokens) || 0,
    tokens: (Number(usage.uncachedInputTokens) || 0)
      + (Number(usage.cacheReadTokens) || 0)
      + (Number(usage.cacheWriteTokens) || 0)
      + (Number(usage.outputTokens) || 0),
  };
}

function priceOf(usage, at) {
  const counts = readUsage(usage);
  const route = (usage.routes && usage.routes[0] && usage.routes[0].model) || '';
  const { key, def, known } = ratesFor(route);
  const peak = isPeak(at);
  const rate = peak ? def.peak : def.idle;
  const cost = (counts.miss * rate.miss
    + counts.hit * rate.hit
    + counts.out * rate.out) / 1e6;
  return { ...counts, cost, model: key, known, peak };
}

function formatTokens(count) {
  if (count >= 1e6) return `${(count / 1e6).toFixed(2)}M`;
  if (count >= 1e4) return `${(count / 1e3).toFixed(1)}k`;
  if (count >= 1e3) return `${(count / 1e3).toFixed(2)}k`;
  return String(count);
}

function formatMoney(cost) {
  if (!(cost > 0)) return '¥0';
  if (cost < 0.0001) return '<¥0.0001';
  return `¥${cost.toFixed(4)}`;
}

function hintOf(title, lang, counts) {
  const text = TEXT[lang];
  return [
    title,
    `${text.input} ${counts.miss.toLocaleString('en-US')}`,
    `${text.cache} ${counts.hit.toLocaleString('en-US')}`,
    `${text.output} ${counts.out.toLocaleString('en-US')}`,
    counts.model ? `${text.model} ${counts.model}` : '',
    counts.peak === true ? text.peak : counts.peak === false ? text.idle : '',
    counts.known === false ? text.unknown : '',
  ].filter(Boolean).join('\n');
}

const TURN_STYLE = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-secondary)',
  whiteSpace: 'nowrap',
  userSelect: 'text',
};

const DOCK_STYLE = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-secondary)',
  whiteSpace: 'nowrap',
  userSelect: 'text',
};

const EMPTY = [];

function useNodes(useChat) {
  return useChat((snapshot) => {
    const nodes = snapshot && snapshot.nodes;
    return nodes && typeof nodes.values === 'function' ? nodes.values() : EMPTY;
  });
}

function turnIdOf(turn) {
  if (typeof turn === 'number') return turn;
  if (turn && typeof turn === 'object') return turn.turn ?? turn.id ?? turn.turnId;
  return undefined;
}

/** One completed turn's reading, taken from its turn-tail Chat node. */
function TurnCost(props) {
  const nodes = useNodes(props.useChat);
  const lang = useLanguage();
  const text = TEXT[lang];
  const id = turnIdOf(props.turn);
  const tail = React.useMemo(() => {
    let found;
    for (const node of nodes) {
      if (node.kind !== 'turn-tail' || !node.data || !node.data.tokenUsage) continue;
      if (node.data.turn === id) found = node;
    }
    return found;
  }, [nodes, id]);

  if (!tail) return null;
  const priced = priceOf(tail.data.tokenUsage, tail.data.time);
  if (!priced.tokens) return null;
  const money = `${priced.known ? '' : '≈'}${formatMoney(priced.cost)}`;
  return React.createElement('span', {
    style: TURN_STYLE,
    title: hintOf(text.turnHint, lang, priced),
    'data-token-cost': 'turn',
    children: text.turn(formatTokens(priced.tokens), money),
  });
}

/** The session's running reading, priced from its loaded turns. */
function SessionCost(props) {
  const nodes = useNodes(props.useChat);
  const usage = props.useProjection('tokenUsage');
  const lang = useLanguage();
  const text = TEXT[lang];
  const summary = React.useMemo(() => {
    let cost = 0;
    let tokens = 0;
    let miss = 0;
    let hit = 0;
    let out = 0;
    let known = true;
    const models = new Set();
    for (const node of nodes) {
      if (node.kind !== 'turn-tail' || !node.data || !node.data.tokenUsage) continue;
      const priced = priceOf(node.data.tokenUsage, node.data.time);
      cost += priced.cost;
      tokens += priced.tokens;
      miss += priced.miss;
      hit += priced.hit;
      out += priced.out;
      models.add(priced.model);
      if (!priced.known) known = false;
    }
    return { cost, tokens, miss, hit, out, known, model: models.size === 1 ? [...models][0] : '' };
  }, [nodes]);

  if (!usage) return null;
  const total = readUsage(usage).tokens;
  if (!total) return null;

  if (!summary.tokens) {
    return React.createElement('span', {
      style: DOCK_STYLE,
      title: text.partial,
      'data-token-cost': 'session',
      children: text.sessionTokensOnly(formatTokens(total)),
    });
  }

  const complete = summary.tokens === total;
  const money = `${complete ? '' : '≈'}${formatMoney(summary.cost)}`;
  return React.createElement('span', {
    style: DOCK_STYLE,
    title: hintOf(text.sessionHint, lang, { ...summary, peak: undefined }),
    'data-token-cost': 'session',
    children: text.session(formatTokens(total), money),
  });
}

window.__ModuleLoader__.load({
  id: 'dsh-cost-chip',
  factory(require) {
    React = require('react');
    return {
      inject: ['slots'],
      apply(ctx) {
        localeService = ctx.get('locale') || null;
        const disposers = [
          ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
            name: 'conversation.chat.turnTail',
            id: 'token-cost-turn',
            order: 10,
          }, TurnCost)),
          ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
            name: 'conversation.composer.dock',
            id: 'token-cost-session',
            order: 2,
          }, SessionCost)),
        ];
        return () => {
          for (const dispose of disposers) dispose();
          localeService = null;
        };
      },
    };
  },
});
