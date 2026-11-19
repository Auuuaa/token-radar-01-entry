// Token Radar's ranking model (radar-2): one sealed snapshot in, one ranked board out.
//
// The board ranks pre-token protocols by an implied value that follows only from the
// snapshot's own figures: how much value the protocol already holds (TVL), how fast
// that value is moving (seven-day change), how long it has run with no token on
// record (age), and how many chains it spans (breadth). No protocol name is ever
// special-cased: the same four multipliers score every row.
//
//   base      = tvl_usd x 0.20
//   growth    = clamp(change_7d, -75, 200)            (unreported growth counts as 0)
//   growthMul = 1 + (growth / 100) x 0.60
//   maturity  = 0.50 + min(age_days, 1460) / 1460 x 0.50   (unknown age counts as 365)
//   breadth   = 1 + min(chains - 1, 5) x 0.04
//   implied   = max(1, round(base x growthMul x maturity x breadth))
//
// Why these four: a token's launch value tracks the value already locked in the
// protocol, momentum tells whether that value is arriving or leaving, a protocol
// that has run for years with no token has the most pent-up launch value, and a
// protocol live on several chains reaches more users than a single-chain one. The
// growth clamp matters: one protocol in this snapshot grew 4,448% in a week, and
// no single week should multiply a valuation by forty-five.
//
// The watchlist is the floor, never the ceiling: every watchlist slug is ranked,
// and the early radar adds every rankable pre-token protocol below the floor, so
// the board finds the small launches the floor leaves out. Protocols whose token
// already trades are kept apart in the live set and shown at their market cap,
// never at a model's number.

/** One protocol record, exactly the ten fields the sealed snapshot carries. */
export interface Proto {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole sealed snapshot document. */
export interface Snap {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Proto[];
  watchlist: string[];
}

/** The four constants of the radar-2 model, as the dashboard states them. */
export interface RadarConstants {
  base_multiple: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  breadth_step: number;
  breadth_max_chains: number;
}

export const CONSTANTS: RadarConstants = {
  base_multiple: 0.2,
  growth_weight: 0.6,
  growth_floor: -75,
  growth_cap: 200,
  maturity_floor: 0.5,
  maturity_range: 0.5,
  maturity_days: 1460,
  unknown_age_days: 365,
  breadth_step: 0.04,
  breadth_max_chains: 5,
};

/** The model's version label, named by the dashboard and the board rows. */
export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the dashboard's Live token tab carries, by market cap. */
export const LIVE_ROWS = 30;

/** A farm step before it is flattened to one string: action, cost and time. */
export interface PlanStep {
  action: string;
  cost: string;
  time: string;
}

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    version: string;
    base_usd: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
  };
  farm_steps: string[];
}

/** One board row, compacted for the dashboard's data.js. */
export interface DashRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
  watchlist: boolean;
}

/** One live-token protocol for the dashboard's Live token tab. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard renders, from the snapshot. */
export interface DashData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: RadarConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: DashRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A finite number, else `fallback`. */
function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days from `listedAt` to `asOf`, clamped at zero; null when either is absent or bad. */
export function ageInDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The four multipliers and the implied value one protocol gets. */
export function scoreProtocol(
  p: Proto,
  asOf: string,
  c: RadarConstants = CONSTANTS,
): { implied: number; base: number; growthPct: number; growthMul: number; maturityMul: number; breadthMul: number; age: number | null } {
  const age = ageInDays(asOf, p.listed_at);
  const growthPct = Math.min(c.growth_cap, Math.max(c.growth_floor, num(p.change_7d, 0)));
  const growthMul = 1 + (growthPct / 100) * c.growth_weight;
  const ageForModel = age ?? c.unknown_age_days;
  const maturityMul =
    c.maturity_floor + (Math.min(Math.max(ageForModel, 0), c.maturity_days) / c.maturity_days) * c.maturity_range;
  const extraChains = Math.min(Math.max(p.chains.length - 1, 0), c.breadth_max_chains);
  const breadthMul = 1 + extraChains * c.breadth_step;
  const base = p.tvl_usd * c.base_multiple;
  const implied = Math.max(1, Math.round(base * growthMul * maturityMul * breadthMul));
  return { implied, base, growthPct, growthMul, maturityMul, breadthMul, age };
}

