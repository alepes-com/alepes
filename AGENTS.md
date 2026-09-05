# Alepes — repository operating contract

This is the authoritative contract for modifying this repository. A coding agent
must read this file before changing anything, and must be able to justify every
step against it.

## What Alepes is responsible for

Alepes turns incoming cash into a contribution that moves a portfolio back toward
its target allocation. It is **not** a stock picker, a robo-adviser, or a trading
bot. The user decides the investment universe, the target percentages, and the
automation rules; Alepes's one job is to apply those rules to cash flow
deterministically and to record, in an auditable way, exactly why any money did
(or did not) move.

**Decision filter — the correctness property that wins every conflict:**

> A contribution, once planned, is **reproducible, explainable, and never moves
> more money than the user's rules allow.** When a product decision conflicts
> with that property — a prettier view, a faster path, a simpler model — the
> property wins.

Three consequences, applied unless explicitly overridden by the user:

1. **The financial core is the canonical authority.** The pipeline in `packages/`
   owns every decision. The UI is a projection of it, never an alternative engine.
2. **Money is integer cents.** Amounts that represent value are `Cents` /
   `NonNegativeCents` (`packages/money`). Binary floating-point never participates
   in a financial decision. Dollar floats exist only at the UI DTO boundary.
3. **Simulation and execution share one plan.** Shadow Mode, UI previews, tests,
   and eventual real execution all run through the same pipeline; the only
   difference is the disposition at the execution gate.

Preserve these unless a task explicitly and deliberately changes them.

---

## Where knowledge lives (read before changing X)

Do not duplicate documentation into this file. Use this index to find the right
source before modifying a feature.

| To change… | Read first |
| --- | --- |
| Financial domain models, pipeline stages, audit shapes | `packages/domain/src/index.ts` (the type definition of record) |
| Integer-cents math and rounding | `packages/money/src/index.ts` |
| Rule → capital amount (triggers, reserve, per-deposit/monthly caps) | `packages/rules-engine/src/index.ts` (+ its tests) |
| Capital → allocation (drift correction, bands, min-trade) | `packages/allocation-engine/src/index.ts` (+ `adversarial.test.ts`, `property.test.ts`) |
| Execution gate (shadow / approval / execute) | `packages/execution-policy/src/index.ts` |
| Provider capability/plugin contract | `packages/integration-runtime/src/index.ts` |
| Package boundary rules + pipeline summary | `packages/README.md` |
| Dollars↔cents and DTO↔domain conversion | `src/lib/domain/marshal.ts` |
| UI-facing (display-only) types | `src/lib/domain/types.ts` |
| Product concept, vocabulary, roadmap | `IDEA.md` |
| Public/README surface, setup, tech stack | `README.md` |
| Whole-repo agent contract | this file (`AGENTS.md`; `CLAUDE.md` delegates here) |

There is no `docs/` tree; the files above are the documentation of record.

---

## Architecture and ownership

The repo is a single Next.js application (`src/`) plus a pure TypeScript domain
(`packages/`). There is no separate backend, database, or service at this stage.

**Layers (inner to outer), with their owners:**

| Layer | Lives in | Owns | Depends on |
| --- | --- | --- | --- |
| Money + arithmetic | `packages/money` | `Cents`, `NonNegativeCents`, exact integer math, rounding | nothing |
| Domain types | `packages/domain` | pipeline types (`CashEvent`…`LedgerEntry`) | `money` |
| Engines | `packages/rules-engine`, `packages/allocation-engine`, `packages/execution-policy` | decision logic | `money`, `domain` |
| Integration runtime | `packages/integration-runtime` | capability/plugin/registry contracts | `domain`, `money` |
| Mock integrations | `packages/integrations/mock-bank`, `mock-brokerage` | fake providers | `integration-runtime`, `domain`, `money` |
| Conformance | `packages/integration-conformance` | provider certification harness | all of the above |
| UI (Next) | `src/` | pages, components, mock data | packages *only via the facades* |
| Compatibility bridge | `src/lib/domain/marshal.ts` + `allocation.ts`/`rules.ts`/`simulation.ts` | dollars↔cents + DTO↔domain conversion | packages |

