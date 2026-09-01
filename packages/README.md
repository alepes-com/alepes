# Alepes packages

The financial core of Alepes lives here as **pure, dependency-free packages**.
No React, no Next.js, no database, no provider SDK. Money is integer cents
(`@alepes/money`); every decision is deterministic and reproducible.

## Pipeline

```
CashEvent
   ↓  @alepes/rules-engine
RuleEvaluation  →  CapitalPlan   (how much to deploy)
   ↓  @alepes/allocation-engine
AllocationPlan                   (where to deploy — drift correction)
   ↓  @alepes/execution-policy
ExecutionPlan  →  ExecutionPolicy  →  Shadow | Approval | Execute
   ↓  @alepes/integration-runtime (capabilities)
MockBrokerage / (future: real brokerage)
   ↓
AuditRecord[] (reproducible, explains every decision)
```

Shadow Mode and live mode produce the **byte-identical plan**; they differ only
at the `ExecutionPolicy` gate. Contribution-only rebalancing is enforced by
construction (orders are always `buy`, never `sell`).

## Packages

| Package | Responsibility |
| --- | --- |
| `@alepes/money` | Integer-cents `Cents` / `NonNegativeCents` + exact arithmetic. |
| `@alepes/domain` | Pure pipeline types (CashEvent, CapitalPlan, AllocationPlan, ExecutionPlan, …). |
| `@alepes/rules-engine` | CashEvent → RuleEvaluation → CapitalPlan (priority, no double-invest, reserve/deposit/monthly caps). |
| `@alepes/allocation-engine` | CapitalPlan → AllocationPlan (drift correction, bands, min-trade, exact reconciliation). |
| `@alepes/execution-policy` | ExecutionPlan + policy gate (Shadow / Approval / Execute). |
| `@alepes/integration-runtime` | Capability / Plugin / Registry / CredentialProvider / Lifecycle. |
| `@alepes/mock-bank` | Bank plugin: checking balance + deposits. |
| `@alepes/mock-brokerage` | Brokerage plugin: portfolio + prices + order submission (records audit). |

## Boundary discipline

- **The domain owns all policy.** Integrations expose *capabilities*; they never
  decide anything.
- **Money is integer cents** in the packages. Floats may enter only via
  `centsFromDollarsFloat` at a provider boundary, and are rounded once.
- The legacy `src/lib/domain/` + `src/lib/providers/` remain **display-only** for
  the existing mock UI during migration — they make no financial decisions and
  will be retired once the UI is rewired to these packages.

## Tests

```bash
# from the repo root
npx vitest run
```

The invariant suite covers: allocations never exceed deployable; exact
reconciliation after rounding; no negative allocation; overweight holdings
starved until underweight alternatives are exhausted; band boundaries; $0 and
degenerate inputs fail deterministically; byte-identical re-runs; a deposit can
never be invested twice; and shadow-vs-live sharing one planning path.