/** A name ending in a version marker (V2, v2, 2.0 and the like) is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** A protocol that records no token at all: no market cap, no CoinGecko id, no symbol. */
export function hasNoToken(p: Proto): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** A protocol the board may rank: pre-token, not an exchange, not a versioned pool. */
export function rankable(p: Proto): boolean {
  return hasNoToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The snapshot's protocols by slug. */
function indexBySlug(protocols: Proto[]): Map<string, Proto> {
  const m = new Map<string, Proto>();
  for (const p of protocols) m.set(p.slug, p);
  return m;
}

/** The ranked board: every watchlist slug, then every rankable pre-token protocol below the floor. */
export function buildBoard(snapshot: Snap, c: RadarConstants = CONSTANTS): BoardRow[] {
  const index = indexBySlug(snapshot.protocols);
  const chosen = new Map<string, Proto>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && rankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => ({ p, s: scoreProtocol(p, snapshot.as_of, c) }));
  scored.sort((a, b) => b.s.implied - a.s.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((x, i) => ({
    rank: i + 1,
    slug: x.p.slug,
    name: x.p.name,
    category: x.p.category,
    chains: x.p.chains,
    tvl_usd: x.p.tvl_usd,
    change_7d: x.p.change_7d,
    mcap_usd: x.p.mcap_usd,
    listed_at: x.p.listed_at,
    gecko_id: x.p.gecko_id,
    symbol: x.p.symbol,
    token_status: 'pre-token' as const,
    age_days: x.s.age,
    implied_value_usd: x.s.implied,
    model: {
      version: MODEL_VERSION,
      base_usd: Math.round(x.s.base),
      growth_pct: x.s.growthPct,
      growth_multiplier: round4(x.s.growthMul),
      maturity_multiplier: round4(x.s.maturityMul),
      breadth_multiplier: round4(x.s.breadthMul),
    },
    farm_steps: planSteps(x.p, x.s.age).map(flattenStep),
  }));
}

/** The live-token protocols, by market cap, kept apart from the pre-token ranking. */
export function liveRows(snapshot: Snap): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !hasNoToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** One board row, compacted for data.js. */
export function dashRow(row: BoardRow, onWatchlist: boolean): DashRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    breadth_multiplier: row.model.breadth_multiplier,
    watchlist: onWatchlist,
  };
}

/** Everything the dashboard needs, from the snapshot. */
export function buildDash(snapshot: Snap, c: RadarConstants = CONSTANTS): { board: BoardRow[]; dash: DashData } {
  const board = buildBoard(snapshot, c);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const dash: DashData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: c,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map((r) => dashRow(r, snapshot.watchlist.includes(r.slug))),
    live,
  };
  return { board, dash };
}

// ---------------------------------------------------------------- farm plans