**Binding rules:**

- **`packages/*` are pure.** They must not import React, Next.js, or any I/O, and
  must not import from `src/`. A package importing the UI or a provider SDK is a
  broken boundary.
- **Dependency direction is inward.** `money` is a leaf; `domain` may import
  `money`; engines import `money`+`domain`; nothing in `packages` imports a UI
  module. Reversing this is a defect.
- **Exactly one money translator.** `src/lib/domain/marshal.ts` is the only place
  that converts dollars↔cents and DTO↔domain. Do not add a second converter or
  inline the conversion elsewhere.
- **The `src/lib/providers/` directory** (`types.ts`, `mock.ts`) is the legacy
  read-only mock layer, superseded by `packages/integration-runtime` +
  `packages/integrations/`. Do not extend it; prefer the `@alepes/*` path.

**Architecture validation today:** there is no automated architecture check. The
`paths` mapping lives in `tsconfig.json` and `vitest.config.mts` (both must stay
in sync with the package list). If you add or remove a package, update both. If
you add a dependency direction that crosses a boundary, that is a manual review
item — call it out in your handoff rather than silently accepting it.

---

## Data integrity — what is canonical and what may be derived

Alepes deals in financially consequential records. Treat these rules as
invariants:

- **Recorded events are immutable.** A detected deposit, a rule evaluation, an
  allocation, an execution, an audit record — once produced, they are history.
  Do not rewrite a historical record to make current analytics cleaner. Add a
  correction/derived view instead.
- **Separate the recorded event from its derived view.** `CashEvent` is a recording
  of what happened; `CapitalPlan`, `AllocationPlan`, and drift percentages are
  *derived* from it plus configuration. Never fold a derived figure back into the
  recorded event.
- **Reproducibility.** A given `CashEvent` + rule set + portfolio state must yield
  a byte-identical plan on re-run. If a change introduces time, ordering, or
  random variation into the decision path, it is a regression unless the inputs
  carry an explicit timestamp/seed.
- **Simulation is not real value.** There is no real-money settlement in this
  repo. Everything currently executes against `mock-bank` / `mock-brokerage`, and
  Shadow Mode is the default disposition. Do not label a simulated or mocked
  result as a real-money result. (See Proof, below.)
- **The ledger types** (`AuditRecord`, `LedgerEntry`) are the intended form of the
  immutable trail. Persistence is provided by `@alepes/persistence` (PostgreSQL —
  plan + orders + append-only audit + transactional outbox), and orchestration by
  `@alepes/temporal-workflows` (Temporal Worker + workflow isolate).

There are currently **no** markers of this repo implementing: fees, dividends,
stock splits, multi-currency, or historical price series. Do not invent rules for
behaviors that do not exist. If you add one, add its data-integrity rule at the
same time.

---

## Automation and money-movement boundaries

Alepes is an automation product aimed at moving money. Even though it is
mock-only today, the state machine that separates *thinking about* money from
*moving* money is a hard boundary. Distinguish these and never collapse them:

1. **observation** — a provider reports a balance/event (`CashEvent`).
2. **recommendation / planning** — `CapitalPlan`, `AllocationPlan`, `ExecutionPlan`.
3. **simulation** — the plan with a `shadow` disposition (nothing executes).
4. **queued intent** — a plan rated `approval` (held, not executed).
5. **externally executed** — orders handed to a brokerage capability.
6. **confirmed settlement** — the provider reports completion.

Today only 1–3 (and 5 against mocks) are reachable; there is no `approval` queue,
no webhooks, no reconciliation, no settlement confirmation. When real
integrations are added, the following must accompany them — but do **not** add
the code as speculative scaffolding now:

- idempotency keys and duplicate-event suppression,
- retry, partial-failure, and reconciliation semantics,
- transfer limits and authorization scopes,
- sandbox-vs-production routing,
- webhook replay and stale-account handling,
- explicit separation of "order created" vs "settled".

**Test/simulation code must never invoke real money movement.** Mocks and sandbox
are the default for automated tests. There is no path in this repo that touches a
real account; keep it that way until a real provider is deliberately introduced.

