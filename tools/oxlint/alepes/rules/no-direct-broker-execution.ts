import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

/**
 * No-direct-broker-execution: only the Temporal activity layer
 * (activities/ + packages/temporal-workflows/) and the bridge
 * (integration-runtime/integrations/) may invoke brokerage orders.
 * Anything that looks like an order.submit call elsewhere is rejected.
 */
export const noDirectBrokerExecutionRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Brokerage order execution may only be invoked from the Temporal activity layer or integration runtime, never from domain/frontend code.",
    },
    messages: {
      directBroker: "Brokerage order execution from non-adapter code is forbidden. Use the Temporal activity layer or integration runtime.",
    },
    schema: [],
  },
  create(context) {
    const fileName = context.getFilename();
    const isAllowed =
      fileName.includes("packages/temporal-workflows/") ||
      fileName.includes("packages/integration-runtime/") ||
      fileName.includes("packages/integrations/") ||
      fileName.includes("src/lib/providers/");
    if (isAllowed) return {};

    const forbiddenPatterns = [
      /\.placeOrders\(/, /\.submit\(/, /broker\.orders\./,
      /brokerageClient\.execute/, /createMarketBuy/, /createOrder/,
    ];

    return {
      CallExpression(node: ESTree.CallExpression) {
        const src = context.sourceCode.getText(node);
        for (const pattern of forbiddenPatterns) {
          if (pattern.test(src)) {
            context.report({ node, messageId: "directBroker" } as any);
            return;
          }
        }
      },
    };
  },
});
