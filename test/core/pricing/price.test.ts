// Pins the pricing rules of ADR 0011: PRICE-1 exact arithmetic and PRICE-2 call cost (R-51a, R-51b, R-16).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatMoney,
  LIST_PRICE_LABEL,
  type PricedTokens,
  type PricingConfig,
  priceCall,
  priceTable,
  totalCost,
} from "../../../src/core/pricing/price.js";

const PRICING: PricingConfig = {
  currency: "USD",
  displayDecimals: 2,
  models: {
    m: {
      effectiveDate: "2026-10-01",
      tiers: [
        {
          minContextTokens: 0,
          inputPerMillionTokens: 3,
          outputPerMillionTokens: 15,
          cacheReadPerMillionTokens: 0.3,
          cacheWritePerMillionTokensByTtlSeconds: { "300": 3.75, "3600": 6 },
        },
        {
          minContextTokens: 200001,
          inputPerMillionTokens: 6,
          outputPerMillionTokens: 22.5,
          cacheReadPerMillionTokens: 0.6,
          cacheWritePerMillionTokensByTtlSeconds: { "300": 7.5, "3600": 12 },
        },
      ],
    },
    "no-writes": {
      effectiveDate: "2026-09-15",
      tiers: [
        {
          minContextTokens: 0,
          inputPerMillionTokens: 0.1,
          outputPerMillionTokens: 1,
          cacheReadPerMillionTokens: 0.01,
          cacheWritePerMillionTokensByTtlSeconds: {},
        },
      ],
    },
  },
};

const TABLE = priceTable(PRICING);
const AT = Date.parse("2026-10-15T12:00:00.000Z");

const tokens = (spec: Partial<PricedTokens>): PricedTokens => ({
  inputUncached: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  cacheWriteByTtlSeconds: null,
  ...spec,
});

describe("PRICE-2 call cost", () => {
  it("prices each category separately, exactly, in the tier of the call's context", () => {
    const cost = priceCall(
      tokens({ inputUncached: 1000, cacheRead: 100000, cacheWrite: 20000, output: 500, cacheWriteByTtlSeconds: { "300": 20000 } }),
      "m",
      TABLE,
      AT,
    );
    assert.deepEqual(cost, {
      rule: "PRICE-2",
      model: "m",
      cost: {
        inputUncached: "0.003000000000",
        cacheRead: "0.030000000000",
        cacheWrite: "0.075000000000",
        output: "0.007500000000",
        input: "0.108000000000",
        total: "0.115500000000",
      },
      unknownReason: null,
      tierMinContextTokens: 0,
      effectiveDate: "2026-10-01",
      writePriceSubstitutions: [],
    });
  });

  it("applies the higher tier to all tokens from its minimum context on", () => {
    assert.equal(priceCall(tokens({ inputUncached: 200000 }), "m", TABLE, AT).tierMinContextTokens, 0);
    const above = priceCall(tokens({ inputUncached: 200001 }), "m", TABLE, AT);
    assert.equal(above.tierMinContextTokens, 200001);
    assert.equal(above.cost?.inputUncached, "1.200006000000");
  });

  it("prices a write lifetime with no listed price as the shortest longer one, else the longest, and says so", () => {
    const longer = priceCall(tokens({ cacheWrite: 1000, cacheWriteByTtlSeconds: { "21600": 1000 } }), "m", TABLE, AT);
    assert.equal(longer.cost?.cacheWrite, "0.006000000000");
    assert.deepEqual(longer.writePriceSubstitutions, [{ ttlSeconds: 21600, pricedAsTtlSeconds: 3600 }]);
    const shorter = priceCall(tokens({ cacheWrite: 1000, cacheWriteByTtlSeconds: { "60": 1000 } }), "m", TABLE, AT);
    assert.equal(shorter.cost?.cacheWrite, "0.003750000000");
    assert.deepEqual(shorter.writePriceSubstitutions, [{ ttlSeconds: 60, pricedAsTtlSeconds: 300 }]);
  });

  it("is unknown, with its reason, when the model, a token count or the write price is unknown (R-16)", () => {
    const reason = (t: PricedTokens, model: string | null) => priceCall(t, model, TABLE, AT).unknownReason;
    assert.equal(reason(tokens({}), null), "unpricedModel");
    assert.equal(reason(tokens({}), "other"), "unpricedModel");
    assert.equal(reason(tokens({ output: null }), "m"), "unknownTokens");
    assert.equal(reason(tokens({ cacheWrite: 10 }), "m"), "unknownWritePrice");
    assert.equal(reason(tokens({ cacheWrite: 10, cacheWriteByTtlSeconds: { "300": 9 } }), "m"), "unknownWritePrice");
    assert.equal(reason(tokens({ cacheWrite: 10, cacheWriteByTtlSeconds: { "300": 10 } }), "no-writes"), "unknownWritePrice");
    assert.equal(reason(tokens({ inputUncached: 10 }), "no-writes"), null);
    assert.equal(priceCall(tokens({ output: null }), "m", TABLE, AT).cost, null);
  });
});

