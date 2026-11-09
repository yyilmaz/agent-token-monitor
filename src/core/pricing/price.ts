// Pricing: exact currency arithmetic and the cost of a call (ADR 0011 rules PRICE-1 and PRICE-2, R-51, R-51a, R-51b).
// Pure functions. Costs are integers in units of 10^-12 of the currency, computed with BigInt; they leave the core
// as decimal strings. Rounding happens only in formatMoney, for display.

import type { Config } from "../config/config.js";
import type { Call, EpochMillis } from "../model/index.js";
import { compareStrings } from "../order.js";

export type PricingConfig = Config["pricing"];

/** R-51b: shown with every currency figure. */
export const LIST_PRICE_LABEL =
  "API list-price equivalent, not your bill. Subscription and quota plans do not bill per token.";

/** A currency amount as a decimal string with 12 decimal places, e.g. "12.345678000000". */
export type Money = string;

export type UnknownCostReason = "unpricedModel" | "unknownTokens" | "unknownWritePrice";

/** The token counts one call is priced on: a real Call, or a simulated call of ADR 0010. */
export interface PricedTokens {
  readonly inputUncached: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  readonly output: number | null;
  /** Cache-write tokens by lifetime in seconds; null when the log does not split them. */
  readonly cacheWriteByTtlSeconds: Readonly<Record<string, number>> | null;
}

export interface CostParts {
  readonly inputUncached: Money;
  readonly cacheRead: Money;
  readonly cacheWrite: Money;
  readonly output: Money;
  /** inputUncached + cacheRead + cacheWrite. */
  readonly input: Money;
  readonly total: Money;
}

/** Which listed lifetime priced the writes of a lifetime that has no price of its own. */
export interface WritePriceSubstitution {
  readonly ttlSeconds: number;
  readonly pricedAsTtlSeconds: number;
}

export interface CallCost {
  readonly rule: "PRICE-2";
  readonly model: string | null;
  readonly cost: CostParts | null;
  readonly unknownReason: UnknownCostReason | null;
  /** The tier that applied, by its minContextTokens; null when the cost is unknown. */
  readonly tierMinContextTokens: number | null;
  /** The effective date of the prices that applied; null when the cost is unknown. */
  readonly effectiveDate: string | null;
  readonly writePriceSubstitutions: readonly WritePriceSubstitution[];
}

export interface CostTotal {
  readonly currency: string;
  readonly label: typeof LIST_PRICE_LABEL;
  /** Exact sum over the calls whose cost is known. */
  readonly known: CostParts;
  readonly pricedCalls: number;
  readonly unknownCalls: Readonly<Record<UnknownCostReason, number>>;
  /** True when some calls have no cost: the total must be labeled "incomplete" (R-16). */
  readonly incomplete: boolean;
  /** Effective dates of the prices used, per priced model the total covers, ascending (R-51a). */
  readonly effectiveDates: Readonly<Record<string, readonly string[]>>;
  readonly writePriceSubstitutions: readonly WritePriceSubstitution[];
}

interface TierPrices {
  readonly minContextTokens: number;
  readonly input: bigint;
  readonly output: bigint;
  readonly cacheRead: bigint;
  /** Listed write lifetimes ascending, with their prices. */
  readonly writes: readonly (readonly [ttlSeconds: number, price: bigint])[];
}

/** The prices of a model from `effectiveDate` until the next period's date. */
interface PricePeriod {
  readonly effectiveDate: string;
  readonly tiers: readonly TierPrices[];
}

export interface PriceTable {
  readonly currency: string;
  /** Each model's price periods, ascending by date. */
  readonly models: ReadonlyMap<string, readonly PricePeriod[]>;
}

const MILLION = 1_000_000;
const MONEY_DECIMALS = 12;

