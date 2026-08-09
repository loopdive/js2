---
id: 3561
title: "test(#2961): refresh stale standalone leak-scan guard test (console.log went host-free) + fold into required guard suite"
status: done
completed: 2026-07-24
assignee: ttraenkler/dev-opus-2
sprint: 76
created: 2026-07-24
priority: medium
horizon: s
feasibility: easy
task_type: test-hygiene
area: testing, ci
goal: infrastructure
related: [2961, 3552, 3558]
---

# #3561 — refresh the stale #2961 standalone leak-scan guard test

## Problem

`tests/issue-2961.test.ts` had **4 silently-rotted assertions** (a #3558-class
stale guard test, invisible outside required checks because untouched root
tests don't run at PR time — #3008). Its leak example — `console.log("hello")`
leaking the native-string bridge `__str_from_mem`/`__str_to_mem`/
`__str_extern_len` in `--target standalone` — no longer leaks: native strings
+ a native console retired that bridge, so standalone `console.log` now emits
**zero imports**.

## Verify-first (measured on current main, 2026-07-24)

- Standalone `console.log("hello")` → **0 binary imports** (authoritative
  `WebAssembly.Module.imports`); the string bridge is retired (0 imports for
  concat / `String()` / `JSON.stringify` / template literals too).
- **The leak-scan MECHANISM is healthy**, NOT a regression:
  - `assertNoLeakedHostImports` still runs for standalone at warning severity
    (`src/codegen/index.ts:4066-4077`).
  - `scanForLeakedHostImports` unit-flags a synthetic `env::__str_from_mem` and
    correctly ignores allowlisted `Math_random`/`console_log_string` +
    always-allowed `wasi_snapshot_preview1::fd_write`.
  - End-to-end, a `declare class Widget` extern still leaks `env::Widget_new`/
    `Widget_render` and produces real `Host import leak (warning, #2961)`
    diagnostics.
  - `Math_random`'s silence is correct — `Math_` is on the allowlist.
- So no bisect: nothing broke; `console.log`'s lowering went native (a win).

## Fix

Rewrote the 4 stale console.log-leak cases in `tests/issue-2961.test.ts` to use
a **user-declared extern class** (`declare class Widget` → non-allowlisted
`env::Widget_*`) as the leak example. Extern-class methods are explicitly never
auto-allowlisted, so — unlike a builtin — this example cannot drift host-free
and silently stop exercising the scan. Also:

- Replaced the "allowlisted tolerated silently" case with `Math.random`
  (emits `env::Math_random`, correctly unwarned).
- Added a POSITIVE assertion that standalone `console.log` is now host-free
  (documents the improvement that made the old example stale).
- Kept the passing cases (host-free program, wasi guard, `JS2WASM_STANDALONE_
  LEAK_SCAN=0`, `buildLeakedHostImportError` wording).

**Folded into the required guard suite** (`tests/guard-suite.json`, run by the
`quality` job via `pnpm run test:guard`, #3552) — the whole point of the #3558
closure: this is the 3rd stale/invisible guard test the program has found
(#3558 ×2, now #2961). The refreshed file runs in ~6s (guard-suite budget is
60s/file, ~2min total; the full suite is ~15s with this entry).

## Acceptance

- [x] `tests/issue-2961.test.ts` green on current main (11 tests).
- [x] Leak example is durable (non-allowlisted extern class, cannot go
      host-free).
- [x] Positive assertion pins console.log's host-free improvement.
- [x] Added to `tests/guard-suite.json`; `pnpm run test:guard` green, within
      the time budget.