describe("announced price changes (ADR 0011)", () => {
  const tier = (input: number) => ({ minContextTokens: 0, inputPerMillionTokens: input, outputPerMillionTokens: 10, cacheReadPerMillionTokens: 0.1, cacheWritePerMillionTokensByTtlSeconds: {} });
  const table = priceTable({ currency: "USD", displayDecimals: 2, models: { g: { effectiveDate: "2026-11-01", tiers: [tier(2)], changes: [{ effectiveDate: "2026-12-01", tiers: [tier(4)] }] } } });
  const at = (iso: string) => priceCall(tokens({ inputUncached: 1_000_000 }), "g", table, Date.parse(iso));

  it("prices each call at the prices in force on its UTC date; earlier calls get the first prices", () => {
    assert.deepEqual(
      ["2026-10-20T08:00:00.000Z", "2026-11-30T23:59:59.999Z", "2026-12-01T00:00:00.000Z"].map((iso) => [at(iso).cost?.input, at(iso).effectiveDate]),
      [
        ["2.000000000000", "2026-11-01"],
        ["2.000000000000", "2026-11-01"],
        ["4.000000000000", "2026-12-01"],
      ],
    );
  });

  it("lists every effective date a total used", () => {
    const total = totalCost([at("2026-12-02T00:00:00.000Z"), at("2026-11-02T00:00:00.000Z")], table);
    assert.deepEqual([total.known.input, total.effectiveDates], ["6.000000000000", { g: ["2026-11-01", "2026-12-01"] }]);
  });
});

describe("PRICE-1 exact arithmetic", () => {
  it("sums fractional prices without floating-point error", () => {
    const tenth = priceCall(tokens({ inputUncached: 1 }), "no-writes", TABLE, AT);
    const total = totalCost(Array.from({ length: 3 }, () => tenth), TABLE);
    assert.equal(total.known.inputUncached, "0.000000300000");
  });

  it("keeps totals exact beyond the safe integer range", () => {
    const huge = priceCall(tokens({ inputUncached: 9_000_000_000_000 }), "m", TABLE, AT);
    assert.equal(huge.cost?.inputUncached, "54000000.000000000000");
  });

  it("rounds only for display, half to even", () => {
    assert.equal(formatMoney("0.115500000000", 2), "0.12");
    assert.equal(formatMoney("0.125000000000", 2), "0.12");
    assert.equal(formatMoney("0.135000000000", 2), "0.14");
    assert.equal(formatMoney("2.500000000000", 0), "2");
    assert.equal(formatMoney("3.500000000000", 0), "4");
    assert.equal(formatMoney("0.000000000000", 2), "0.00");
  });
});

describe("totals (R-16, R-51a, R-51b)", () => {
  it("sums known costs, counts unknown calls by reason, and names the effective dates and the label", () => {
    const total = totalCost(
      [
        priceCall(tokens({ inputUncached: 1000 }), "m", TABLE, AT),
        priceCall(tokens({ inputUncached: 1000 }), "no-writes", TABLE, AT),
        priceCall(tokens({}), null, TABLE, AT),
        priceCall(tokens({ cacheWrite: 1, cacheWriteByTtlSeconds: { "21600": 1 } }), "m", TABLE, AT),
      ],
      TABLE,
    );
    assert.equal(total.known.inputUncached, "0.003100000000");
    assert.equal(total.pricedCalls, 3);
    assert.deepEqual(total.unknownCalls, { unpricedModel: 1, unknownTokens: 0, unknownWritePrice: 0 });
    assert.equal(total.incomplete, true);
    assert.deepEqual(total.effectiveDates, { m: ["2026-10-01"], "no-writes": ["2026-09-15"] });
    assert.deepEqual(total.writePriceSubstitutions, [{ ttlSeconds: 21600, pricedAsTtlSeconds: 3600 }]);
    assert.equal(total.label, LIST_PRICE_LABEL);
    assert.equal(total.currency, "USD");
  });

  it("is complete when every call has a cost", () => {
    assert.equal(totalCost([priceCall(tokens({}), "m", TABLE, AT)], TABLE).incomplete, false);
  });
});