/** PRICE-1: every price becomes an integer number of millionths per million tokens. */
export function priceTable(config: PricingConfig): PriceTable {
  const micros = (price: number): bigint => BigInt(Math.round(price * MILLION));
  type Tiers = PricingConfig["models"][string]["tiers"];
  const tiers = (list: Tiers): TierPrices[] =>
    list.map((tier) => ({
      minContextTokens: tier.minContextTokens,
      input: micros(tier.inputPerMillionTokens),
      output: micros(tier.outputPerMillionTokens),
      cacheRead: micros(tier.cacheReadPerMillionTokens),
      writes: Object.entries(tier.cacheWritePerMillionTokensByTtlSeconds)
        .map(([ttl, price]) => [Number(ttl), micros(price)] as const)
        .sort(([a], [b]) => a - b),
    }));
  const models = new Map<string, PricePeriod[]>();
  for (const name of Object.keys(config.models).sort(compareStrings)) {
    const model = config.models[name] as PricingConfig["models"][string];
    const periods = [model, ...(model.changes ?? [])];
    models.set(name, periods.map((p) => ({ effectiveDate: p.effectiveDate, tiers: tiers(p.tiers) })));
  }
  return { currency: config.currency, models };
}

/**
 * The prices of `model` in force at `at`: the last period whose date is on or before the UTC date of `at`. A time
 * before the first period gets the first one, the earliest prices known. Null when the model has no price.
 */
function pricesAt(model: string | null, at: EpochMillis, table: PriceTable): PricePeriod | null {
  const periods = model === null ? undefined : table.models.get(model);
  if (periods === undefined) return null;
  const day = new Date(at).toISOString().slice(0, 10);
  return periods.reduce((chosen, p) => (p.effectiveDate <= day ? p : chosen));
}

function tierFor(period: PricePeriod, contextTokens: number): TierPrices {
  return period.tiers.reduce((chosen, t) => (t.minContextTokens <= contextTokens ? t : chosen));
}

/** The tokens of a real Call. */
export function callTokens(call: Call): PricedTokens {
  return {
    inputUncached: call.inputUncached,
    cacheRead: call.cacheRead,
    cacheWrite: call.cacheWrite,
    output: call.output,
    cacheWriteByTtlSeconds: call.cacheWriteByTtlSeconds,
  };
}

/** PRICE-2: the cost of one call under the effective model `model`, at the prices in force at time `at`. */
export function priceCall(tokens: PricedTokens, model: string | null, table: PriceTable, at: EpochMillis): CallCost {
  const unknown = (reason: UnknownCostReason): CallCost => ({
    rule: "PRICE-2",
    model,
    cost: null,
    unknownReason: reason,
    tierMinContextTokens: null,
    effectiveDate: null,
    writePriceSubstitutions: [],
  });

  const period = pricesAt(model, at, table);
  if (period === null) return unknown("unpricedModel");
  const { inputUncached, cacheRead, cacheWrite, output } = tokens;
  if (inputUncached === null || cacheRead === null || cacheWrite === null || output === null) return unknown("unknownTokens");

  const context = inputUncached + cacheRead + cacheWrite;
  const tier = tierFor(period, context);

  let writeCost = 0n;
  const substitutions: WritePriceSubstitution[] = [];
  if (cacheWrite > 0) {
    const split = tokens.cacheWriteByTtlSeconds;
    if (split === null) return unknown("unknownWritePrice");
    let splitTotal = 0;
    for (const ttl of Object.keys(split).sort((a, b) => Number(a) - Number(b))) {
      const written = split[ttl] as number;
      splitTotal += written;
      if (written === 0) continue;
      const priced = writePrice(tier, Number(ttl));
      if (priced === null) return unknown("unknownWritePrice");
      if (priced.ttlSeconds !== Number(ttl)) substitutions.push({ ttlSeconds: Number(ttl), pricedAsTtlSeconds: priced.ttlSeconds });
      writeCost += BigInt(written) * priced.price;
    }
    if (splitTotal !== cacheWrite) return unknown("unknownWritePrice");
  }

  return {
    rule: "PRICE-2",
    model,
    cost: parts(BigInt(inputUncached) * tier.input, BigInt(cacheRead) * tier.cacheRead, writeCost, BigInt(output) * tier.output),
    unknownReason: null,
    tierMinContextTokens: tier.minContextTokens,
    effectiveDate: period.effectiveDate,
    writePriceSubstitutions: substitutions,
  };
}

