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
| `@alepes/persistence` | PostgreSQL persistence (plan + orders + append-only audit + transactional outbox). |
| `@alepes/temporal-workflows` | Temporal orchestration layer (ExecutionPlanWorkflow + OutboxPublisherWorkflow). |
| `@alepes/analytics` | Read-only analytics (DuckDB native API, confined by lint rule; never moves money). |

## Boundary discipline

- **The domain owns all policy.** Integrations expose *capabilities*; they never
  decide anything.
- **Money is integer cents** in the packages. Floats may enter only via
  `centsFromDollarsFloat` at a provider boundary, and are rounded once.
- **Exactly one decision engine.** The legacy UI modules under `src/lib/domain/`
  (`allocation.ts`, `rules.ts`, `simulation.ts`) are now *compatibility facades*:
  they marshal the React UI's dollar DTOs ↔ integer cents and delegate every
  decision to `@alepes/*`. `marshal.ts` is pure data conversion. The UI types in
  `types.ts` are display-only DTOs. This means Shadow Mode, simulations, UI
  previews, tests, and eventual live execution all route through the same engine.

## Tests

```bash
# from the repo root — Bun is the validation interface
bun test
bun run build
bunx tsc --noEmit
bunx oxlint
```

The functional suite covers: allocations never exceed deployable; exact
reconciliation after rounding; no negative allocation; overweight holdings
starved until underweight alternatives are exhausted; band boundaries; $0 and
degenerate inputs fail deterministically; byte-identical re-runs; a deposit can
never be invested twice; and shadow-vs-live sharing one planning path.

Additional suites:
- `packages/allocation-engine/src/adversarial.test.ts` — missing/zero prices,
  delisted symbols, unallocated-total targets, duplicate holdings, min-trade >
  deployable, overflow/extremes, duplicate events, idempotency.
- `packages/allocation-engine/src/property.test.ts` — fast-check properties:
  every amount ≥ 0, sum ≤ deployable, sum === deployable when fully allocatable.
- `packages/integration-conformance/src/conformance.ts` — reusable certification
  harness; certify any bank/brokerage plugin against its capability contract.

## Runtime boundary

Alepes has exactly one platform/toolchain and one narrow runtime island:

- **Bun 1.4** (pinned via `packageManager`) is the Alepes platform: dependency
  installation, scripts/tooling, the Next.js web/API, DuckDB analytics, Oxlint,
  and ordinary tests.
- **Node 24** (pinned via `.node-version`) is a narrow runtime dependency
  required **only** by the Temporal Worker and the Temporal workflow-isolate
  test suite. Temporal executes workflow code in a V8 isolate that depends on
  `promiseHooks`, which Bun does not implement.

This is **not** a second package-management ecosystem: there is no `npm` or
`pnpm` path. Dependencies are installed with Bun; the Temporal suite is invoked
through Node directly from the same Bun-installed dependency tree.

Temporal SDK safety: `@temporalio/*` is pinned to `1.20.1` (the first release
with the `webpack >= 5.108` workflow-context-isolation fix, issue #2170), and the
worker runs with `reuseV8Context: false` — Alepes has not separately
stress-certified V8 context reuse, so it stays off by construction for a
financial system.