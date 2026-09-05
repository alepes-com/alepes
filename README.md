# Alepes

**Your money, moving together.**

Alepes is a rules-based cash-flow-to-investment engine. Connect your bank and
brokerage, define rules for how incoming cash should be allocated, and let new
money rebalance your portfolio — contribution by contribution, without
unnecessary selling.

This repository (`alepes-com/alepes`) is the **canonical Alepes product/platform
repository**: the financial domain, the `packages/` engines (money, domain, rules,
allocation, execution-policy, integration-runtime, persistence, reconciliation,
Temporal workflows, analytics), and the host application. The public
product-preview website lives separately at `alepes-com/website` and is served
from `alepes.com`.

> Alepes provides automation infrastructure, not investment advice. You define
> the investment universe, target allocations, and rules. Alepes executes them.

---

## The metaphor

- **individual fish** → individual investments
- **the school** → the portfolio
- **flow** → incoming cash
- **formation** → target allocation health
- **drift** → holdings moving out of formation
- **rebalancing** → bringing the school back into formation (with new money)

---

## What's in this MVP

- **Public landing page** — hero with animated flow visualization, how-it-works,
  contribution-based rebalancing explainer, rules engine, Shadow Mode, security,
  and pricing.
- **Authentication UI** — sign in / sign up (mock, no backend).
- **Authenticated dashboard** — overview (portfolio value, formation score,
  cash-flow, recent automation, safety strip).
- **Portfolio builder** — "Build your school": search, add/remove, target
  percentages, allocation bands, drag-to-reorder, live donut, 100% validation.
- **Rules builder** — visual WHEN/IF/THEN rule creation with a live
  human-readable summary.
- **Simulation** — "What if?" deposit simulation with full cash-flow breakdown
  and per-holding explanation.
- **Activity** — filterable, immutable audit timeline.
- **Settings** — safety controls, connected accounts, strategy history,
  appearance, danger zone.
- **Explainability** — every automated decision is explained in a drawer.
- **Dark / light mode**, fully responsive.

---

## Tech stack

- [Next.js](https://nextjs.org) 16 (App Router, TypeScript)
- [React](https://react.dev) 19
- [Tailwind CSS](https://tailwindcss.com) v4
- [shadcn/ui](https://ui.shadcn.com) (Base UI primitives)
- [Lucide](https://lucide.dev) icons
- [framer-motion](https://www.framer.com/motion/) for micro-animations
- [Vitest](https://vitest.dev) for unit tests

## Getting started

```bash
# install dependencies
npm install

# start the dev server
npm run dev
# → http://localhost:3000

# production build
npm run build && npm start

# run unit tests
npm test

# lint
npm run lint
```

---

## Project structure

```
src/
  app/
    (auth)/          # login + signup
    (app)/           # authenticated app (overview, portfolio, rules,
                     #   activity, simulate, settings)
    layout.tsx       # root layout, fonts, theme, metadata
    page.tsx         # public landing page
    globals.css      # design tokens, Tailwind v4 theme
  components/
    brand/           # logo, wordmark
    marketing/       # header, footer, hero-flow, sections
    app/             # app shell, donut, primitives, explain-drawer
    auth/            # auth shell
    ui/              # shadcn/ui primitives
  lib/
    domain/          # pure, testable engine logic
      types.ts       # domain types
      allocation.ts  # contribution-based allocation engine
      rules.ts       # rules engine
      simulation.ts  # simulation + explainability
    providers/       # bank/brokerage abstraction layer (+ mocks)
    data/            # realistic mock account data
    format.ts        # currency / percent / time formatting
    utils.ts         # cn()
```

### Domain layer (the important part)

The financial logic is **pure and deterministic**, with no dependency on
provider APIs or the network. This is what makes it unit-testable and lets real
integrations drop in later:

| Module | Responsibility |
| --- | --- |
| `allocation.ts` | `allocateContribution` — routes a dollar amount to the most underweight holdings, respecting bands, fractional shares, minimum trade size, and per-holding caps. |
| `rules.ts` | `evaluateRule` — matches a deposit to a rule and computes the investment amount with reserve, per-deposit, and monthly caps, recording every decision. |
| `simulation.ts` | `runSimulation` — ties deposit → rules → allocation together; `explainAllocation` generates human explanations. |

The allocation engine supports:
1. target allocations
2. current portfolio values
3. incoming investment amount
4. contribution-based drift correction
5. allocation bands
6. fractional shares
7. minimum trade size

### Provider abstraction

`src/lib/providers/types.ts` defines `BankProvider`, `BrokerageProvider`,
`DepositDetector`, and a `ProviderRegistry`. The MVP ships `Mock` implementations
(`providers/mock.ts`). Real integrations (e.g. Plaid for banking, a brokerage
API) implement the same interfaces — no view code changes required.

---

## Notes on compliance language

This is a preview. It intentionally avoids unsupported claims (FDIC insurance,
specific certifications) and uses language like "built with a security-first
architecture." No real money is moved.