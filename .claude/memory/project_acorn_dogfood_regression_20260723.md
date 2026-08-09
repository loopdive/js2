---
name: project_acorn_dogfood_regression_20260723
description: "ACTIONABLE: acorn dogfood regressed 23/23 → 13/23 parsing (10 throw at parse time) between 2026-07-17 and 2026-07-23. Unattributed. Prime hypothesis: #3506 restructured __extern_get fallthrough, and #2694 documents that acorn's Scope.flags reads route through __extern_get. Plus: equal=0 always (±quirks hides a boolean-type gap)."
metadata:
  node_type: memory
  type: project
  originSessionId: f3739381-bbf1-4f5c-9036-57a3a6c8eeac
  modified: 2026-07-23T19:19:30.477Z
---

**User directive (2026-07-23): investigate, file/update issues, prioritise in the current
sprint, and pick the model tier.** Recorded here because at the time all three dispatch paths
were blocked (spawn gate at load ~13–20 on 10 cores; `claim-issue.mjs --allocate` returning
empty on 5+ attempts all day; `git worktree add` timing out).

**DISPATCHED 2026-07-23 (resumed session, after prior-session crash).** Dispatch paths clear
now (load ~1.7/10, `--allocate` healthy → #3557). Fable senior-dev **`acorn-regression`**
(teammate, worktree) is bisecting — framed as a BISECT (culprit named by `git bisect`), NOT
hypothesis-confirmation; it CHECKS both suspects (#3506 fallthrough, #2848 re-regression)
against the actual culprit. It owns #1712, adds correctness data to #2694, and splits the
boolean quirk out of #2847. **Repro re-confirmed on HEAD `b9b89b8`: probe 8/13, same 5 files
throw** (objects, spread-rest, arrow-params, destructuring, classes). **Note: the "no issue
exists for booleans/quirk" line below is WRONG — #2847 already covers both quirks but mislabels
the boolean one "cosmetic"; the split fixes that. RangeError #3477 is LANDED (PR #3433), not WIP.**

## THE REGRESSION (measured, read-only agent, harness verified byte-identical to baseline)

Harness: `tests/dogfood/` (`pnpm run dogfood:acorn-corpus`), pinned acorn 8.16.0, oracle =
node-acorn on the same tarball.

| | baseline 2026-07-17 | 2026-07-23 (main @ `08615d58`) |
| --- | --- | --- |
| inputs | 23 | 23 |
| **`equal`** (exactly identical AST) | **0** | **0** |
| `equal±quirks` | 23 | **13** |
| `REAL` structural divergences | 0 | 0 |
| **`compiled-threw`** | **0** | **10** |

**10 inputs went from parsing to THROWING at parse time**, incl. `real/acorn.mjs` (acorn parsing
itself). Errors are genuine acorn `SyntaxError`s, not Wasm traps: `'return' outside of function`,
`'new.target' can only be used in functions and class static block`, and `Unexpected token` right
after `yield`. **Mechanism: acorn's function/generator/async scope-context state answers "not
inside a function" when it should answer "inside".** Independent corroboration:
`pnpm run dogfood:acorn-probe` expects 13/13, gets 8/13, same 5-file subset.

**NOT attributed.** Baseline is 6 days old, so the window is 07-17 → 07-23 — do NOT assume it is
from 07-23's merges (the lead made exactly that unverified leap and had to retract; a separate
regression found the same day turned out to be 2 days old). **BISECT REQUIRED.**

**PRIME HYPOTHESIS (untested, but concrete):** **#2694** documents that acorn's `Scope.flags`
reads *route through the dynamic `__extern_get` host path*. **#3506** (merged 2026-07-23 11:46)
explicitly **restructured `__extern_get`'s arm fallthrough** ("the vec arm terminally missed
non-length/non-index keys — fixed by fallthrough restructuring" + new `src/codegen/vec-props.ts`).
A changed fallthrough on a non-vec receiver would plausibly return the wrong value for
`scope.flags`. Test this FIRST in the bisect; disprove it rather than assume it.

## EXISTING ISSUES — update these, don't duplicate

- **#2694** `acorn parse() 11th wall — Scope.flags read loop` — `sprint: current`, **`status:
  blocked`**, `depends_on: [2660]`, `goal: acorn-dogfood`, feasibility hard. Same object
  (`Scope.flags`) but describes a ~800k× READ LOOP (perf), not a WRONG VALUE. Today's regression
  is a correctness failure on the same surface. Add the data; it may reframe or unblock it.
- **#1712** `acceptance: compiled acorn parses a representative .js with AST structurally equal`
  — `sprint: current`, `in-progress`, `priority: high`. The corpus regression belongs here.
- **#2773** `[EPIC][ARCH] Value-rep substrate` — natural parent for the boolean-marshalling gap.
- **No issue exists** for the boolean marshalling or the quirk-policy work — file both.

## THE QUIRK FINDING (separate from the regression)

`equal = 0` in BOTH runs — **not one input has ever produced a byte-identical AST.** "Full
structural parity" in `CORPUS-GAP-MAP.md` meant *±quirks*. Two quirks:
1. extra `sourceFile` field — defensible (acorn itself has a `sourceFile` option);
2. **booleans marshalled as i32 `0`/`1`** — NOT cosmetic. `node.computed === false` fails,
   `typeof` is `"number"`, `JSON.stringify` differs. A wrong TYPE crossing the boundary,
   systemic across every boolean on every node. **Fix, don't accept.**

**Policy recommendation:** keep a quirk mechanism but kill the open-endedness — always report
`equal` AND `equal±quirks` side by side (never headline the tolerant one), give every quirk an
issue + owner + fix-or-accept decision, and FREEZE the list so a future regression can't hide
inside an existing allowance. Same disease as vacuous passes and the designed-no-op CI check:
the definition of "pass" quietly absorbing known failures.

## MODEL TIER (lead's decision, evidence-based)

- **Acorn regression → FABLE (frontier).** #2694 is already `blocked` on this exact surface;
  today's closest analogue (closure representation) only cracked via raw-byte instrumentation
  refuting the audit's hypothesis; the Sonnet measurement agent correctly stopped short of
  bisecting. Justified by track record on THIS surface, not general capability.
- **Boolean marshalling → OPUS, with an explicit escalation trigger.** First task is to
  determine whether it's a contained boundary conversion (Opus finishes it) or value-rep
  substrate (hand to Fable). #2773's existence suggests it may be the latter.
- **Quirk inventory + harness reporting → OPUS** (Sonnet capable).
- **Caveat:** today's differentiator was mostly *measurement discipline*, not model tier —
  see [[feedback_measure_never_extrapolate]]. Don't reflexively buy frontier for everything.

## ALSO BLOCKED / NO CI COVERAGE

No CI gate wraps `acorn-corpus.mjs`/`acorn-probe.mjs`; only the smaller `acorn-harness.mjs` has a
vitest wrapper, opt-in via `DOGFOOD_ACORN=1`. **This regression was invisible** — the third such
gap found on 2026-07-23. Fold a cheap acorn signal into the new guard suite
(`tests/guard-suite.json`, `pnpm run test:guard`, from #3552) if it fits the ~1-min budget.
