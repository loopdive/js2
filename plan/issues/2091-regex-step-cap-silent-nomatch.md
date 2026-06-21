---
id: 2091
title: "REGEX_STEP_CAP overflow silently reports no-match — must throw RangeError"
status: done
sprint: 63
created: 2026-06-11
updated: 2026-06-18
completed: 2026-06-18
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: regexp
goal: core-semantics
related: [1959, 2067, 2089]
origin: "2026-06-11 analysis program (report 04 §2f gap); stub 08-B6"
---

# #2091 — cap exhaustion indistinguishable from a true no-match

## Problem

Regexes exceeding 1M VM steps return `null` (no match) with no diagnostic
— a silent wrong answer indistinguishable from a genuine no-match.
Empty-quantifier loops (#1959) burn the cap and hit this today.

## Root cause

`src/codegen/regex/vm.ts:24` (cap) + `:107 return null` on exhaustion, and
`native-regex.ts:68` (duplicated cap constant — second drift smell).

## Fix direction

Throw a catchable RangeError-style error on cap exhaustion (host: throw;
standalone: exn tag), per report 04 §3f; deduplicate the cap constant.
Same loud-cap policy as the for-of 1M guard (#2067).

## Acceptance criteria

- Cap exhaustion throws catchable RangeError with a step-count message
- Normal matches/no-matches unchanged; #1959 repro now errors instead of
  silently failing

## Dupe check

#1959 covers the quantifier-progress bug itself; the cap's silent-null
behavior is unfiled. New (analysis program).

---

## Resolution (2026-06-18, cs-2163)

**Landed.** Both regex VM cap-exhaustion sites now throw a catchable
`RangeError` instead of silently reporting a no-match, and the cap constant is
deduplicated.

- **Native Wasm matcher** (`src/codegen/native-regex.ts`, `__regex_run`): the
  cap-check arm (was `then: [{ i32.const 0 }, { return }]` — a silent
  no-match) now throws via a new `regexCapExhaustionThrow(ctx)` helper that
  builds a `RangeError` instance + `throw $exc` instruction sequence. Dual-mode:
  JS-host mode routes through the `__new_RangeError` host import; standalone /
  WASI emits the in-module `__new_RangeError` constructor (zero host imports).
  The helper runs at the TOP of `ensureRegexRun`, BEFORE the `__regex_run` /
  `classMatchIdx` funcIdx captures — registering `__new_RangeError` shifts
  function indices, so doing it first keeps the captures correct (the
  late-import-shift discipline).
- **TS reference VM** (`src/codegen/regex/vm.ts`, `runAt`): the cap-exhaustion
  `return null` now `throw new RangeError(...)`. A legitimate backtrack failure
  still returns `null` — only the cap path throws, so the oracle matches the
  Wasm runtime.
- **Cap constant deduplicated** (#2091 secondary): `native-regex.ts` no longer
  defines a second `REGEX_STEP_CAP = 1_000_000`; it imports the single source of
  truth from `regex/vm.ts` (removes the drift smell).

**Note on scope:** the cap applies only to the **native** regex VM (standalone /
WASI). JS-host mode (`target: gc`, default) delegates `RegExp.prototype.test` to
`env.RegExp_new`/`RegExp_test` (the host JS engine), which has its own ReDoS
behavior — the native cap does not gate it.

### Test Results

- `tests/issue-2091-regex-step-cap-throw.test.ts` — 7/7. Part 1 (TS reference
  VM): catastrophic `(a+)+b` over 40×`a` throws `RangeError`; normal match
  returns its span; normal no-match returns `null` (cap untouched); the cap
  constant is the single exported `1_000_000`. Part 2 (standalone Wasm, zero
  host imports): catastrophic regex → caught `RangeError` (discriminant 2);
  non-catastrophic match → `true`; non-catastrophic no-match → `false` (no
  spurious throw).
- Regex regression suites (`regex-bytecode`, `issue-1539-standalone-regex`,
  `issue-1911-regex-phase2d`, `issue-1912-regex-phase2b`) — 605/605, no
  regression. typecheck + lint + format:check clean.
