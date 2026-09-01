// Property-based tests (fast-check) for the allocation engine.
//
// Invariants that must hold for EVERY generated portfolio + deployable amount,
// not just hand-picked fixtures:
//   - every order amount >= 0
//   - sum(orders) <= deployable
//   - when all cash can legally be allocated, sum(orders) === deployable

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { allocate } from "../src/index";
import type { CapitalPlan, PortfolioState } from "@alepes/domain";
import { nonNegativeCents, ZERO } from "@alepes/money";

function plan(deployable: number, eventId = "e"): CapitalPlan {
  return {
    eventId,
    deployable: nonNegativeCents(deployable),
    reserve: ZERO,
    evaluation: null,
    isEmpty: deployable === 0,
  };
}

// Arbitrary portfolio state: 1..6 holdings, each with a 0..$10k position and a
// 1..60% target. This stresses the allocator across the whole space of legal
// inputs (not just balanced 50/50 fixtures).
const arbitraryPortfolio: fc.Arbitrary<PortfolioState> = fc
  .array(fc.record({
    name: fc.string({ minLength: 1, maxLength: 8 }),
    value: fc.integer({ min: 0, max: 1_000_000 }), // cents, 0..$10k
    targetPct: fc.integer({ min: 1, max: 60 }),
  }), { minLength: 1, maxLength: 6 })
  .map((rows) => {
    // Derive guaranteed-unique symbols from the index (no collisions).
    const positions = rows.map((r, i) => ({
      symbol: `S${i}`,
      name: r.name,
      value: nonNegativeCents(r.value),
    }));
    const holdings = rows.map((r, i) => ({
      symbol: `S${i}`,
      name: r.name,
      targetPct: r.targetPct,
    }));
    const total = positions.reduce((s, p) => s + (p.value as number), 0);
    return {
      portfolio: { id: "p", name: "P", version: 1, holdings },
      positions,
      totalValue: nonNegativeCents(total),
    } as PortfolioState;
  });

const arbitraryDeployable = fc.integer({ min: 0, max: 10_000_000 }); // 0..$100k in cents

describe("allocation engine — property invariants", () => {
  it("every allocation amount is non-negative", () => {
    fc.assert(
      fc.property(arbitraryPortfolio, arbitraryDeployable, (state, deployable) => {
        const result = allocate(state, plan(deployable));
        for (const line of result.lines) {
          expect(line.amount).toBeGreaterThanOrEqual(0);
        }
      }),
      { numRuns: 200 }
    );
  });

  it("sum of allocations never exceeds deployable", () => {
    fc.assert(
      fc.property(arbitraryPortfolio, arbitraryDeployable, (state, deployable) => {
        const result = allocate(state, plan(deployable));
        const sum = result.lines.reduce((s, l) => s + l.amount, 0);
        expect(sum).toBeLessThanOrEqual(deployable);
        expect(result.totalDeployed).toBeLessThanOrEqual(deployable);
        // The engine's own totalDeployed must equal the sum of its lines.
        expect(sum).toBe(result.totalDeployed);
      }),
      { numRuns: 200 }
    );
  });

  it("when all cash can legally be allocated, sum equals deployable exactly", () => {
    // A single fully-underweight asset (A: value 0, target 100%) can absorb any
    // deployable up to the portfolio total. Generate total >= deployable so full
    // deployment is guaranteed by construction (A's gap = total >= deployable).
    const singleUnderweight: fc.Arbitrary<[PortfolioState, number]> = fc
      // deployable >= 100¢ ($1.00) so it clears the default minimum trade size.
      .tuple(fc.integer({ min: 100, max: 1_000_000 }), fc.integer({ min: 0, max: 1_000_000 }))
      .map(([deployable, extra]) => {
        const total = deployable + extra; // total >= deployable
        return [
          {
            portfolio: {
              id: "p",
              name: "P",
              version: 1,
              holdings: [{ symbol: "A", name: "A", targetPct: 100 }],
            },
            positions: [{ symbol: "A", name: "A", value: nonNegativeCents(extra) }],
            totalValue: nonNegativeCents(total),
          } as PortfolioState,
          deployable,
        ];
      });

    fc.assert(
      fc.property(singleUnderweight, ([state, deployable]) => {
        if (state.totalValue === 0) return; // degenerate empty case skip
        const result = allocate(state, plan(deployable));
        const sum = result.lines.reduce((s, l) => s + l.amount, 0);
        // A is at `extra`/`total`; its target is `total`, gap = total - extra =
        // deployable, so exactly `deployable` must be deployed.
        expect(sum).toBe(deployable);
      }),
      { numRuns: 200 }
    );
  });
});