import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

/**
 * Reject provider-specific branching in financial policy domains.
 * The policy packages must be provider-neutral: no `=== 'schwab'` style checks.
 */
export const noProviderIdInFinancialPolicyRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Financial policy must be provider-neutral; provider IDs are not allowed in policy decisions.",
    },
    messages: {
      noProviderInPolicy:
        "Provider-specific branching detected in policy code. Policies must use capability contracts, never provider names.",
    },
    schema: [],
  },
  create(context) {
    const policyPackages = [
      "packages/rules-engine/",
      "packages/allocation-engine/",
      "packages/execution-policy/",
    ];
    const fileName = context.getFilename();
    const inPolicy = policyPackages.some((p) => fileName.includes(p));
    if (!inPolicy) return {};

    return {
      BinaryExpression(node: ESTree.BinaryExpression) {
        if (node.operator === "===" || node.operator === "!==") {
          const checkString = (n: ESTree.Node): boolean => {
            if (n.type === "Literal" && typeof n.value === "string") {
              const s = n.value.toLowerCase();
              return ["schwab", "plaid", "robinhood", "vanguard", "fidelity", "etrade", "ally"].some((p) => s.includes(p));
            }
            return false;
          };
          if (checkString(node.left) || checkString(node.right)) {
            context.report({ node, messageId: "noProviderInPolicy" } as any);
          }
        }
      },
      ConditionalExpression(node: ESTree.ConditionalExpression) {
        const checkString = (n: ESTree.Node | null): boolean => {
          if (!n) return false;
          if (n.type === "Literal" && typeof n.value === "string") {
            const s = n.value.toLowerCase();
            return ["schwab", "plaid", "robinhood", "vanguard", "fidelity", "etrade", "ally"].includes(s);
          }
          return false;
        };
        if (checkString(node.test) || checkString(node.consequent) || checkString(node.alternate)) {
          context.report({ node, messageId: "noProviderInPolicy" } as any);
        }
      },
    };
  },
});
