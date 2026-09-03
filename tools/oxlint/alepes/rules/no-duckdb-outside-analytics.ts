import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

/**
 * no-duckdb-outside-analytics: only the analytics package may import DuckDB
 * packages. This confines the native-addon boundary to exactly one package,
 * so switching backends later (DuckDB CLI subprocess, Wasm, Postgres views)
 * requires no import from anywhere else in the codebase.
 */
export const noDuckdbOutsideAnalyticsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "DuckDB packages may only be imported from the analytics package; consumer code must depend on the provider-neutral AnalyticsEngine interface.",
    },
    messages: {
      duckdbOutsideAnalytics:
        "DuckDB package '{{ imp }}' may only be imported from packages/analytics/. Use the provider-neutral analytics interface instead.",
    },
    schema: [],
  },
  create(context) {
    const fileName = context.getFilename();
    const isAnalytics = fileName.includes("packages/analytics/");
    // The certification/tooling scripts under test/ also touch DuckDB directly.
    const isTest = fileName.includes("/test/") || /\.(test|spec)\.tsx?$/.test(fileName);
    if (isAnalytics || isTest) return {};

    const duckdbImports = ["@duckdb/node-api", "@duckdb/node-bindings", "duckdb"];

    return {
      ImportDeclaration(node: ESTree.ImportDeclaration) {
        const src = node.source.value as string;
        for (const imp of duckdbImports) {
          if (src === imp || src.startsWith(imp + "/")) {
            context.report({
              node,
              messageId: "duckdbOutsideAnalytics",
              data: { imp: src },
            } as any);
            return;
          }
        }
      },
    };
  },
});