---
id: 4170
title: "test262 .js sources rejected with TS8010/8017 'can only be used in TypeScript files' at L1:1 — 153 tests (112 Atomics, 29 module-code, 12 import)"
status: done
sprint: 78
created: 2026-08-01
updated: 2026-08-18
completed: 2026-08-11
priority: medium
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: compiler
language_feature: compiler-internals
goal: test-infrastructure
related: [3721, 3427, 1061, 1710]
origin: "2026-08-01 /harvest-errors of loopdive/js2wasm-baselines test262-current.jsonl (run 20260801-090441, gitHash c601e89b)"
---

# #4170 — test262 `.js` files rejected as if they were TypeScript

## TL;DR

**153 official failing tests** in the default lane are rejected at **L1:1**
with a burst of TypeScript-only syntax diagnostics:

```
L1:1 Signature declarations can only be used in TypeScript files.;
L1:1 Type annotations can only be used in TypeScript files.;
L1:1 Type annotations can only be used in TypeScript files.; ...
```

These are plain ECMAScript `.js` test files. Real `tsc` reports zero errors on
them. The compiler is putting a `.js` source down a TypeScript parse path, and
every TS-only construct in whatever text sits at line 1 is reported as a syntax
error, so the file never compiles.

All positions are **L1:1**, which points at the *assembled harness prelude*
rather than the test body — the same shape as #3427 (harness-assembly
`Duplicate identifier 'isPrimitive'`, since fixed).

## Evidence

Source: `test262-current.jsonl` from `loopdive/js2wasm-baselines`, run
`20260801-090441` (gitHash `c601e89b`).

| Category | Count | Example |
| --- | --- | --- |
| `built-ins/Atomics` | 112 | `test/built-ins/Atomics/notify/notify-zero.js` |
| `language/module-code` | 29 | `test/language/module-code/eval-export-dflt-cls-name-meth.js` |
| `language/import` | 12 | `test/language/import/import-attributes/json-extensibility-object.js` |
| **total** | **153** | |

The standalone lane shows the identical 112-record Atomics bucket plus a
27-record `The 'declare' modifier can only be used in TypeScript files.`
variant in `language/module-code`, so this is **lane-independent** — it is a
front-end/harness problem, not a codegen one.

The Atomics concentration is the strongest clue: those tests pull in the
`agent`/`atomics` harness helpers (`$262.agent.*`). If one of those harness
files carries TS-flavoured declarations (or is being concatenated ahead of the
test with the wrong `scriptKind`/`allowJs`), every Atomics test inherits the
failure regardless of its own content.

## Relationship to #3721

#3721 tracks the **same diagnostic signature** (TS8010/8017 false positives on
a `.js` file where real `tsc` is clean) but for a different corpus — the
`diff@9.0.0` npm-package dogfood bundle. This issue is the **test262** instance.

They may share one root cause in the front end's `scriptKind`/`allowJs`
handling (cf. #1061, "analyzeMultiSource / compileMultiSource drops allowJs and
forces .js → .ts", already `done`). **Check #3721 first** — if a single fix
covers both, land it once and close this as a duplicate rather than writing a
second fix. Filed separately because the corpora, reproduction paths, and
owners differ, and because 153 conformance tests should not be tracked inside a
package-dogfood issue.

## Repro sketch

```bash
# minimal: compile an Atomics test through the same harness-assembly path
node scripts/... --file test/built-ins/Atomics/notify/notify-zero.js   # (exact runner entry TBD)
```

The first diagnostic's position (L1:1) and the assembled prelude text are the
two things to capture — dump the concatenated source the compiler actually
sees, rather than the test file on disk. That dump is the whole diagnosis.

## Acceptance criteria

- [ ] The assembled source for an Atomics test parses as JavaScript; no
      TS-only diagnostics are emitted for a `.js` test262 input.
- [ ] The 153-record `can only be used in TypeScript files` bucket drops to ~0
      in a fresh host-lane harvest, and the 112 + 27 standalone records with it.
- [ ] Whatever those tests then do (pass, or fail for a real Atomics reason) is
      recorded — a genuine `SharedArrayBuffer`/Atomics gap is #674/#1354, not
      this issue.
- [ ] Net official pass count does not regress.


---

## Harvest note — 2026-08-11 — RESOLVED, and this issue has a duplicate

Source: `test262-current.jsonl` from `loopdive/js2wasm-baselines`, run
`20260811-103533` (gitHash `9268d5a5`).

**The TS8010/8017 bucket is now 0 records.** No official failing test in either
lane reports `can only be used in TypeScript files`.

Permanent conformance repro (this issue's own named sample):
`test262/test/built-ins/Atomics/notify/notify-zero.js`, which now reads:

```
fail | runtime_error | Cannot read properties of null (reading 'bind') [in __module_init()]
```

The file compiles; it now fails on the *next* blocker. That satisfies the
acceptance criterion "Whatever those tests then do (pass, or fail for a real
Atomics reason) is recorded". Successor filed as **#4365** (`$262.agent` is
null, same 112 Atomics tests).

**Duplicate:** #4020 and #4170 are the same issue — identical title and body,
both filed by the 2026-08-01 harvest, and #4020's body header reads `# #3973`,
so the pattern was filed three times. Both are closed here; treat #4020 as the
canonical record and #4170 as the duplicate.
