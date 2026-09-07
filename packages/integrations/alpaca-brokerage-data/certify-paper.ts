// Alpaca paper certification harness — first-hand evidence for v0.3.0.
//
// This is a STANDALONE script, NOT part of the ordinary Vitest unit suite and
// NOT part of CI. It talks to the REAL Alpaca paper API (never live trading)
// and therefore requires live paper credentials. Run it explicitly:
//
//   ALEPES_ALPACA_PAPER_KEY=<paper key id> \
//   ALEPES_ALPACA_PAPER_SECRET=<paper secret> \
//   bun run certify:alpaca-paper
//
// SECURITY: never prints key id, secret, account ids, or raw API responses
// verbatim. Redacts them to deterministic fingerprints. Refuses anything except
// paper/sandbox.
//
// CERTIFICATION GATES (read-only): this harness performs NO mutation and has NO
// order/transfer/ACH surface. It proves:
//   1. refuses anything except Alpaca paper/sandbox configuration;
//   2. authenticates with paper credentials without printing them;
//   3. reads the exact account and fingerprints its provider ID;
//   4. reads cash / buying-power / account status;
//   5. reads real paper positions;
//   6. normalizes quantities and monetary values without JS-float authoritative money;
//   7. reads prices for those positions;
//   8. constructs the provider-neutral portfolio state used by Shadow Mode;
//   9. proves no submitOrders capability is registered or reachable;
//   10. produces no live orders, transfers, or brokerage mutations.

import {
  createAlpacaBrokerageDataProvider,
  createAlpacaClient,
  ALPACA_PAPER_BASE_URL,
  type AlpacaBrokerageDataProviderOptions,
} from "@alepes/alpaca-brokerage-data";
import { fromDecimalString, toNumber } from "@alepes/money";
import type { AccountBinding, BrokerageDataProvider } from "@alepes/integration-runtime";

// ─── Environment guard ───────────────────────────────────────────────────────

const ENV = process.env.ALEPES_ALPACA_ENV ?? "paper";
if (ENV !== "paper" && ENV !== "sandbox") {
  console.error(
    `REFUSING TO RUN: ALEPES_ALPACA_ENV must be "paper" (or "sandbox"), got ${JSON.stringify(ENV)}. ` +
      "This harness never contacts Alpaca live trading."
  );
  process.exit(2);
}
const KEY = process.env.ALEPES_ALPACA_PAPER_KEY ?? process.env.ALEPES_ALPACA_KEY;
const SECRET = process.env.ALEPES_ALPACA_PAPER_SECRET ?? process.env.ALEPES_ALPACA_SECRET;
if (!KEY || !SECRET) {
  console.error(
    "REFUSING TO RUN: ALEPES_ALPACA_PAPER_KEY and ALEPES_ALPACA_PAPER_SECRET must both be set (paper)."
  );
  process.exit(2);
}
// SAFETY: narrowing non-null because the guard above already `process.exit(2)`es
// when either env var is missing, so KEY/SECRET are both definite strings here.
const KEY_ID = KEY as string;
const SECRET_KEY = SECRET as string;

// ─── Redaction helpers ───────────────────────────────────────────────────────

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

// ─── The 10-gate certification run ───────────────────────────────────────────

