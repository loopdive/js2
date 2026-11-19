---
id: 7375
title: "Prepared path: compound assignment with a non-numeric right-hand side"
status: in-progress
sprint: current
created: 2026-11-19
updated: 2026-11-19
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7354, 7349, 7350]
# 2026-11-19 (S10): src/ir/from-ast.ts +23. The compound arm reads a boolean / string right-hand side with the
# binary form's steps through one helper, `numericReaderOperandToF64` (the binary form's boolean conversion is
# factored into `booleanToNumber`, which both use), and from-ast's resolver capability union names
# `native-dynamic-to-number`, which prettier now splits over lines.
# 2026-11-19 (S10): plannedClosureOperandRefusal +2. Its compound-write arm passes the lane's
# `native-dynamic-to-number` capability into the one table; prettier wraps the return over three lines.
loc-budget-allow:
  - src/ir/from-ast.ts
func-budget-allow:
  - src/ir/select-planned-closure-operands.ts::plannedClosureOperandRefusal
---

# #7375 — Prepared path: compound assignment with a non-numeric right-hand side

## Problem

On the Prepared whole-program path (`TEST262_COMPILER_PATH=ir`, entry
`src/test262/test262-prepared-entry.ts`) a numeric compound assignment whose
right-hand side lowers to a string or a boolean refuses:

```js
var x;
x = true;
x *= true; // ir/from-ast: compound assign RHS has no numeric carrier (got i32) in <module-init>
x = "1";
x *= "1"; // ir/from-ast: compound assign RHS has no numeric carrier (got string) in <module-init>
```

- **Raised in** `lowerCompoundAssignment`, `src/ir/from-ast.ts` (its last
  admission check): `IrUnsupportedError("compound-assign-unsupported", "build", …)`
  when `compoundWriteAdmissible(op, slotFamily, irOperandFamily(rhsType, rhs))`
  is false.
- **The table** is `compoundWriteAdmissible`,
  `src/ir/analysis/operand-admissibility.ts`: a numeric compound admits a
  right-hand side of family `dynamic`, `number` or `undefined` only. A string
  literal lowers to `string`, a boolean literal to `i32`; both are refused. The
  selector of the ordinary pipeline asks the same table
  (`src/ir/select.ts`, `src/ir/select-planned-closure-operands.ts`).
- **The binary form already works.** `x = x * "1"` and `x = x * true` compile
  and run on this path: `lowerBinaryOperands` converts the pair
  (`booleansReadAsNumbers`, #7282; `boxNumericReaderOperands`, #7106 lever B)
  and `tryLowerDynamicArithmetic` reads a boxed side with ToNumber. The
  compound form has no such arm.

Dependencies:

- **Dynamic `+` (`__ir_dyn_add`), slice Str2 of #7354 (lane
  `claude/7354-perf2`).** `x += true` and `x += "1"` into a dynamic slot are
  admitted by from-ast and stop later at
  `dynamic operation __ir_dyn_add has no Prepared intrinsic`. The message of
  every check in the 30 files (`'#1: …' + (x)`) is the same dynamic `+`.
