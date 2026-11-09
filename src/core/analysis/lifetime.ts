// Observed cache lifetime from interval-censored survival observations (ADR 0009 rule LIFE-1, R-42).
// Exact rational arithmetic only: every value is an integer numerator over an integer denominator.

export interface SurvivalPoint {
  readonly gapMillis: number;
  readonly gone: boolean;
}

/** Estimated F(g) = P(lifetime ≤ g) at one observed gap, as an exact fraction. */
export interface DistributionPoint {
  readonly gapSeconds: number;
  readonly numerator: number;
  readonly denominator: number;
}

/**
 * Nonparametric maximum-likelihood estimate of F for current-status data: observations at the same gap
 * start as one block, then adjacent blocks are pooled until the values are non-decreasing (pool adjacent
 * violators). Pooling ties first makes the result independent of how tied observations are ordered.
 *
 * @param points sorted by gapMillis ascending
 */
export function lifetimeDistribution(points: readonly SurvivalPoint[]): DistributionPoint[] {
  interface Block {
    gone: number;
    total: number;
    readonly gaps: number[];
  }
  const blocks: Block[] = [];
  for (const point of points) {
    const last = blocks[blocks.length - 1];
    if (last !== undefined && last.gaps[last.gaps.length - 1] === point.gapMillis) {
      last.gone += point.gone ? 1 : 0;
      last.total += 1;
    } else {
      blocks.push({ gone: point.gone ? 1 : 0, total: 1, gaps: [point.gapMillis] });
    }
    // Pool while the previous block's value exceeds the last one's: a/b > c/d ⇔ a·d > c·b.
    while (blocks.length >= 2) {
      const right = blocks[blocks.length - 1] as Block;
      const left = blocks[blocks.length - 2] as Block;
      if (left.gone * right.total <= right.gone * left.total) break;
      left.gone += right.gone;
      left.total += right.total;
      left.gaps.push(...right.gaps);
      blocks.pop();
    }
  }
  const distribution: DistributionPoint[] = [];
  for (const block of blocks) {
    const divisor = gcd(block.gone, block.total);
    for (const gapMillis of block.gaps) {
      distribution.push({ gapSeconds: gapMillis / 1000, numerator: block.gone / divisor, denominator: block.total / divisor });
    }
  }
  return distribution;
}

/** The smallest observed gap where F ≥ 1/2, or null. */
export function medianLifetimeSeconds(distribution: readonly DistributionPoint[]): number | null {
  const point = distribution.find((p) => 2 * p.numerator >= p.denominator);
  return point === undefined ? null : point.gapSeconds;
}

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a === 0 ? 1 : a;
}