---

## Numeric correctness

The financial core uses integer cents precisely because floating point is
unacceptable for money. When touching any calculation:

- **Represent value as `Cents`/`NonNegativeCents`** (`packages/money`). Never
  compute a monetary amount in float dollars.
- **The only float entry point** is `centsFromDollarsFloat` (rounds to nearest
  cent). Floats also appear as *percentages* for drift/display — that is fine;
  percentages are ratios, not amounts.
- **Rounding occurs in exactly one place and method:** `mulByRatio` rounds via
  `Math.round` (deterministic, half toward +∞). `divideIntoParts` distributes a
  cent remainder deterministically to the front slices. Do not introduce a second
  rounding mode.
- **Allocation reconciliation is exact.** `sum(lines) === totalDeployed` must hold
  as integer cents; the engine guarantees it and the property tests assert it.
- **Deterministic ordering.** When a remainder must be distributed across
  holdings, order by the existing deterministic key (already sorted by gap
  descending); never by object identity or insertion order that could change.
- **Guard the edges in tests**, not just in UI behavior: zero price, missing
  price, min-trade larger than deployable, $0 portfolios, duplicate symbols,
  allocations that do not total 100%. These already have coverage in
  `packages/allocation-engine/src/adversarial.test.ts` and `property.test.ts`;
  extend those files rather than scattering ad-hoc assertions through UI tests.

---

## Proof — evidence levels

A claim is only as strong as the evidence that produced it. Use the highest level
you actually reached, and say which one it is. Levels that apply to Alepes today:

1. **Source inspection** — read the code; the weakest claim ("it is written to…").
2. **Unit test** — `vitest` exercises a pure function (`packages/*` tests).
3. **Property test** — `fast-check` asserts an invariant over generated inputs.
4. **Integration test with mock providers** — `integration-conformance` certifies
   a mock plugin against its capability contract.
5. **End-to-end with real providers** — *not currently reachable, and not proven.*

Because only levels 1–4 exist here, hard caps apply:

- A unit test does **not** prove a real bank/brokerage/API worked.
- A mock or sandbox result does **not** prove real settlement.
- `bun run build` passing does **not** prove runtime correctness.
- A UI rendering does **not** prove canonical state is correct.
- A successful `next` HTTP page does **not** prove a financial decision was right.

State the strongest level achieved in every handoff, and call out the level you
could not reach.

---

## Dependencies

Before adding or upgrading any third-party dependency, investigate, at minimum:
license, maintenance activity, runtime/platform support, API stability,
transitive dependencies, whether it processes credentials or financial data, and
its effect on deterministic tests. Prefer a stdlib/native/standard-library option
over a new dependency when one exists. Because the financial core must stay pure,
**do not add any dependency that `packages/` would need to import** unless that
dependency is itself pure and deterministic (e.g. a math library); the core's
zero-dependency property is deliberate.

Do not copy source from an external project until its license has been reviewed.

Note: `shadcn/ui` components here are built on **Base UI** (`@base-ui/react`), not
Radix. Composition uses the `render` prop, not `asChild`. Consult
`src/components/ui/` for the existing patterns before writing new primitives.

---

## Security

Hard rules, no exceptions:

- **Never commit secrets.** No `.env*`, no tokens, no keys, no `.pem`, no
  credentials, ever. `.env*` and `*.pem` are already gitignored; do not `-f`
  around that.
- **Never log credentials** or print tokens/secrets into test or build output.
- **Never disable TLS/certificate verification**, signature/auth checks, or
  CSRF/authz gates "to make tests pass."
- **Never silently change a production endpoint** or point the app at a real
  provider while it is still mocked, except as an explicit, reviewed change.
- **Never use production credentials in automated tests.** There are none in this
  repo today; keep it that way.

Because there are currently no integrations, secrets, or webhooks, the actionable
policy is narrow: keep the repo secret-free, keep the core dependency-free, and do
not introduce an external credential surface without also introducing the rules
that protect it (least privilege, scoped tokens, no secret in logs).

---

## Repository mutation discipline

