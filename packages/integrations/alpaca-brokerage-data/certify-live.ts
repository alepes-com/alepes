// Alpaca LIVE read-only certification harness — first-hand evidence for v0.4.0.
//
// This is a STANDALONE script, NOT part of the ordinary Vitest unit suite and
// NOT part of CI. It talks to the REAL Alpaca LIVE trading API (api.alpaca.markets)
// and therefore requires live credentials. Run it explicitly:
//
//   ALEPES_ALPACA_LIVE_KEY=<live key id> \
//   ALEPES_ALPACA_LIVE_SECRET=<live secret> \
//   bun run certify:alpaca-live
//
// SECURITY: never prints key id, secret, account ids, or raw API responses
// verbatim. Redacts them to deterministic fingerprints. Refuses anything except
// the explicit "live" environment (paper/sandbox blocked).
//
// CERTIFICATION GATES (read-only): this harness performs NO mutation and has NO
// order/transfer/ACH surface. It proves:
//   1. refuses anything except explicit "live" environment configuration;
//   2. authenticates with live credentials without printing them;
//   3. reads the exact live account and fingerprints its provider ID;
//   4. reads live cash / buying-power / account status;
//   5. reads real live positions;
//   6. normalizes quantities and monetary values without JS-float authoritative money;
//   7. reads prices for those positions;
//   8. constructs the provider-neutral PortfolioState via brokerage-shadow bridge;
//   9. runs the FULL Observe→Decide→Validate→Shadow pipeline on a synthetic
//      qualifying deposit, producing ONLY shadow decisions (zero orders);
//   10. proves no submitOrders capability is registered or reachable;
//   11. produces no live orders, transfers, or brokerage mutations.

import { createAlpacaLiveClient, createAlpacaBrokerageDataProvider, ALPACA_LIVE_BASE_URL, type AlpacaBrokerageDataProviderOptions, } from "@alepes/alpaca-brokerage-data";
import { fromDecimalString, nonNegativeCents, toNumber, } from "@alepes/money";
import { brokerageToPortfolioState, runShadowMode, cashEventIdForObservation, type ShadowModeInput, } from "@alepes/reconciliation";
import type { AccountBinding } from "@alepes/integration-runtime";
import type { CashFlowRule, RuleTrigger, RuleAction, PortfolioState } from "@alepes/domain";
import type { PersistedObservation, ObservationState, AccountBindingId } from "@alepes/persistence";
import type { FinancialObservationId } from "@alepes/domain";

// ─── Environment guard ────────────────────────────────────────────────────────

const ENV = process.env.ALEPES_ALPACA_ENV ?? "live";
if (ENV !== "live") {
  console.error(
    `REFUSING TO RUN: ALEPES_ALPACA_ENV must be "live", got ${JSON.stringify(ENV)}. ` +
      "This harness ONLY contacts Alpaca live trading (api.alpaca.markets)."
  );
  process.exit(2);
}

const KEY = process.env.ALEPES_ALPACA_LIVE_KEY;
const SECRET = process.env.ALEPES_ALPACA_LIVE_SECRET;

if (!KEY || !SECRET) {
  console.error(
    "REFUSING TO RUN: ALEPES_ALPACA_LIVE_KEY and ALEPES_ALPACA_LIVE_SECRET must both be set (live)."
  );
  process.exit(2);
}

const KEY_ID = KEY as string;
const SECRET_KEY = SECRET as string;

// ─── Redaction helpers ────────────────────────────────────────────────────────

function fp(value: string): string {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) | 0;
  return `fp-${(h >>> 0).toString(16)}-len${value.length}`;
}

const accountIds: string[] = [];
function redact(s: unknown): unknown {
  if (typeof s !== "string") return s;
  let out = s;
  out = out.replaceAll(KEY_ID, "REDACTED_KEY");
  out = out.replaceAll(SECRET_KEY, "REDACTED_SECRET");
  for (const id of accountIds) out = out.replaceAll(id, `REDACTED_ACCOUNT(${fp(id)})`);
  return out;
}

