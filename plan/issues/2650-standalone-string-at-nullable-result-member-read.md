---
id: 2650
title: "Standalone: member-read on String.prototype.at result returns empty (.length/.charCodeAt)"
status: done
completed: 2026-07-17
assignee: ttraenkler/dev-standalone2
sprint: current
priority: low
feasibility: medium
reasoning_effort: medium
task_type: conformance
area: string
language_feature: string-methods
goal: standalone-mode
related: [2600, 2644]
---

## Resolution (2026-07-17)

**Already fixed on main** by the native-string nullable work that landed after
the issue was filed (#2644 / #2648 / #2161 undefined-sentinel families and the
subsequent nullable-native-string coercion cleanup). Re-verified against main
`93e86d717`: in `--target standalone`, member reads on a `String.prototype.at()`
result now return correct values (they previously read as if the string were
empty).

| expr (standalone) | before | now |
|---|---|---|
| `const c = "abcd".at(2)!; c.length` | `0` | `1` |
| `"abcd".at(2)!.charCodeAt(0)` | `0` | `99` |
| `"abcd".at(-1)!.charCodeAt(0)` | — | `100` |
| `"abcd".at(2)!.toUpperCase() === "C"` | — | `true` |
| `"abcd".at(2)!.at(0) === "c"` | — | `true` |
| `"abcd".at(99)?.length ?? -1` | — | `-1` |

Closed with a standalone regression guard:
`tests/issue-2650-standalone-string-at-member-read.test.ts` (6 cases, all green).

**Separate finding (not this issue):** in **gc / JS-host** mode,
`"abcd".at(99)?.length` traps because the `length` host import is invoked on
`undefined` — the optional-chain short-circuit is not honored before the native
`length` call on a nullable native-string receiver. That is a distinct
host-path bug outside #2650's standalone scope; left for a follow-up.
---

# #2650 — Standalone member-read on a String.prototype.at result returns empty

## Problem

In `--target standalone`, `String.prototype.at(i)` **returns the correct value**
(string equality and `=== undefined` for OOB both work), but a **member read on
the result** — `.length`, `.charCodeAt(0)`, chained methods — reads as if the
string were empty.

### Verified repros (host pass / standalone wrong-value, main `06e1e04d68`)

| expr | host | standalone |
|---|---|---|
| `"abcd".at(2) === "c"` | `true` | `true` (value OK) |
| `"abcd".at(-1) === "d"` | `true` | `true` |
| `"abcd".at(9) === undefined` | `true` | `true` |
| `const c = "abcd".at(2); c.length` | `1` | **`0`** |
| `"abcd".at(2).charCodeAt(0)` | `99` | **`0`** |

Compare: `"abcd".charAt(2).charCodeAt(0)` → `99` in standalone (charAt works).

## Root cause (to confirm)

`String.prototype.at` returns `nativeStringTypeNullable` (a **nullable** AnyString
ref, because an out-of-range index yields `undefined`). The downstream member-read
(`.length` / `.charCodeAt`) on a nullable-typed AnyString ref appears to mishandle
the nullable wrapper — likely flattening/length-reading a path that does not
account for the nullable cast, producing 0. `charAt` works because it returns a
non-nullable native string. See `compileNativeStringMethodCall` `method === "at"`
(`src/codegen/string-ops.ts` ~2287) returning `nativeStringTypeNullable`, and the
member-read/length lowering for a nullable AnyString receiver.

## Notes on test262-row yield

The `built-ins/String/prototype/at` test262 rows already PASS standalone — they
assert via `assert.sameValue(s.at(i), "x")` (string equality), which works; they
do **not** chain a member read on the result. So this bug currently flips **no**
test262 row; it is recorded as a correctness gap for direct member-read call
sites (surfaced while surveying for the #2644/#2648 work). Low priority.

## Suggested validation
- New `tests/issue-2650-*`: `s.at(i).length`, `s.at(i).charCodeAt(0)`, chained
  `s.at(i).toUpperCase()`, OOB `s.at(99)?.length` × standalone + gc; gc-mode guard.
