---
id: 7178
title: "WASI: ToPrimitive of a dynamic array yields an object string (`m + 1`, `String(m)`, `r += m`)"
status: ready
sprint: Backlog
created: 2026-10-27
updated: 2026-10-27
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: correctness
related: [7113, 7177]
---

# #7178 — WASI: ToPrimitive of a dynamic array yields an object string

Found in the round-11 review of PR #6834 (#7113, NIT B). The bug is already on main.

On WASI, when the boxed-any carrier holds an array, its ToPrimitive / ToString gives a 15-character
object string where JS gives the joined elements (`"1,2"`). The result string has length 15, which
fits `"[object Object]"`. Every carrier `+`, string concatenation and `String(v)` inherits this. The
IR and the legacy path give the same wrong answer. String, number and object inputs are correct.
Standalone and gc native-first are correct.

Measured on origin/main `72e8b57763` and on the #6834 round-12 head. A string result is shown as
`1000 + length`, so `1003` is `"1,2"` and `1015` is a 15-character string.

| Closure body (input `[1, 2]`) | node | wasi IR | wasi legacy | standalone / gc |
| --- | --- | --- | --- | --- |
| `throw m + 1` | 1004 (`"1,21"`) | **1016** (claimed on main) | — | 1004 |
| `throw m + ""` | 1003 | **1015** (claimed on main) | — | 1003 |
| `throw String(m)` | 1003 | **1015** (claimed on main) | — | 1003 |
| `var r = m ? m : 1; var s = r; s = s + 1; throw s` | 1004 | **1016** (claimed at head) | **1016** (main) | 1004 |
| `var r = m ? m : "a"; throw r + r` | 1006 | **1030** (claimed at head) | throws (main) | 1006 |
| `var r = m ? m : 1; throw String(r)` | 1003 | **1015** (claimed at head) | **1015** (main) | 1003 |
| `var r = m ? m : ""; r += m; throw r` | 1006 | **1030** (claimed at head) | **1030** (main) | 1006 |
| `var r = m ? m : 1; r = r + undefined; throw r` | 1012 | **1024** (claimed at head) | **1024** (main) | 1012 |

Loose equality against a number **traps** on WASI (`RuntimeError: illegal cast`): the helper
ToPrimitives an object / array operand by a cast. It is IR-claimed on main as `if (m == 1)`; legacy
answers `[1, 2] == 1` and `{} == 1` correctly but `[1] == 1` wrong. Against a string, IR and legacy
agree but `[1] == "1"` is wrong in both (`false`). Since #6834 round 13 the selector refuses the
non-string case in the shapes #6834 newly plans (capability `native-dynamic-loose-equality`).

| Closure body (wasi) | Input | node | wasi IR | wasi legacy |
| --- | --- | --- | --- | --- |
| `if (m == 1) throw "n"; throw m` | `[1, 2]` | throws `m` | **illegal cast** (claimed on main) | — |
| `var r = m ? m : 1; if (r == 1) throw "n"; throw r` | `[1, 2]` / `{}` | throws `r` | **illegal cast** (#6834 r12 head) | throws `r` |
| same | `[1]` | throws `"n"` | **illegal cast** | **throws `r`** |
| `var r = m ? m : 1; if (r == "1") throw "n"; throw r` | `[1]` | throws `"n"` | **throws `r`** | **throws `r`** |

For the `+` / `String` rows below, refusing at select on WASI would not help: legacy gives the same wrong value in every row
(and throws for `r + r`).

## Implementation Plan

1. **Find the conversion.** Locate the WASI carrier ToPrimitive / ToString (the dynamic `+`,
   `IR_DYN_ADD_FN`, and the `String(v)` helper, plus legacy's externref ToString on WASI). Find
   where a vec payload falls into the generic object arm.
2. **Add the array arm.** Add Array.prototype.join(",") semantics for a vec payload: elements
   through ToString, with `undefined` / `null` elements as the empty string. Share it with the
   standalone regime's implementation if the WASI runtime can link it.
3. **Loose equality.** Route an object / vec carrier through the same ToPrimitive in WASI's loose
   `==`, then flip `native-dynamic-loose-equality` to true for WASI.
4. **Tests.** Cover `m + 1`, `m + ""`, `String(m)`, `` `${m}` `` and `r += m` with `[1, 2]`, `[]`,
   `[null, 3]` and nested arrays, on all three lanes, executed.
