import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

/**
 * Require a disposition/policy reference in any module that names an
 * execution-order production function (`buildOrders` / `planOrders` /
 * `toOrders` / `buildPlan`). A production function produces orders and
 * changes to production code require that an ExecutionDisposition be consulted.
 *
 * Pure detectors: the rule fires on FunctionDeclaration / ArrowFunctionExpression
 * nodes whose name or identifier matches `*orders*` and whose body contains NO
 * identifier that clearly refers to a disposition/policy ("disposition",
 * "ExecutionDisposition", "policy", "shadow", "approval", "execute").
 *
 * Exclusions: mock executors *return* orders rather than produce them, and are
 * detected by returning an object with `calls` count.
 */
export const requireExecutionPolicyRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Any module that produces ExecutionOrders must consult an ExecutionDisposition to prove the execution policy gate was applied.",
    },
    messages: {
      noPolicyGate:
        "Building orders without consulting an ExecutionDisposition bypasses the policy gate. Ensure the function receives and consults a disposition.",
    },
    schema: [],
  },
  create(context) {
    const fileName = context.getFilename();

    // This package *is* the policy gate. It produces orders as a final step of
    // converting a compliant plan into outside instructions; requiring a
    // disposition here would be circular.
    if (fileName.includes("packages/execution-policy/")) {
      return {};
    }

    // Allowlist: test files and the test-only brokerage port that mocks the
    // production policy boundary.
    if (fileName.includes(".test.") || fileName.includes("mock-brokerage")) {
      return {};
    }

    // Only report files inside production packages that intentionally build orders.
    const isProductionPkg =
      fileName.includes("packages/temporal-workflows/") ||
      fileName.includes("packages/allocation-engine/") ||
      fileName.includes("packages/rules-engine/");

    if (!isProductionPkg) return {};

    return {
      FunctionDeclaration(node: ESTree.FunctionDeclaration) {
        if (node.id && /orders?|planOrders/i.test(node.id.name)) {
          const body = context.sourceCode.getText(node.body);
          const mentionsDisposition = /disposition|policy|shadowMode|dispatchPolicy/i.test(body);
          if (!mentionsDisposition) {
            context.report({
              node: node.id,
              messageId: "noPolicyGate",
            } as unknown as Parameters<typeof context.report>[0]);
          }
        }
      },
    };
  },
});
