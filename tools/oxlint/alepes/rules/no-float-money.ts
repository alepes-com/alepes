import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

/**
 * Reject float-based money arithmetic outside the marshal boundary.
 * Money must be integer cents (Cents / NonNegativeCents). Floats are only
 * acceptable at the DTO/display boundary in src/lib/domain/marshal.ts.
 */
export const noFloatMoneyRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Reject float-based money arithmetic. Use Cents / NonNegativeCents from @alepes/money instead.",
    },
    messages: {
      floatMoney:
        "Float money: use Cents / NonNegativeCents integer math instead of arrow IIFE with float literals.",
    },
    schema: [],
  },
  create(context) {
    const allowedFiles = [
      "src/lib/domain/marshal.ts",
      "src/lib/format.ts",
      "packages/money/src/index.ts",
    ];

    if (allowedFiles.some((p) => context.getFilename().includes(p))) {
      return {};
    }

    function isFloatLiteral(node: ESTree.Node): boolean {
      if (
        node.type === "Literal" &&
        typeof node.value === "number" &&
        !Number.isInteger(node.value)
      ) {
        return true;
      }
      if (
        node.type === "UnaryExpression" &&
        node.operator === "-" &&
        node.argument.type === "Literal" &&
        typeof node.argument.value === "number" &&
        !Number.isInteger(node.argument.value)
      ) {
        return true;
      }
      return false;
    }

    function isMoneyNode(node: ESTree.Node): boolean {
      if (node.type === "Identifier" && ["money", "amount", "balance", "cents", "total", "price", "value"].includes(node.name)) {
        return true;
      }
      if (
        node.type === "CallExpression" &&
        node.callee.type === "Identifier" &&
        node.callee.name === "cents"
      ) {
        return true;
      }
      return false;
    }

    function check(node: ESTree.BinaryExpression | ESTree.ArrowFunctionExpression) {
      if (node.type === "ArrowFunctionExpression" && node.body.type === "BinaryExpression") {
        // IIFE like () => 24.99 * 4
        if (isFloatLiteral(node.body.left) || isFloatLiteral(node.body.right)) {
          context.report({
            node: node.body,
            messageId: "floatMoney",
          } as any);
        }
      }
      if (node.type === "BinaryExpression") {
        if (isFloatLiteral(node.left) || isFloatLiteral(node.right)) {
          const suspicious =
            isMoneyNode(node.left as ESTree.Node) ||
            isMoneyNode(node.right as ESTree.Node);
          if (suspicious) {
            context.report({ node, messageId: "floatMoney" } as any);
          }
        }
      }
    }

    return {
      BinaryExpression: check,
      ArrowFunctionExpression: check,
    };
  },
});
