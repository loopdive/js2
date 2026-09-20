---
id: 6648
title: "main regressed tests/issue-6602 + issue-6603 (standalone): `filter` over a nullable vec element fails wasm validation (`struct.new` needs 6, got 2) and an inline native-string concat traps `dereferencing a null pointer`"
status: ready
sprint: current
priority: high
horizon: s
goal: standalone
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-09-20
---

## Problem

Two committed witnesses fail on `origin/main` alone (measured at `b84d58d64c`,
2026-09-20 ~09:00 UTC, Node 22 and Node 25), and were green on `ea8d7f87ff`
(06:53 UTC) — so a PR in the window `ea8d7f87ff..b84d58d64c` (#5999, #6000,
#6001, #6002, #6004) regressed them. They are found only by the standalone
Temporal stack's witness sweep (`tests/issue-66*.test.ts`), which is why CI
did not block the merge; the S68 landing PR #6005 carries them as "main's".

| witness | expected | received on main |
| --- | --- | --- |
| `tests/issue-6602-standalone-nullable-vec-element-callback-param.test.ts` › array HOFs over a nullable vec element › do not trap on an unmatched capture group | `filter: "2"` | `filter: "!instantiate WebAssembly.compile(): Compiling function #62:"prepare" failed: not enough arguments on the stack for struct.new (need 6, got 2) @+62165"` |
| `tests/issue-6603-standalone-nullable-native-string-element-binding.test.ts` › controls — unchanged on both trees › keeps every binding shape the filter does not name | `inlineConcat: "undefined"` | `inlineConcat: "!dereferencing a null pointer"` |

The first is a **module validation failure** — the emitted `prepare` function
builds a struct with 2 operands where the type has 6 fields — on the `filter`
HOF over a regex match's unmatched capture group (a nullable vec element). The
second is a runtime null deref on an inline concat of a nullable native-string
element. Both shapes come from `RegExp` match results, and the only src commit
in the window that touches that surface is `5eddbfc32c` "fix(regexp): preserve
global match plain-array shape" (PR #6004), so that is the first bisect
candidate; #6001 (iterator length coercion) is the second.

## Acceptance

- Both witnesses green on main under Node 22 and Node 25, without editing the
  witnesses' expectations (they pin behaviour that was correct on `ea8d7f87ff`).
- Bisect recorded here (`git bisect` between `ea8d7f87ff` and `b84d58d64c` on
  the two test files is ~3 steps).

## Repro

```bash
npx vitest run tests/issue-6602-standalone-nullable-vec-element-callback-param.test.ts \
  tests/issue-6603-standalone-nullable-native-string-element-binding.test.ts
```
