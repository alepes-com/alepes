# @alepes/alpaca-brokerage-data

Provider-neutral **read-only** brokerage adapter for Alpaca Trading API **paper** accounts. It adapts Alpaca's `/v2/account`, `/v2/positions`, and market-data quote endpoints into Alepes's `BrokerageDataProvider` contract.

**Strictly read-only**: no order submission, no transfer, no mutation. It deliberately does **not** expose `capability:brokerage:submit-orders`.

See `packages/integration-runtime/src/index.ts` for the contract, and `packages/domain/src/index.ts` for `BrokerageAccountState` / `BrokeragePosition`.

## Credential model — two sources, one harness

The credentialed certification (`bun run certify:alpaca-paper`) reads exactly two environment variables:

```bash
ALEPES_ALPACA_PAPER_KEY      # Alpaca paper API key id
ALEPES_ALPACA_PAPER_SECRET   # Alpaca paper API secret
```

There are two places to supply them, and they serve **different purposes**. Neither is authoritative over the other; both feed the *same* variables into the *same* harness.

### 1. Local file (developer convenience)

```bash
# ~/.config/alepes/alpaca-paper.env  — outside the repo, never committed
ALEPES_ALPACA_PAPER_KEY=<paper key id>
ALEPES_ALPACA_PAPER_SECRET=*** secret>
```

Use it for fast manual runs while developing the adapter/harness, or to reproduce a result before pushing:

```bash
# NOTE: source it WITHOUT `set -x` — never trace credentials into shell history/output.
set -a && . ~/.config/alepes/alpaca-paper.env && set +a
bun run certify:alpaca-paper
```

### 2. GitHub Environment secrets (formal release gate)

`.github/workflows/alpaca-paper-certify.yml` runs the same harness under the `alpaca-paper` GitHub Environment, with secrets `ALEPES_ALPACA_PAPER_KEY` / `ALEPES_ALPACA_PAPER_SECRET` stored only in that Environment (never in the repo, never in workflow YAML, never in any expression output).

This exists to produce **auditable, repeatable, exact-head** certification: proof that the committed code at a specific SHA passed against real Alpaca paper, independent of any laptop.

## Release policy

```text
Developer confidence:
  local paper certification may be run anytime.

Release gate:
  GitHub Environment certification MUST pass on the exact PR head
  before merge; a v0.3.0 tag is created only after the credentialed
  certification passes on the exact merged main SHA.
```

## Safeguards (both paths)

- `~/.config/alepes/alpaca-paper.env` stays outside the repo and is never sourced under `set -x`.
- GitHub secrets are environment-scoped and never committed or placed in workflow YAML.
- The harness redacts raw credentials **itself** (replaces the key id and secret with deterministic fingerprints before printing), so it does not rely on GitHub's secret masking alone.
- Do not print encoded or derived forms of the secrets (e.g. the Basic-auth `base64(key:secret)`) either.
- The certification workflow is tightly scoped: it only runs under the trusted `alpaca-paper` Environment, and the harness refuses any environment other than `paper`/`sandbox` (never contacts live `api.alpaca.markets`).