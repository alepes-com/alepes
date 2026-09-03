import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

/**
 * Reject provider or infrastructure SDK imports from pure domain packages.
 * The following packages must never import from provider/infrastructure:
 *   - money, domain, rules-engine, allocation-engine, execution-policy
 * Forbidden: pg, duckdb, @duckdb/node-api, temporalio, plaid, schwab, etc.
 */
export const noProviderCallFromDomainRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Pure domain packages must not import provider SDKs, databases, or infrastructure.",
    },
    messages: {
      noProviderInDomain:
        "Domain package '{{ pkg }}' must not import from provider/infrastructure '{{ imp }}'. Domain packages are pure.",
    },
    schema: [],
  },
  create(context) {
    const purePackages = [
      "packages/money/",
      "packages/domain/",
      "packages/rules-engine/",
      "packages/allocation-engine/",
      "packages/execution-policy/",
    ];
    const fileName = context.getFilename();
    const inDomain = purePackages.some((p) => fileName.includes(p));
    if (!inDomain) return {};

    const forbidden = [
      "pg",
      "duckdb",
      "@duckdb/node-api",
      "temporalio",
      "plaid",
      "schwab",
      "stripe",
      "node:",
    ];

    return {
      ImportDeclaration(node: ESTree.ImportDeclaration) {
        const src = node.source.value as string;
        for (const pkg of forbidden) {
          if (src.includes(pkg)) {
            context.report({
              node,
              messageId: "noProviderInDomain",
              data: { pkg: fileName, imp: src },
            } as any);
          }
        }
      },
    };
  },
});