/** One step as a single string: action, then cost and time, inside the gate's 20..600 characters. */
export function flattenStep(step: PlanStep): string {
  let s = `${step.action} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The protocol's first chain, or a neutral phrase when it names none. */
function firstChain(p: Proto): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: Proto): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** The hold window, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDays(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category family, lowercased, for the action tables below. */
function familyOf(p: Proto): string {
  return (p.category ?? '').toLowerCase();
}

/**
 * The opening move for one protocol: the action that puts capital to work in it,
 * chosen by its category family. Derived from the record, never from a name.
 */
function openMove(p: Proto, capital: number, chain: string): string {
  const f = familyOf(p);
  const name = p.name;
  if (f.includes('lend') || f.includes('cdp') || f.includes('collateral') || f.includes('uncollateralized'))
    return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (f.includes('dex') || f.includes('liquidity manager') || f.includes('yield aggregator'))
    return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (f.includes('yield') || f.includes('leveraged farm') || f.includes('farm'))
    return `Deposit $${capital} of USDC into ${name}'s highest-yield vault on ${chain} and keep the shares.`;
  if (f.includes('bridge') || f.includes('cross chain'))
    return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (f.includes('liquid staking') || f.includes('staking pool') || f.includes('restak'))
    return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt token.`;
  if (f.includes('perpetual') || f.includes('derivative') || f.includes('options') || f.includes('basis'))
    return `Deposit $${capital} of USDC as margin on ${name} and open one small hedged position.`;
  if (f.includes('prediction') || f.includes('differential'))
    return `Fund $${capital} and place one market position on ${name}.`;
  if (f.includes('curator') || f.includes('allocator') || f.includes('risk curator'))
    return `Deposit $${capital} into a ${name} curated vault on ${chain} and keep the shares.`;
  if (f.includes('stable') || f.includes('algo-stable'))
    return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (f.includes('rwa') || f.includes('reserve currency'))
    return `Mint $${capital} of the protocol's yield-bearing asset on ${chain} and hold it.`;
  if (f.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  if (f.includes('launchpad')) return `Commit $${capital} of USDC to the next ${name} launch on ${chain}.`;
  if (f.includes('payment') || f.includes('card'))
    return `Spend $${capital} through ${name} on ${chain} and keep the receipt.`;
  if (f.includes('synthetic')) return `Mint $${capital} of the synthetic asset on ${name} and hold the position.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * The second move: a follow-up action that uses the protocol a different way, so
 * the farm is more than one deposit. Chosen by the same category family.
 */
function secondMove(p: Proto, capital: number, chain: string): string {
  const f = familyOf(p);
  const name = p.name;
  if (f.includes('lend') || f.includes('cdp') || f.includes('collateral') || f.includes('uncollateralized'))
    return `Borrow $${Math.max(10, Math.round(capital / 5))} against the supply on ${name} and repay it within the week.`;
  if (f.includes('dex') || f.includes('liquidity manager') || f.includes('yield aggregator'))
    return `Swap $${Math.max(10, Math.round(capital / 5))} through ${name}'s router on ${chain} once a week.`;
  if (f.includes('bridge') || f.includes('cross chain'))
    return `Bridge $${Math.max(10, Math.round(capital / 5))} back through ${name} so the round trip is on record.`;
  if (f.includes('liquid staking') || f.includes('staking pool') || f.includes('restak'))
    return `Unstake a small slice, about $${Math.max(5, Math.round(capital / 10))}, then restake it through ${name}.`;
  if (f.includes('perpetual') || f.includes('derivative') || f.includes('options') || f.includes('basis'))
    return `Close the hedge on ${name} and open a fresh one half the size.`;
  if (f.includes('prediction') || f.includes('differential'))
    return `Settle the first market position on ${name} and place a second one.`;
  if (f.includes('curator') || f.includes('allocator') || f.includes('risk curator'))
    return `Move $${Math.max(10, Math.round(capital / 5))} into a second ${name} vault with a different risk profile.`;
  if (f.includes('launchpad')) return `Vote on the next ${name} launch with the allocation the first commit earned.`;
  if (f.includes('rwa') || f.includes('reserve currency'))
    return `Redeem a small slice, about $${Math.max(5, Math.round(capital / 10))}, of the ${name} asset and mint it again.`;
  return `Make one more qualifying action on ${name}, such as a deposit, a swap or a vote.`;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time.
 * Every number comes from the protocol's own record (category, chains, TVL, age);
 * no step is written for a particular name.
 */
export function planSteps(p: Proto, age: number | null): PlanStep[] {
  const chain = firstChain(p);
  const capital = capitalFor(p);
  const hold = holdDays(age);
  const gas = capital >= 150 ? 8 : 4;
  return [
    {
      action: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      action: openMove(p, capital, chain),
      cost: `$${capital} of capital and about $${gas} of gas`,
      time: '15 minutes to set up',
    },
    {
      action: secondMove(p, capital, chain),
      cost: `about $${gas} of gas`,
      time: '10 minutes',
    },
    {
      action: `Make one qualifying action each week on ${p.name}, such as a deposit, a borrow, a swap or a vote.`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      action: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      action: `Before you withdraw, open ${p.name}'s own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      action: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

// ---------------------------------------------------------------- snapshot parsing

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snap {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared value, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snap): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) {
    return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** The dashboard's dataset as one script: no fetch, no network, the page reads window.RADAR. */
export function dataScript(dash: DashData): string {
  return `window.RADAR=${JSON.stringify(dash)};\n`;
}