/** The listed price for a lifetime, else the shortest longer listed lifetime, else the longest listed one. */
function writePrice(tier: TierPrices, ttlSeconds: number): { ttlSeconds: number; price: bigint } | null {
  const exactOrLonger = tier.writes.find(([ttl]) => ttl >= ttlSeconds) ?? tier.writes[tier.writes.length - 1];
  return exactOrLonger === undefined ? null : { ttlSeconds: exactOrLonger[0], price: exactOrLonger[1] };
}

/**
 * ADR 0015: `tokens` full-price input tokens at the input price of the tier that applies to a context of
 * `contextTokens`. Null when the model has no price.
 */
export function priceInput(tokens: number, contextTokens: number, model: string | null, table: PriceTable, at: EpochMillis): Money | null {
  const period = pricesAt(model, at, table);
  if (period === null) return null;
  return toMoney(BigInt(tokens) * tierFor(period, contextTokens).input);
}

/**
 * ADR 0017: the cost of a hypothetical step, `tokens` of each kind at the prices of the tier for a context of
 * `contextTokens`, writes at the price of lifetime `ttlSeconds` (PRICE-2's write rule). Null when the model has no
 * price, or when writes are asked for and the tier lists no write price.
 */
export function priceStep(
  model: string,
  contextTokens: number,
  ttlSeconds: number,
  tokens: { readonly cacheRead?: number; readonly cacheWrite?: number; readonly output?: number },
  table: PriceTable,
  at: EpochMillis,
): Money | null {
  const period = pricesAt(model, at, table);
  if (period === null) return null;
  const tier = tierFor(period, contextTokens);
  const written = tokens.cacheWrite ?? 0;
  const write = written > 0 ? writePrice(tier, ttlSeconds) : null;
  if (written > 0 && write === null) return null;
  return toMoney(BigInt(tokens.cacheRead ?? 0) * tier.cacheRead + BigInt(written) * (write?.price ?? 0n) + BigInt(tokens.output ?? 0) * tier.output);
}

/** Exact `money × count`. */
export function moneyTimes(money: Money, count: number): Money {
  return toMoney(toUnits(money) * BigInt(count));
}

/** Negative, zero or positive as `a` is less than, equal to or greater than `b`. */
export function compareMoney(a: Money, b: Money): number {
  const d = toUnits(a) - toUnits(b);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
}

/**
 * ADR 0017 break-even: the fewest later messages after which an option that costs `oneTime` now and `perMessage`
 * per message beats a base that costs `baseOneTime` and `basePerMessage`. 0 when it costs no more now; null
 * ("never") when it saves nothing per message.
 */
export function breakEvenMessages(oneTime: Money, perMessage: Money, baseOneTime: Money, basePerMessage: Money): number | null {
  const owed = toUnits(oneTime) - toUnits(baseOneTime);
  if (owed <= 0n) return 0;
  const saved = toUnits(basePerMessage) - toUnits(perMessage);
  if (saved <= 0n) return null;
  return Number((owed + saved - 1n) / saved);
}

/** Exact sum of amounts. */
export function sumMoney(amounts: readonly Money[]): Money {
  return toMoney(amounts.reduce((sum, m) => sum + toUnits(m), 0n));
}

/** Exact `a − b`, or null when it is negative (costs are never negative). */
export function moneyDifference(a: Money, b: Money): Money | null {
  const units = toUnits(a) - toUnits(b);
  return units < 0n ? null : toMoney(units);
}

