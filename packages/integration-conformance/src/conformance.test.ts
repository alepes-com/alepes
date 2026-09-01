import { describe, it, expect } from "vitest";
import { certifyBank, certifyBrokerage } from "./conformance";
import { createMockBank } from "@alepes/mock-bank";
import { createMockBrokerage } from "@alepes/mock-brokerage";
import { nonNegativeCents, cents } from "@alepes/money";

describe("conformance certification", () => {
  it("certifies the mock bank plugin", async () => {
    const bank = createMockBank({
      checkingBalance: nonNegativeCents(4812_44),
      deposits: [],
    });
    const report = await certifyBank(bank.plugin);
    expect(report.failures).toEqual([]);
    expect(report.pass).toBe(true);
  });

  it("certifies the mock brokerage plugin", async () => {
    const brokerage = createMockBrokerage({
      portfolio: {
        portfolio: { id: "p", name: "P", version: 1, holdings: [] },
        positions: [],
        totalValue: nonNegativeCents(0),
      },
      prices: { AAPL: cents(232_40) },
    });
    const report = await certifyBrokerage(brokerage.plugin);
    expect(report.failures).toEqual([]);
    expect(report.pass).toBe(true);
  });

  it("a plugin missing a required capability FAILS certification", async () => {
    // A broken plugin exposing no capabilities must not pass.
    const broken = {
      id: "plugin:broken",
      name: "Broken",
      version: "1.0.0",
      capabilities: new Map(),
      lifecycle: { connect: async () => {}, disconnect: async () => {}, health: async () => null },
    };
    const report = await certifyBank(broken);
    expect(report.pass).toBe(false);
    expect(report.failures.length).toBeGreaterThan(0);
  });
});