Read-only investigation needs no bookkeeping. For code changes:

1. Identify the bounded change and locate its owning module (see the layer table).
2. Read the module's current tests before editing.
3. Make the smallest coherent modification that accomplishes the change.
4. Preserve unrelated behavior; do not fold in opportunistic cleanup.
5. Add regression coverage in the *existing* test files for that module.
6. Validate narrowly first (the touched package), then broaden.

Do not restructure the architecture, rename packages, or "tidy" the domain as part
of an unrelated feature or bug fix.

---

## Validation ladder (real commands)

Run these in order; each is a real, working command in this repo. Bun 1.4 is the
validation interface; Oxlint is the primary linter.

```bash
bun run lint         # oxlint (0 errors required)
bunx tsc --noEmit    # typecheck the whole repo (src + packages)
bun run test         # Vitest unit/property/conformance suites (the `test` script)
bun run build        # Next production build (static prerender of all routes)
git diff --check     # whitespace errors
```

> `bun run test` executes the repo's `"test": "vitest run"` script. `bun test` is
> Bun's own built-in runner and is NOT the canonical Alepes test command for the
> Vitest suite.

Persistence and Temporal have integration suites that require a live PostgreSQL
(or the Temporal workflow isolate under Node 24) and run only when their env vars
are set — see the CI workflows (`.github/workflows/`) and the packages README.

---

## Git coordination

- Inspect `git status` before modifying; preserve pre-existing user changes.
- Do not overwrite another agent's or the user's uncommitted work.
- Use logical commits; keep documentation/contracts in sync with implementation
  in the same or adjacent commit.
- Do not force push without explicit approval.
- If a push fails, report it as failed — never claim completion.

**Files prone to parallel modification:** `package.json` (dependency/script
changes), `tsconfig.json` and `vitest.config.mts` (the `@alepes/*` alias lists,
which must stay in sync with each other and with the `packages/` tree),
`src/lib/data/mock.ts` (shared mock data), and this `AGENTS.md`.

---

## Repository and release workflow

### Branching model

`main` is the protected, releasable branch. There is no permanent `dev` branch.

Normal development happens on short-lived branches named by type:

- `feat/<name>` — e.g. `feat/plaid-readonly`, `feat/schwab-readonly`
- `fix/<name>` — e.g. `fix/execution-idempotency`
- `refactor/<name>` — e.g. `refactor/provider-capabilities`
- `chore/<name>` — e.g. `chore/temporal-runtime-cert`

Routine feature and fix work must not be committed directly to `main`. The normal
flow is:

```
issue / milestone
→ short-lived branch
→ implementation
→ local verification
→ commit
→ push branch
→ pull request into main
→ required CI
→ review
→ merge
→ main remains releasable
```

Do not create or maintain a long-lived `dev` branch unless a future
release-management requirement explicitly justifies one.

### Pull requests and merge discipline

After this policy is introduced, stop using `commit → push main` for routine
product work. Use:

```
create branch → commit → push branch → PR → CI → merge
```

- Tags and releases must only point to commits already merged into `main`.
- Never create a release tag from a feature branch.
- Prefer normal fast-forward/PR workflows. Do not force-push shared branches
  unless explicitly authorized.
- Keep commits logically scoped, and push unrelated changes separately.
- Use Conventional Commit-style subjects where practical: `feat:`, `fix:`,
  `refactor:`, `chore:`, `test:`, `docs:`.

### Semantic versioning

Alepes uses Semantic Versioning with a `v`-prefixed Git tag. While pre-1.0, use
`v0.MINOR.PATCH`:

- **MINOR** — meaningful product capability, architectural contract, provider
  capability, or intentional breaking internal evolution.
- **PATCH** — bug fix, safety hardening, reliability improvement, or a
  documentation correction that does not introduce a new capability milestone.

Do not create a version tag for every commit — tag milestone-worthy states only.

The first baseline release is **`v0.1.0`**, the Alepes platform foundation after
the Temporal Node 24 runtime certification is merged and validated.

Directional progression (not permission to implement automatically):

