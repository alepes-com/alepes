import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

/**
 * Reject nondeterministic or I/O imports from Temporal workflow code.
 * Temporal workflows must be deterministic and replay-safe.
 */
export const noNondeterminismInWorkflowRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Temporal workflow files must not import I/O or nondeterministic APIs (Date.now, Math.random, pg, duckdb, fetch, provider SDKs).",
    },
    messages: {
      nondeterministicImport:
        "Workflow code must not import '{{ imp }}'. Temporal code must be deterministic and replay-safe.",
      nondeterministicCall:
        "Workflow code must not call '{{ name }}'. Temporal code must be deterministic and replay-safe.",
    },
    schema: [],
  },
  create(context) {
    const fileName = context.getFilename();
    const isWorkflow = fileName.includes("temporal-workflows/src/workflows.ts");
    if (!isWorkflow) return {};

    const forbiddenImports = [
      "pg",
      "duckdb",
      "@duckdb/node-api",
      "@alepes/mock-brokerage",
      "@alepes/mock-bank",
      "node:fs",
      "node:http",
      "node:net",
    ];

    return {
      ImportDeclaration(node: ESTree.ImportDeclaration) {
        const src = node.source.value as string;
        for (const pkg of forbiddenImports) {
          if (src.includes(pkg)) {
            context.report({
              node,
              messageId: "nondeterministicImport",
              data: { imp: src },
            } as any);
          }
        }
      },
      MemberExpression(node: ESTree.MemberExpression) {
        const obj = context.sourceCode.getText(node.object);
        const prop = context.sourceCode.getText(node.property);
        const full = `${obj}.${prop}`;
        const bad = new Set([
          "Date.now",
          "Math.random",
          "crypto.randomUUID",
          "crypto.getRandomValues",
          "fetch",
          "setTimeout",
          "setInterval",
        ]);
        if (bad.has(full)) {
          context.report({
            node,
            messageId: "nondeterministicCall",
            data: { name: full },
          } as any);
        }
      },
      CallExpression(node: ESTree.CallExpression) {
        if (node.callee.type === "Identifier") {
          const name = node.callee.name;
          const bad = new Set(["fetch", "Date", "Math", "setTimeout", "setInterval"]);
          if (bad.has(name)) {
            context.report({
              node,
              messageId: "nondeterministicCall",
              data: { name },
            } as any);
          }
        }
      },
    };
  },
});