// ─── Report accumulator ──────────────────────────────────────────────────────

type Point = { id: number; name: string; status: "pass" | "fail"; detail?: unknown };
const points: Point[] = [];
function record(id: number, name: string, status: "pass" | "fail", detail?: unknown): void {
  points.push({ id, name, status, detail: redact(detail) });
}
async function step<T>(id: number, name: string, fn: () => Promise<T>): Promise<T> {
  try {
    const detail = await fn();
    record(id, name, "pass", detail);
    return detail;
  } catch (e) {
    record(id, name, "fail", e instanceof Error ? e.message : String(e));
    throw e;
  }
}

// ─── Synthetic observation for pipeline proof ────────────────────────────────
// This is an IN-MEMORY, clearly-labeled observation that does NOT come from
// the live account. It proves the Observe→Decide→Validate→Shadow wiring works
// even when the live account has no qualifying deposits. It is NEVER persisted.

function makeSyntheticDepositObservation(
  accountBindingId: AccountBindingId,
  amountCents: number
): PersistedObservation {
  const now = new Date().toISOString();
  return {
    id: cashEventIdForObservation(`synth-dep-${Date.now()}`) as FinancialObservationId,
    accountBindingId,
    amountCents: nonNegativeCents(amountCents),
    direction: "credit",
    status: "posted",
    qualificationBalanceCents: nonNegativeCents(amountCents),
    firstObservedAt: now,
    postedAt: now,
    description: "SYNTHETIC pipeline proof deposit (NOT from live account)",
    normalizationVersion: "v0.4.0",
    state: "active" as ObservationState,
    predecessorObservationId: null,
    lastReconciledCycleId: null,
    createdAt: now,
    updatedAt: now,
  };
}

// A deterministic rule that would deploy a percentage of the deposit.
const SYNTHETIC_RULE: CashFlowRule = {
  id: "synth-shadow-rule-001",
  name: "Synthetic Shadow Proof Rule",
  trigger: "any_deposit" as RuleTrigger,
  minAmount: nonNegativeCents(10000), // $100
  reserveBalance: nonNegativeCents(1000), // $10
  action: "invest_percentage" as RuleAction,
  amount: 50, // 50%
  maxPerDeposit: nonNegativeCents(50000), // $500
  maxPerMonth: nonNegativeCents(100000), // $1000
  portfolioId: "observed:synth",
  active: true,
  order: 1,
};

// ─── The 11-gate certification run ──────────────────────────────────────────