- `v0.1.0` — platform foundation
- `v0.2.0` — bank data / Plaid read-only
- `v0.3.0` — brokerage read-only
- `v0.4.0` — real-account Shadow Mode
- later — sandbox/live execution capabilities as deliberately approved

### Release candidates

Pre-release identifiers are appropriate once financial execution becomes involved:
`v0.6.0-alpha.1`, `v0.6.0-beta.1`, `v0.6.0-rc.1`, then `v0.6.0`. Before `v1.0.0`,
prefer release-candidate validation for any release that can move money or submit
securities orders.

### Git tagging

Create annotated tags from `main` only. Canonical form: `vX.Y.Z`.

```bash
git tag -a v0.1.0 -m "Alepes v0.1.0 — platform foundation"
```

Then push the tag normally. A GitHub Release corresponds exactly to a release tag.
Do not tag a commit until its `main` CI is green.

### Release baseline

Once the Node 24 Temporal runtime-certification milestone is merged and validated,
tag that exact `main` commit as `v0.1.0`. That tag ends foundation-building and
begins provider/product capability development. The next provider work begins from
a short-lived branch (e.g. `feat/plaid-readonly`), not directly on `main`.

### Runtime/toolchain policy

- **Bun 1.4** is the repository toolchain and default runtime: dependency
  installation, ordinary scripts, web/API, DuckDB analytics, Oxlint, and normal
  repo validation.
- **Node 24** is a narrow runtime exception for the Temporal Worker and
  workflow-isolate tests only.
- Do not introduce npm or pnpm as alternate package-management workflows;
  `packageManager` remains Bun 1.4.
- Native DuckDB remains confined to the analytics package.
- PostgreSQL remains the transactional authority.

### Validation before PR/merge

Before a PR is considered mergeable, run the validation appropriate to the changed
area. The full repository validation floor is: pinned Bun version; TypeScript
clean; Oxlint 0 errors; unit/property/conformance tests; PostgreSQL integration
tests when persistence is affected; Node 24 Temporal workflow-isolate tests when
Temporal is affected; DuckDB certification/analytics tests when analytics runtime
behavior is affected; Next build; and `git diff --check`. CI must enforce the
corresponding checks before merge to `main`.

### Agent behavior

Agents working in this repository must:

- inspect `AGENTS.md` before repository changes;
- preserve established architecture unless explicitly changing it;
- create a short-lived branch for normal product work;
- avoid direct pushes to `main` for routine changes;
- stop before tagging/releasing unless the milestone actually satisfies the
  documented release criteria;
- never infer permission to begin Plaid, Schwab, money movement, or live trading
  merely because a previous milestone was merged;
- keep unrelated changes out of the same commit; and
- report branch, commit SHA, validation results, and PR/merge state at handoff.

If an instruction from the user explicitly overrides this workflow for a specific
task, follow the user's instruction and record the deviation clearly.

---

## Clean-stop contract

When you finish a task, classify the repository state into exactly one of these
and state which:

- **FULLY CLEAN** — your work is committed (and pushed if that was in scope), no
  unexpected local changes remain, and `git status` shows only what you intend.
- **PROTECTED-DIRTY STOP** — the only remaining dirty paths are pre-existing
  user-owned changes you were told not to touch, and you list them explicitly.
- **DIRTY / FAILED STOP** — any of: your changes left uncommitted unexpectedly; a
  validation step left the repo in a broken state; a push failed; upstream state is
  unresolved; or you changed a file outside the task's scope.

"Done" without a clean-stop classification is not done.

---

## Final handoff contract

Every repository-changing response must state, explicitly:

1. **What changed** (files, and what behavior/state they altered).
2. **What was deliberately preserved** (existing behavior, user work, boundaries).
3. **Validation performed** (which commands, with results).
4. **Strongest proof achieved** (from the evidence levels above).
5. **Missing proof** (what you could not verify, and why).
6. **Remaining risk / blockers.**
7. **Git status** (the clean-stop classification).

For changes touching financial calculation, automation, or the pipeline, also
state the **key invariant you tested** (e.g. "sum of allocations equals
deployable, integer cents, as asserted by the property test").

---

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->