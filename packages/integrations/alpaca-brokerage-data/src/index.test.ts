import { describe, expect, it } from "vitest";
import type { ExternalObservationRef } from "@alepes/domain";
import { toNumber } from "@alepes/money";
import type { AccountBinding } from "@alepes/integration-runtime";
import {
  ALPACA_NORMALIZATION_VERSION,
  createAlpacaBrokerageDataProvider,
  type AlpacaBrokerageDataProviderOptions,
} from "./index";
import { alpacaAccount, alpacaPosition, makeStaticAlpacaClient } from "./fixtures";

function makeProvider(overrides?: Partial<AlpacaBrokerageDataProviderOptions>) {
  const resolveCredentialRef = async (_k: string, _s: string) => "cred:paper";
  const client = makeStaticAlpacaClient();
  return createAlpacaBrokerageDataProvider({ client, resolveCredentialRef, ...overrides });
}

const binding: AccountBinding = {
  id: "binding-paper-acct-123",
  providerAccountRef: "PA1234567890" as ExternalObservationRef,
  credentialRef: "cred:paper",
  name: "Alpaca PA1234567890",
  metadata: { subtype: "brokerage", environment: "paper" },
};

describe("AlpacaBrokerageDataProvider", () => {
  it("discovers the paper account without exposing credentials", async () => {
    const p = makeProvider();
    const accts = await p.discoverAccounts("cred:paper");
    expect(accts).toHaveLength(1);
    expect(accts[0].providerAccountRef).toBe("PA1234567890");
    // Opaque credentialRef is a legitimate contract field; RAW key material
    // (the keyId/secret the adapter resolved) must never leak into the binding.
    expect(JSON.stringify(accts)).not.toMatch(/secret|password|api.?key|bearer|basic /i);
  });

  it("normalizes account facts to integer cents (exact decimal, no float drift)", async () => {
    const p = makeProvider();
    const acct = await p.readAccount(binding);
    expect(toNumber(acct.cashCents)).toBe(2481216);
    expect(toNumber(acct.buyingPowerCents)).toBe(4962432);
    expect(toNumber(acct.portfolioValueCents)).toBe(10000000);
    expect(acct.status).toBe("active");
    expect(acct.normalizationVersion).toBe(ALPACA_NORMALIZATION_VERSION);
  });

  it("normalizes positions to exact quantities and integer cents", async () => {
    const p = makeProvider();
    const positions = await p.readPositions(binding);
    expect(positions).toHaveLength(1);
    expect(positions[0].symbol).toBe("AAPL");
    expect(positions[0].quantity).toBe("10.500000");
    expect(toNumber(positions[0].marketValueCents)).toBe(189210);
    expect(toNumber(positions[0].averageEntryPriceCents)).toBe(17523);
  });

  it("status mapping: non-ACTIVE is restricted/closed", async () => {
    const client = makeStaticAlpacaClient({ account: alpacaAccount({ status: "CLOSED" }) });
    const resolveCredentialRef = async () => "cred:paper";
    const p = createAlpacaBrokerageDataProvider({ client, resolveCredentialRef });
    const acct = await p.readAccount(binding);
    expect(acct.status).toBe("closed");
  });

  it("returns prices in cents for requested symbols", async () => {
    const p = makeProvider();
    const prices = await p.readPrices(binding, ["AAPL"]);
    expect(toNumber(prices.AAPL)).toBe(18025);
  });

  it("rejects negative account cash (invalid provider data)", async () => {
    const client = makeStaticAlpacaClient({ account: alpacaAccount({ cash: "-1.00" }) });
    const resolveCredentialRef = async () => "cred:paper";
    const p = createAlpacaBrokerageDataProvider({ client, resolveCredentialRef });
    await expect(p.readAccount(binding)).rejects.toThrow(/negative/i);
  });

  it("exposes NO order-submission surface (read-only invariant)", async () => {
    const p = makeProvider();
    // The contract has exactly these four methods and nothing mutative.
    expect(Object.keys(p).sort()).toEqual(
      ["discoverAccounts", "info", "readAccount", "readPositions", "readPrices"].sort()
    );
    expect((p as never as { submitOrders?: unknown }).submitOrders).toBeUndefined();
  });

  it("live environment: distinct provider id + live metadata, still read-only", async () => {
    const client = makeStaticAlpacaClient();
    const resolveCredentialRef = async () => "cred:live";
    const p = createAlpacaBrokerageDataProvider({
      client,
      resolveCredentialRef,
      environment: "live",
    });
    expect(p.info.id).toBe("alpaca-brokerage-data-live");
    const accts = await p.discoverAccounts("cred:live");
    expect(accts[0].metadata.environment).toBe("live");
    // The live provider is read-only too — no mutative surface.
    expect((p as never as { submitOrders?: unknown }).submitOrders).toBeUndefined();
  });
});