/** Exact sum of many call costs, with the calls that have none counted by reason (R-16). */
export function totalCost(costs: readonly CallCost[], table: PriceTable): CostTotal {
  const sums = { inputUncached: 0n, cacheRead: 0n, cacheWrite: 0n, output: 0n };
  const unknownCalls: Record<UnknownCostReason, number> = { unpricedModel: 0, unknownTokens: 0, unknownWritePrice: 0 };
  const effectiveDates = new Map<string, Set<string>>();
  const substitutions = new Map<string, WritePriceSubstitution>();
  let pricedCalls = 0;
  for (const c of costs) {
    if (c.cost === null) {
      unknownCalls[c.unknownReason as UnknownCostReason] += 1;
      continue;
    }
    pricedCalls += 1;
    sums.inputUncached += toUnits(c.cost.inputUncached);
    sums.cacheRead += toUnits(c.cost.cacheRead);
    sums.cacheWrite += toUnits(c.cost.cacheWrite);
    sums.output += toUnits(c.cost.output);
    const model = c.model as string;
    const dates = effectiveDates.get(model) ?? new Set<string>();
    effectiveDates.set(model, dates.add(c.effectiveDate as string));
    for (const s of c.writePriceSubstitutions) substitutions.set(`${s.ttlSeconds}:${s.pricedAsTtlSeconds}`, s);
  }
  const sortedDates: Record<string, readonly string[]> = {};
  for (const model of [...effectiveDates.keys()].sort(compareStrings)) sortedDates[model] = [...(effectiveDates.get(model) as Set<string>)].sort(compareStrings);
  return {
    currency: table.currency,
    label: LIST_PRICE_LABEL,
    known: parts(sums.inputUncached, sums.cacheRead, sums.cacheWrite, sums.output),
    pricedCalls,
    unknownCalls,
    incomplete: costs.length > pricedCalls,
    effectiveDates: sortedDates,
    writePriceSubstitutions: [...substitutions.values()].sort(
      (a, b) => a.ttlSeconds - b.ttlSeconds || a.pricedAsTtlSeconds - b.pricedAsTtlSeconds,
    ),
  };
}

function parts(inputUncached: bigint, cacheRead: bigint, cacheWrite: bigint, output: bigint): CostParts {
  const input = inputUncached + cacheRead + cacheWrite;
  return {
    inputUncached: toMoney(inputUncached),
    cacheRead: toMoney(cacheRead),
    cacheWrite: toMoney(cacheWrite),
    output: toMoney(output),
    input: toMoney(input),
    total: toMoney(input + output),
  };
}

/** Units of 10^-12 of the currency to a decimal string. Costs are never negative. */
function toMoney(units: bigint): Money {
  const digits = units.toString().padStart(MONEY_DECIMALS + 1, "0");
  return `${digits.slice(0, -MONEY_DECIMALS)}.${digits.slice(-MONEY_DECIMALS)}`;
}

function toUnits(money: Money): bigint {
  return BigInt(money.replace(".", ""));
}

/** Display only: rounds half to even to `decimals` places (ADR 0011). */
export function formatMoney(money: Money, decimals: number): string {
  const units = toUnits(money);
  const drop = BigInt(10) ** BigInt(MONEY_DECIMALS - Math.min(decimals, MONEY_DECIMALS));
  let kept = units / drop;
  const remainder = units % drop;
  if (remainder * 2n > drop || (remainder * 2n === drop && kept % 2n === 1n)) kept += 1n;
  if (decimals === 0) return kept.toString();
  const shown = Math.min(decimals, MONEY_DECIMALS);
  const digits = kept.toString().padStart(shown + 1, "0");
  return `${digits.slice(0, -shown)}.${digits.slice(-shown)}${"0".repeat(decimals - shown)}`;
}

/** Display only: `money / tokens × perTokens`, rounded half to even to `decimals` places (ADR 0012 CMP-2). */
export function formatMoneyPer(money: Money, tokens: number, perTokens: number, decimals: number): string {
  const scale = BigInt(10) ** BigInt(decimals);
  const numerator = toUnits(money) * BigInt(perTokens) * scale;
  const denominator = BigInt(tokens) * BigInt(10) ** BigInt(MONEY_DECIMALS);
  let kept = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder * 2n > denominator || (remainder * 2n === denominator && kept % 2n === 1n)) kept += 1n;
  if (decimals === 0) return kept.toString();
  const digits = kept.toString().padStart(decimals + 1, "0");
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}
