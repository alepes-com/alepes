Alepes is a fintech SaaS product that automates how incoming cash is allocated into a user-defined investment portfolio.

Users connect a bank account and brokerage account, create a portfolio of stocks or ETFs with target allocation percentages, and define rules for how much of qualifying deposits should be invested.

Example:

When a paycheck deposit is detected:
- keep at least $2,000 in checking
- invest 20% of the deposit
- never invest more than $750 from one deposit
- direct the contribution toward holdings that are currently underweight

Instead of blindly buying every asset at its target percentage, Alepes uses contribution-based rebalancing. New money is preferentially allocated to underweight positions so the portfolio moves back toward its desired allocation without unnecessary selling.

Alepes should support a safe simulation mode called **Shadow Mode**, where deposits and investment decisions are detected and calculated but no money is moved. Every decision should be explainable and auditable.

The product is not a stock picker or robo-adviser. Users choose their own investment universe, target allocations, and automation rules. Alepes provides the infrastructure for executing those rules.

Core product concepts:

- **School** — the user's portfolio
- **Formation** — how closely the current portfolio matches target allocations
- **Flow** — incoming cash
- **Rules** — user-defined automation
- **Shadow Mode** — simulated automation with no real money movement

Initial product features:

- responsive web application
- user authentication
- bank and brokerage connection architecture
- portfolio builder
- target allocation percentages
- allocation bands
- cash reserve rules
- per-deposit and monthly investment limits
- deposit detection
- contribution-based rebalancing engine
- rule builder
- Shadow Mode
- simulation tools
- portfolio drift visualization
- decision explanations
- immutable activity/audit history
- pause/kill switch for automation
- provider connection health

Technical direction:

Build Alepes as a modular TypeScript monorepo with a Next.js web frontend, backend API, PostgreSQL database, durable background workflows, and provider-neutral financial integrations.

The architecture should strongly separate:

1. observing financial events
2. evaluating user rules
3. generating a capital plan
4. calculating portfolio allocation
5. validating safety constraints
6. executing external financial actions
7. reconciling results
8. recording an immutable audit trail

External providers such as Plaid and Schwab should be implemented through a capability/plugin architecture inspired by Opnory's integration runtime.

Alepes core owns all financial policy and decision-making. Plugins only expose external capabilities such as reading balances, retrieving positions, initiating transfers, or submitting brokerage orders.

The allocation engine and rules engine should be deterministic, testable domain packages with no direct dependency on provider APIs.

For the first MVP, use mock integrations and Shadow Mode. Do not move real money or place real trades.

Brand:

**Alepes**

Alepes is named after a schooling ocean fish. The brand metaphor is many individual assets moving together as one coordinated portfolio.

Primary tagline:

**Your money, moving together.**
