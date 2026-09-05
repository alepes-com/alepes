import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

/**
 * no-plaid-outside-adapter: only the Plaid integration package may import the
 * `plaid` SDK. This confines the provider SDK (which processes financial-data
 * API requests and authentication credentials) to exactly one package, so no
 * Plaid type, ID, webhook shape, or sign convention can leak into the domain,
 * rules, allocation, execution, or financial-policy packages.
 */
export const noPlaidOutsideAdapterRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "The Plaid SDK may only be imported from the Plaid integration adapter package; consumer code must depend on the provider-neutral FinancialDataProvider contract.",
    },
    messages: {
      plaidOutsideAdapter:
        "The Plaid SDK '{{ imp }}' may only be imported from packages/integrations/plaid-financial-data/. Use the provider-neutral FinancialDataProvider contract instead.",
    },
    schema: [],
  },
  create(context) {
    const fileName = context.getFilename();
    const isPlaidAdapter = fileName.includes("packages/integrations/plaid-financial-data/");
    if (isPlaidAdapter) return {};

    const plaidImports = ["plaid"];

    return {
      ImportDeclaration(node: ESTree.ImportDeclaration) {
        const src = node.source.value as string;
        for (const imp of plaidImports) {
          if (src === imp || src.startsWith(imp + "/")) {
            context.report({
              node,
              messageId: "plaidOutsideAdapter",
              data: { imp: src },
            } as any);
            return;
          }
        }
      },
    };
  },
});