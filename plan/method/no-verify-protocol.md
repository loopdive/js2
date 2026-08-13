# `--no-verify` protocol

**Rule: never `git commit --no-verify`.** Enforced by
`.claude/hooks/block-no-verify.sh` (PreToolUse, exit 2).

`git push --no-verify` is a **different case and is allowed** — see below.

## The sanctioned alternative

```bash
SKIP_SLOW_PRECOMMIT=1 git commit -m "..."
```

`.husky/pre-commit` deliberately runs two lanes:

| lane | contents | cost | skipped by |
| --- | --- | --- | --- |
| **fast (unconditional)** | `lint-staged` (prettier/biome), `check:loc-budget`, `check:func-budget` | ~4.5 s | `--no-verify` only |
| **slow** | `test:changed-root`, `check:oracle-ratchet` | minutes | `SKIP_SLOW_PRECOMMIT=1` |

The split exists because the slow lane can exceed an agent's tool timeout, which
historically drove wholesale `--no-verify` and lost the seconds-cheap gates along
with it. `SKIP_SLOW_PRECOMMIT=1` is the supported way to skip only what is slow.
CI runs every gate regardless.

## Why this is enforced rather than merely documented

The budget ratchets were once classified into the slow tier, so every agent
commit skipped them and violations surfaced ~20 minutes later in CI. **PR #4252
burned two CI cycles exactly this way**, which is why they were moved to the
unconditional lane on 2026-08-09.

The habit re-formed anyway. On **2026-08-12** an agent used
`git commit --no-verify` for an entire session — the flag had been sanctioned for
`git push` and got carried across to `commit` without anyone noticing. Every
commit that session bypassed `check:func-budget`; a **+119-line growth in
`fillMemberGetDispatch`** (385 → 504) was invisible until the habit was dropped,
at which point the gate caught it immediately and the fix was a straightforward
function extraction. Caught at commit time that is a two-minute refactor; caught
in CI it is a failed run and a context switch.

`.husky/pre-commit` states the rule in its own comments — *"Never use
`--no-verify`; use this"* — but a comment inside the thing being bypassed cannot
enforce anything. Hence the hook.

## When the fast gate fails, fix it — do not bypass it

| failure | fix |
| --- | --- |
| `check:func-budget` | Split the function. If the growth is genuinely intended, list the key under `func-budget-allow:` in the frontmatter of **this change's own issue file**. Never commit `scripts/func-budget-baseline.json` in a PR — it is refreshed post-merge on `main` only (#3131/#3400). |
| `check:loc-budget` | Same, via `loc-budget-allow:`. |
| prettier / biome | `npx prettier --write <files>` |

The gate's own message names the offending key and prints the allowance syntax.
Prefer splitting: an allowance is a permanent entry in an issue file, a split is
usually a few minutes of code motion.

## `git push --no-verify` is allowed

Not blocked, and not an inconsistency. The **pre-push** hook is an integrity gate
that chokes on this checkout's fork/upstream divergence, so CLAUDE.md sanctions
`git push --no-verify` explicitly; the same checks run in CI against the real
merge base. The hook only inspects segments containing `git commit`, so
`git commit -m x && git push --no-verify` passes.

## The override

For a genuine emergency — the fast gate is itself broken, not merely unhappy
with your change:

```bash
JS2WASM_ALLOW_NO_VERIFY=1 git commit --no-verify -m "..."
```

Accepted inline or as an inherited environment variable, and logged as
`no_verify_override_used`.

**It is a last resort, and "the gate is complaining about my change" is not an
emergency** — that is the gate working. Legitimate uses are narrow: the hook
itself is broken, a dependency has made `lint-staged` unrunnable, or you are
committing the fix *to* the gate. If you use it, say why in the commit message,
because the next reader will want to know whether the gates were meaningfully
green.

Do **not** export it into a shell profile or a long-lived environment. That
recreates the exact failure mode this file documents: a bypass that was
deliberate once and then invisible forever after.