- The 30 files also use `new Test262Error` (C · #7349) and `new String("1")` /
  `new Boolean(true)` (B · #7350), so they pass as whole files only after
  those slices.

No owner yet.

## Measured

2026-11-19, main `ee3fcdd610`, stand-in harness, first gap per file (census
`plan/log/es5-ir-only-census-2026-11-19.md`, section 1.2 row 14).

- **30 files**, recounted from the rows: the lines of
  `plan/log/es5-ir-only-census-2026-11-19-lists/other.tsv` whose detail is
  `compound assign RHS has no numeric carrier`; the same 30 in the raw rows
  (`.tmp/ir-census/prepared-standin-main.jsonl`, not committed). All are
  `language/expressions/compound-assignment/S11.13.2_A4.<n>_T<t>.js`, all in
  `<module-init>`.
- **By right-hand side:** `string` 20, `i32` (a boolean) 10.
- **By operator:** 3 files each for `*=` `/=` `%=` `-=` `<<=` `>>=` `>>>=` `&=`
  `^=` `|=` (A4.1–A4.3, A4.5–A4.11). `+=` (A4.4, 13 files) is not in the list:
  10 stop first at `new Test262Error`, 3 at `isNaN`.
- **By test:** `T1.1` 10 (`x = true; x *= true`), `T1.3` 10
  (`x = "1"; x *= "1"`), `T2.5` 10 (`x = true; x *= "1"`).

| file | first gap |
| --- | --- |
| `S11.13.2_A4.1_T1.1.js` (`*=`) | `compound assign RHS has no numeric carrier (got i32)` |
| `S11.13.2_A4.1_T1.3.js` (`*=`) | `… (got string)` |
| `S11.13.2_A4.1_T2.5.js` (`*=`) | `… (got string)` |
| `S11.13.2_A4.5_T1.1.js` (`-=`) | `… (got i32)` |
| `S11.13.2_A4.6_T1.3.js` (`<<=`) | `… (got string)` |
| `S11.13.2_A4.8_T2.5.js` (`>>>=`) | `… (got string)` |
| `S11.13.2_A4.10_T1.1.js` (`^=`) | `… (got i32)` |

Probes through the strict Prepared entry on the same tree (2026-11-19; each is
the program plus an `if (x !== …) throw 1;`):

| program | result |
| --- | --- |
| `var x; x = true; x *= true;` | refused, `got i32` |
| `var x; x = "1"; x *= "1";` | refused, `got string` |
| `var x; x = 1; x <<= "1";` | refused, `got string` |
| `var x = 2; x *= "3";` (number slot) | refused, `got string` |
| `function f() { var x; x = 2; x *= "3"; return x; }` | refused, `got string` in `f` |
| `var x, y; x = 2; y = "3"; x *= y;` (dynamic right side) | passes |
| `var x; x = "2"; x *= 3;` (string in the slot) | passes |
| the ten operators in binary form, string and boolean partners (`x = x * "2"`, `x = x - true`, …) | passes |
| `var x; x = true; x += true;` | refused later, `__ir_dyn_add has no Prepared intrinsic` |

So the gap is the right-hand side's concrete carrier, not ToNumber of a
string or boolean, which this path already has.

## Acceptance criteria

- Each program compiles through the strict Prepared entry, validates and runs
  with node's answer: the five refused numeric-compound probes above, and one
  program per operator (`*=` `/=` `%=` `-=` `<<=` `>>=` `>>>=` `&=` `^=` `|=`)
  with a string and a boolean right-hand side, in module-init and in a
  function, on a dynamic and on a number slot.
- `+=` with a string or boolean right-hand side runs with node's answer once
  Str2's dynamic `+` is on the branch; until then it refuses by name, as today.
- The 30 files, re-measured with
  `scripts/ir-census/prepared-census.mts --harness stand-in`, no longer stop at
  `compound-assign-unsupported`; the next gap of each is named in the PR.
- No regression: the whole stand-in census loses no pass (148) and moves no
  file to an earlier gap; the ordinary pipeline's selector, which asks the same
  table, claims nothing it then withdraws; JS-environment output stays
  byte-identical; no test verdict regresses.
- Code quality (CLAUDE.md, "IR path: code quality comes first"): the compound
  form and the binary form share one operand conversion (the compound arm
  reuses the binary form's boxing and ToNumber read, no second ladder);
  `compoundWriteAdmissible` stays the one table both from-ast and the selector
  ask; no arm specific to the Prepared path; `src/ir/from-ast.ts` does not
  grow, or the growth is granted in this file with a dated reason.

## Result (2026-11-19, S10, local branch `claude/7375-compound-rhs`)

The lead's decision: (b). JS-environment bytes stay identical; standalone is the target. The gate is the existing
backend capability set, not an ad-hoc boolean.

Built:

- **New capability** `native-dynamic-to-number` in `IrBackendTargetCapability` (`src/ir/backend/legality.ts`),
  ToNumber of a boxed concrete boolean / string. It is grouped with the host-free-standalone-only capabilities, so
  it is false for the JS environment's native regime (`nativeRegimeInJs`), for WASI and for gc.
- **`compoundWriteAdmissible`** takes the lane's answer as a parameter. With it, a numeric compound other than
  `+=` (a string concatenates) and `**=` (exact-exponentiation operands) admits a boolean or string right-hand
  side, on a dynamic or a number slot. All callers pass the capability: the ordinary selector's number-compound
  arm, its planned-closure operand check (`nativeDynamicToNumber`, beside its sibling lane flags) and from-ast.
- **from-ast's compound arm** reads that right-hand side with `numericReaderOperandToF64`, the binary form's
  steps: a boolean is its 0 / 1 (`booleanToNumber`, factored out of `booleansReadAsNumbers`); a string is boxed
  (`boxConcreteToDynamic`) and read with `dyn.to_number`.
- **The Prepared resolver asks the capability set** for the first time. The native dynamic lane's resolver
  (`programDynamicContracts`, `src/ir/source-dynamic-contracts.ts`) answers through the same legality predicate,
  on a standalone wasmgc profile, and only for the capabilities its dynamic contracts cover
  (`native-dynamic-to-number`). Every other capability stays unasked, so what the path admits does not move.
- **Cleanup:** the selector's `supportsBackendCapability` option spelled out the 28-member capability union
  inline; it now names `IrBackendTargetCapability`.

Out of scope, noted: `var x = 2; x *= "3"` (a typed number slot). The binary form `x = x * "3"` refuses
identically: a typed program has no dynamic carrier to box the string into. `+=` waits for Str2's dynamic `+`.

Measured:

- **Prepared:** every probe of the acceptance list runs with node's answer, except the shared typed-slot gap
  above. Covered: the ten operators × string and boolean right-hand sides, in module-init and in a function. The
  30 census files (S9's stand-in harness, this tree) all get past `compound-assign-unsupported`; each one now
  first stops at `unknown class Test262Error` (slice C).
- **JS-environment bytes,** vs an `origin/main` export: identical on 9 isolated programs (the 7 compound probes
  plus two `+=` ones), `.js` and `.ts`. The 250-file test262 sample (the 30 + 220) is identical on both targets.
- **Ordinary standalone, the programs whose bytes change:** 52 programs (13 compound shapes × right and wrong
  answer × `.js`/`.ts`) run with node's answer. 48 now take the IR path where 4 did on base. Shapes: `x = true;
  x *= true`, `x = "1"; x *= "1"`, `x <<= "1"`, `var x = 2; x *= "3"`, the function case, `x |= "1"`,
  `x %= "4"`, `x -= 1` on `"abc"`, `x /= "x"`, `x >>>= true`, `x >>= "1"`, `x &= "3"`, `x ^= true`.
- **Standalone test262 verdicts** of the 30 files (the ordinary runner, `runTest262File`): 30/30 pass on base and
  on this branch.
- **Pins moved:** `tests/es5-dynamic-compound.test.ts`. Six "refuses at selection" rows (`-= "2"`, `*= true`,
  `-= fs()`, `<<= fs()`, `-= "a" + "b"`, `<<= "a" + "b"`) are now claimed, lowered and run against node. The
  #7144 selector⇔from-ast sweep (`tests/issue-7144-operand-admissibility.test.ts`) now expects per lane. That
  sweep caught `n += s` being admitted on a number slot, a concatenation; `+=` is excluded, and the new test
  pins it.
- **Pre-existing on main, not this change:** 4 tests of the #7144 sweep fail on the base too (`'-'`, `'|'`, `'<'`
  over every pair; plain writes into each slot family).
- **Mutation check:** 4 mutants, all killed. They removed: the capability case; the Prepared resolver's answer;
  the table's capability test; the boolean arm.
- `tests/issue-7375-compound-non-numeric-rhs.test.ts`: 40 tests.
