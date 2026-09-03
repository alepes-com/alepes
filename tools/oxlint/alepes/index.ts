import { eslintCompatPlugin } from "@oxlint/plugins";

import { noFloatMoneyRule } from "./rules/no-float-money.ts";
import { noProviderCallFromDomainRule } from "./rules/no-provider-call-from-domain.ts";
import { noProviderIdInFinancialPolicyRule } from "./rules/no-provider-id-in-financial-policy.ts";
import { noDirectBrokerExecutionRule } from "./rules/no-direct-broker-execution.ts";
import { requireExecutionPolicyRule } from "./rules/require-execution-policy.ts";
import { noNondeterminismInWorkflowRule } from "./rules/no-nondeterminism-in-workflow.ts";
import { noDuckdbOutsideAnalyticsRule } from "./rules/no-duckdb-outside-analytics.ts";

/** Alepes-specific rules that enforce financial-domain boundaries. */
const alepesPlugin = eslintCompatPlugin({
  meta: { name: "alepes" },
  rules: {
    "no-float-money": noFloatMoneyRule,
    "no-provider-call-from-domain": noProviderCallFromDomainRule,
    "no-provider-id-in-financial-policy": noProviderIdInFinancialPolicyRule,
    "no-direct-broker-execution": noDirectBrokerExecutionRule,
    "require-execution-policy": requireExecutionPolicyRule,
    "no-nondeterminism-in-workflow": noNondeterminismInWorkflowRule,
    "no-duckdb-outside-analytics": noDuckdbOutsideAnalyticsRule,
  },
});

export default alepesPlugin;