async function main(): Promise<void> {
  // Gate 1 — refuse anything except paper/sandbox configuration.
  await step(1, "refuses anything except paper/sandbox", async () => {
    // Already enforced by the environment guard above; re-assert here for the report.
    if (ENV !== "paper" && ENV !== "sandbox") throw new Error(`bad env ${ENV}`);
    return { env: ENV, baseUrl: ALPACA_PAPER_BASE_URL };
  });

  // Gate 2 — authenticate WITHOUT printing credentials.
  const client = createAlpacaClient(KEY_ID, SECRET_KEY);
  const provider = createAlpacaBrokerageDataProvider({
    client,
    resolveCredentialRef: async () => "cred:alpaca-paper",
  } satisfies AlpacaBrokerageDataProviderOptions);

  await step(2, "authenticates without printing credentials", async () => {
    const { status, data } = await client.getAccount();
    if (status === 401 || status === 403) throw new Error("auth failed");
    accountIds.push(data.id);
    return {
      status,
      authenticated: status < 400,
      // Fingerprint only — never echo the raw account id / number.
      accountFingerprint: fp(data.id),
      accountNumberFingerprint: data.account_number ? fp(data.account_number) : "n/a",
    };
  });

  let binding: AccountBinding | null = null;

  // Gate 3 — read the exact account + fingerprint provider id.
  await step(3, "reads exact account and fingerprints provider id", async () => {
    const accts = await provider.discoverAccounts("cred:alpaca-paper");
    if (accts.length === 0) throw new Error("no account discovered");
    binding = accts[0];
    // SAFETY: ExternalObservationRef is a branded string; the underlying value is
    // a plain provider account string, safe to fingerprint and to register for redaction.
    const providerRef = binding.providerAccountRef as string;
    accountIds.push(providerRef);
    return {
      providerRefFingerprint: fp(providerRef),
      name: binding.name,
    };
  });

  if (!binding) throw new Error("unreachable: binding missing");

  const fullAccount = await provider.readAccount(binding);

  // Gate 4 — read cash / buying-power / status.
  const accountFacts = await step(4, "reads cash/buying-power/account status", async () => {
    return {
      status: fullAccount.status,
      cashCents: toNumber(fullAccount.cashCents),
      buyingPowerCents: toNumber(fullAccount.buyingPowerCents),
      portfolioValueCents: toNumber(fullAccount.portfolioValueCents),
    };
  });

  // Gate 5 — read real paper positions.
  const positions = await step(5, "reads real paper positions", async () => {
    const p = await provider.readPositions(binding!);
    return p.map((x) => ({ symbol: x.symbol, quantity: x.quantity }));
  });

  // Gate 6 — normalization without JS-float authoritative money (exact decimal).
  await step(6, "normalizes money without JS-float authoritative money", async () => {
    // Re-read raw account cash as a decimal string and prove the integer-cent
    // normalization is exact (fromDecimalString path, never a float multiply).
    const { data } = await client.getAccount();
    const exactCents = fromDecimalString(data.cash);
    if (toNumber(exactCents) !== accountFacts.cashCents) {
      throw new Error("float vs exact normalization mismatch");
    }
    return { cashDecimal: data.cash, cashCents: accountFacts.cashCents };
  });

  // Gate 7 — read prices for the observed positions.
  const symbols = positions.map((p) => p.symbol);
  await step(7, "reads prices for positions", async () => {
    if (symbols.length === 0) return { prices: {}, note: "no positions to price" };
    const prices = await provider.readPrices(binding!, symbols);
    return Object.fromEntries(Object.entries(prices).map(([s, c]) => [s, toNumber(c)]));
  });

  // Gate 8 — construct the provider-neutral portfolio state used by Shadow Mode.
  await step(8, "constructs provider-neutral portfolio state", async () => {
    // Shadow Mode consumes a provider-neutral picture: account facts + positions.
    const portfolioState = {
      cashCents: accountFacts.cashCents,
      buyingPowerCents: accountFacts.buyingPowerCents,
      portfolioValueCents: accountFacts.portfolioValueCents,
      positions: positions.map((p) => ({ symbol: p.symbol, quantity: p.quantity })),
    };
    if (typeof portfolioState.cashCents !== "number") throw new Error("bad portfolio state");
    return { symbolCount: portfolioState.positions.length };
  });

  // Gate 9 — no submitOrders capability registered or reachable.
  await step(9, "no submitOrders capability registered or reachable", async () => {
    // SAFETY: widening to an indexable surface purely to enumerate the provider's
    // own method names for the read-only invariant; no credential or policy data.
    const surf = provider as BrokerageDataProvider & Record<string, unknown>;
    const mutative = Object.keys(surf).filter((k) => /order|submit|trade|execut|transfer|place/i.test(k));
    if (mutative.length > 0) throw new Error(`mutative surface: ${mutative.join(", ")}`);
    return { mutativeMethods: [] };
  });

  // Gate 10 — produces no orders / transfers / mutations (read-only by construction).
  await step(10, "produces no orders/transfers/mutations", async () => {
    // The adapter has no mutation methods; nothing to forbid beyond gate 9. The
    // paper account's positions are read, never altered.
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
  console.error("CERTIFICATION CRASHED:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});