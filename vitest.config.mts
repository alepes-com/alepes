import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Workspace packages resolve to their TypeScript source directly (no build step
// in this monorepo), so map each @alepes/* package name to its src/index.ts.
const packages = [
  "money",
  "domain",
  "allocation-engine",
  "rules-engine",
  "execution-policy",
  "integration-runtime",
  "persistence",
  "temporal-workflows",
];
const alias: Record<string, string> = {
  "@": path.resolve(dirname, "./src"),
};
for (const p of packages) {
  alias[`@alepes/${p}`] = path.resolve(dirname, `./packages/${p}/src/index.ts`);
}
// Integrations live under packages/integrations/.
alias["@alepes/mock-bank"] = path.resolve(
  dirname,
  "./packages/integrations/mock-bank/src/index.ts"
);
alias["@alepes/mock-brokerage"] = path.resolve(
  dirname,
  "./packages/integrations/mock-brokerage/src/index.ts"
);

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}", "packages/**/*.test.{ts,tsx}"],
    globals: true,
  },
  resolve: {
    alias,
  },
});