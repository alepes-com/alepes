import { describe, expect, it } from "vitest";
import { certifyBrokerageDataProvider } from "./conformance";
import { createAlpacaBrokerageDataProvider, makeStaticAlpacaClient } from "@alepes/alpaca-brokerage-data";

function makeProvider() {
  return createAlpacaBrokerageDataProvider({
    client: makeStaticAlpacaClient(),
    resolveCredentialRef: async () => "cred:paper",
  });
}

describe("brokerage-data conformance (Alpaca read-only)", () => {
  it("certifies the Alpaca read-only adapter against the contract", async () => {
    const report = await certifyBrokerageDataProvider(makeProvider());
    expect(report.failures).toEqual([]);
    expect(report.pass).toBe(true);
  });
});