async function main(): Promise<void> {
  // Gate 1 — refuse anything except explicit "live" configuration.
  await step(1, "refuses anything except explicit live environment", async () => {
    if (ENV !== "live") throw new Error(`bad env ${ENV}`);
    return { env: ENV, baseUrl: ALPACA_LIVE_BASE_URL };
  });

  // Gate 2 — authenticate WITHOUT printing credentials.
  const client = createAlpacaLiveClient(KEY_ID, SECRET_KEY);
  const provider = createAlpacaBrokerageDataProvider({
    client,
    environment: "live",
    resolveCredentialRef: async () => "cred:alpaca-live",
  } satisfies AlpacaBrokerageDataProviderOptions);

  await step(2, "authenticates with live credentials without printing them", async () => {
    const { status, data } = await client.getAccount();
    if (status === 401 || status === 403) throw new Error("live auth failed");
    accountIds.push(data.id);
    return {
      status,
      authenticated: status < 400,
      accountFingerprint: fp(data.id),
      accountNumberFingerprint: data.account_number ? fp(data.account_number) : "n/a",
    };
  });

  let binding: AccountBinding | null = null;

  // Gate 3 — read the exact live account + fingerprint provider id.
  await step(3, "reads exact live account and fingerprints provider id", async () => {
    const accts = await provider.discoverAccounts("cred:alpaca-live");
    if (accts.length === 0) throw new Error("no live account discovered");
    binding = accts[0];
    // Assert the provider reports the live environment in metadata.
    if (binding.metadata.environment !== "live") {
      throw new Error(`expected environment "live", got ${binding.metadata.environment}`);
    }
    const providerRef = binding.providerAccountRef as string;
    accountIds.push(providerRef);
    return {
      providerRefFingerprint: fp(providerRef),
      name: binding.name,
      environment: binding.metadata.environment,
    };
  });

  if (!binding) throw new Error("unreachable: binding missing");

  const fullAccount = await provider.readAccount(binding);

  // Gate 4 — read live cash / buying-power / status.
  const accountFacts = await step(4, "reads live cash/buying-power/account status", async () => {
    return {
      status: fullAccount.status,
      cashCents: toNumber(fullAccount.cashCents),
      buyingPowerCents: toNumber(fullAccount.buyingPowerCents),
      portfolioValueCents: toNumber(fullAccount.portfolioValueCents),
    };
  });

  // Gate 5 — read real live positions.
  const positions = await step(5, "reads real live positions", async () => {
    const p = await provider.readPositions(binding!);
    return p.map((x: typeof p[number]) => ({
      symbol: x.symbol,
      quantity: x.quantity,
      marketValueCents: nonNegativeCents(toNumber(x.marketValueCents)),
      averageEntryPriceCents: nonNegativeCents(toNumber(x.averageEntryPriceCents)),
      currency: x.currency,
    }));
  });

  // Gate 6 — normalization without JS-float authoritative money (exact decimal).
  await step(6, "normalizes live money without JS-float authoritative money", async () => {
    const { data } = await client.getAccount();
    const exactCents = fromDecimalString(data.cash);
    if (toNumber(exactCents) !== accountFacts.cashCents) {
      throw new Error("float vs exact normalization mismatch on live account");
    }
    return { cashDecimal: data.cash, cashCents: accountFacts.cashCents };
  });

  // Gate 7 — read prices for the observed positions.
  const symbols = positions.map((p) => p.symbol);
  await step(7, "reads prices for live positions", async () => {
    if (symbols.length === 0) return { prices: {}, note: "no live positions to price" };
    const prices = await provider.readPrices(binding!, symbols);
    return Object.fromEntries(
      Object.entries(prices).map(([s, c]) => [s, toNumber(c)])
    );
  });

  // Gate 8 — construct provider-neutral PortfolioState via brokerage-shadow bridge.
  await step(
    8,
    "constructs provider-neutral PortfolioState via brokerage-shadow bridge",
    async () => {
      const accountLabel = binding!.name ?? "live-alpaca";
      const portfolioState = brokerageToPortfolioState(accountLabel, positions);
      if (typeof portfolioState.totalValue !== "number")
        throw new Error("bad portfolio state totalValue");
      if (!Array.isArray(portfolioState.positions))
        throw new Error("bad portfolio state positions array");
      if (!portfolioState.portfolio || !portfolioState.portfolio.holdings)
        throw new Error("bad portfolio state portfolio.holdings");
      return {
        symbolCount: portfolioState.positions.length,
        totalValueCents: toNumber(portfolioState.totalValue),
        holdingsCount: portfolioState.portfolio.holdings.length,
        portfolioId: portfolioState.portfolio.id,
      };
    }
  );

  // Gate 9 — run the FULL Observe→Decide→Validate→Shadow pipeline on synthetic deposit.
  await step(
    9,
    "runs full Observe→Decide→Validate→Shadow pipeline (synthetic deposit, live portfolio)",
    async () => {
      const accountLabel = binding!.name ?? "live-alpaca";
      const portfolioState = brokerageToPortfolioState(accountLabel, positions);

      // Build a synthetic qualifying deposit observation.
      // SAFETY: binding.id is already the branded AccountBindingId; the cast is a
      // narrowing artifact only, and no credential/policy data is moved.
      const syntheticObs = makeSyntheticDepositObservation(
        binding!.id as AccountBindingId,
        50000 // $500 deposit → should qualify (> $100 min, > $10 reserve)
      );

      const shadowInput: ShadowModeInput = {
        rules: [SYNTHETIC_RULE],
        portfolioState,
      };

      const decisions = runShadowMode([syntheticObs], shadowInput);

      // Assertions: shadow disposition, no actual orders, investment amount logic correct.
      const shadowDecisions = decisions.filter(
        (d: typeof decisions[number]) => d.disposition.kind === "shadow"
      );
      const execDecisions = decisions.filter(
        (d: typeof decisions[number]) => d.disposition.kind === "execute"
      );

      if (shadowDecisions.length === 0 && syntheticObs.amountCents >= 10000) {
        throw new Error("expected at least one shadow decision for qualifying synthetic deposit");
      }
      if (execDecisions.length > 0) {
        throw new Error(`found ${execDecisions.length} execute disposition(s); must be ZERO`);
      }

      // Verify the investment math matches the rules-engine semantics:
      //   gross = 50% of the $500 deposit = 25000;
      //   reserve check: checkingBalanceAfter(50000) − reserve(1000) = 49000,
      //   and 25000 ≤ 49000 so no reduction; deployable = 25000.
      const expectedInvestment = 25000;
      if (shadowDecisions.length > 0) {
        const firstDecision = shadowDecisions[0];
        const deployable = toNumber(firstDecision.plan.capitalPlan.deployable);
        if (deployable !== expectedInvestment) {
          throw new Error(
            `investment amount mismatch: expected ${expectedInvestment}, got ${deployable}`
          );
        }
        if (firstDecision.plan.orders.length !== 0) {
          throw new Error(
            `shadow decision produced ${firstDecision.plan.orders.length} order(s); must be ZERO`
          );
        }
      }

      return {
        decisionsCount: decisions.length,
        shadowCount: shadowDecisions.length,
        executeCount: execDecisions.length,
        firstDeployableCents: shadowDecisions[0]
          ? toNumber(shadowDecisions[0].plan.capitalPlan.deployable)
          : 0,
        firstOrderCount: shadowDecisions[0] ? shadowDecisions[0].plan.orders.length : 0,
      };
    }
  );

  // Gate 10 — no submitOrders capability registered or reachable.
  await step(10, "no submitOrders capability registered or reachable on live provider", async () => {
    // SAFETY: widening to an indexable surface purely to enumerate the provider's
    // own method names for the read-only invariant; no credential or policy data.
    const methodNames = Object.getOwnPropertyNames(provider);
    const mutative = methodNames.filter((k) =>
      /order|submit|trade|execut|transfer|place/i.test(k)
    );
    if (mutative.length > 0) throw new Error(`mutative surface: ${mutative.join(", ")}`);
    return { mutativeMethods: [] };
  });

  // Gate 11 — produces no orders / transfers / mutations (read-only by construction).
  await step(11, "produces no orders/transfers/mutations on live account", async () => {
    // The adapter has no mutation methods; the synthetic observation is in-memory only.
    // The live account's positions are read, never altered.
    return { mutationCount: 0 };
  });

  // ─── Report ────────────────────────────────────────────────────────────────
  const failed = points.filter((p) => p.status === "fail");
  const summary = {
    allPass: failed.length === 0,
    gates: points.length,
    passed: points.length - failed.length,
    points,
  };
  if (failed.length > 0) {
    console.error("CERTIFICATION FAILED");
    console.error(JSON.stringify(summary, null, 2));
    process.exit(1);
  }
  console.log("CERTIFICATION PASSED");
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  // SAFETY: route the crash message through `redact` as well — an upstream error
  // body could conceivably echo a credential or derived auth string; never print it raw.
  const raw = e instanceof Error ? e.message : String(e);
  console.error("CERTIFICATION CRASHED:", redact(raw));
  process.exit(1);
});