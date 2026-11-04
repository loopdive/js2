---
id: 7223
title: "IR class shapes drop every member whose parameter or return type is `any`, so untyped JS classes never reach the IR"
status: done
sprint: current
created: 2026-11-04
updated: 2026-11-04
completed: 2026-11-04
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [3522, 2949, 7106]
assignee: "ttraenkler/c-lead"
loc-budget-allow:
  - src/codegen/index.ts
  - src/ir/select-identity.ts
---

# #7223 — `any`-typed class members in the IR class-shape projection

## Problem

The IR claim ledger (`scripts/ir-claim-ledger.mts`, test262 stride 40,
standalone, main `431abed34a`, measured 2026-11-04) shows 1,720 units, of
which only 57 take the IR body. The class buckets — `class-member-unsupported`
(228), `class-method` (34), `class-projection-unsupported` (22) — are the
largest group no other lane owns (see #6583).

A per-site count of where the class verdicts are set (instrumented ledger
run) puts **157 units at one site**: `select-identity.ts` — the member has no
single matching projected method descriptor (`exactMemberDescriptor` is
undefined). Of those 157:

| Shape | Units |
|---|---|
| static method, shape exists, no descriptor with that name | 77 (41 private, 36 public) |
| instance method / getter, shape exists, no descriptor | 31 |
| the whole class has no projected shape | 49 |

The cause is `buildIrClassShapes` in `src/codegen/index.ts`: every parameter
and return type goes through `tsTypeToClassPositionIr`, which returns `null`
for `any`. test262 is untyped JavaScript, so almost every parameter and many
returns are `any`.

- Instance methods: one unprojectable method sets `methodsOk = false` and the
  **whole class shape is dropped** (the 49 "no shape" rows).
- Static methods and accessors: the member is skipped (best effort), so the
  selector later finds no descriptor (the 77 + 31 rows).

The IR already has a dynamic value type (`{ kind: "dynamic" }`,
`src/ir/core/types.ts`).

## Implementation Plan (C lead, 2026-11-04; implement on Opus)

1. **Measure first.** Re-run the ledger on your base to confirm the counts:
   `npx tsx scripts/ir-claim-ledger.mts --stride 40 --target standalone --jobs 2 --out .tmp/ledger-base.json`
   (paths are relative to the repo root). Keep the file for the A/B.
2. **ABI check before the change.** For a method with an `any` parameter and
   an `any` return, find the Wasm signature the legacy class body registers
   (funcMap / `class-bodies.ts`) and the signature the IR lowering would give a
   `dynamic` parameter and return in that position (integration's class-method
   ABI derivation). They must be identical, because IR and legacy bodies of the
   same class share callers. If they differ, the change below must make the IR
   side produce the legacy signature, or this plan STOPs — report back with
   the two signatures.
3. **Map `any` in class positions.** In `tsTypeToClassPositionIr`, map
   `TypeFlags.Any` (and `Unknown`, if its legacy ABI is the same) to
   `{ kind: "dynamic" }`. Do not change the mapping for typed positions.
   Keep the change local to class-position projection; free functions have
   their own path and are out of scope here.
4. **Downstream consumers.** `projectedClassShapes` is also read by legacy
   codegen. Find every reader of the shape descriptors and check that a
   `dynamic` param/return does not change legacy output. Gate it if it would.
5. **Selector and from-ast.** Check that the selector and `from-ast.ts` accept
   a `dynamic` param/return on class members (method calls, `this.m(x)`,
   static calls, getters). Where they refuse, extend them with the existing
   dynamic operations (`dyn.*`) rather than new instructions. If a refusal
   needs a new dynamic instruction, leave that member on legacy and list it.
6. **Never worse than legacy.** Every newly IR-claimed unit must produce the
   same observable result as the legacy body. Run the equivalence gate and the
   class-related equivalence files; probe a sample of test262 class files
   (language/statements/class, language/expressions/class, built-ins with
   classes) with the test262 runner on base and head and compare verdicts.

## Acceptance criteria

- Ledger A/B (same stride, same target) in the PR body: `class-member-unsupported`
  and `class-projection-unsupported` drop; IR-routed units (ir + both) rise;
  no new `invariant` rows; `compileOk` does not fall.
- Typed programs (playground examples, benchmarks, equivalence sources) are
  byte-identical on gc, standalone and wasi.
- A sample of test262 class files: no test that passes on base fails on head.
- Test: `tests/equivalence/issue-7223-ir-class-shape-any.test.ts` — untyped
  classes (instance, static, private, getter/setter, subclass) compiled with
  IR telemetry, asserting both the IR route and the node result.

## Result (Opus implementation, 2026-11-04)

### Step 2 — ABI parity: no STOP

For `m(x) { return x; }` in an untyped class, legacy `class-bodies.ts`
registers `(param (ref null $C) externref) (result externref)` on standalone,
wasi and gc (probe WAT, base `431abed34a`): every `any` position goes through
`resolveWasmType`'s `Any | Unknown` branch. The IR `dynamic` lowers through
`resolveIrDynamicCarrierType` — `externref` off the fast lane,
`ref_null $AnyValue` on it — which is the same branch's output in both modes.
The #1370 class-method parity guard (`integration.ts`, an invariant on
mismatch) never fired: 0 `invariant` rows in the ledger, 0
`[abi-parity-debug]` lines with `JS2WASM_DEBUG_ABI_PARITY=1`.

### What changed

1. `tsTypeToClassPositionIr` maps `Any | Unknown` to `irDynamic()`. Typed
   positions keep their mapping.
2. `irFieldTypeMatchesLegacyValType` accepts a `dynamic` field only when the
   legacy struct slot is exactly the dynamic carrier
   (`irDynamicCarrierMatchesSlot`, `src/codegen/ir-class-shapes.ts`; a pure
   read that never registers `$AnyValue`). An untyped field (`f;`, `#o;`) no
   longer drops the whole class shape.
3. Selector: a class member's projected descriptor is now its ABI evidence
   for the `dynamic` positions only (`dynamicDescriptorAbiEvidence`,
   `src/ir/class-accessor-safety.ts`). Class members have no lattice entry, so
   `resolveParamType` / `resolveReturnType` refused every untyped position.
   The dynamic positions still pass the existing #2949 move-only scan, so a
   member that does more than move its dynamic values is refused before the
   claim, as free functions are. A member with no dynamic position gets no
   evidence, so typed classes take exactly the old path.

Step 4: the shape descriptors are read only by IR planning
(`resolvePositionType`, imported-call planning, the selector). The typed-program
A/B below shows legacy output is unchanged.

### Measurements

Ledger, `--stride 40 --target standalone --jobs 2` (base re-measured on
`431abed34a`; it matches the earlier `ledger-standalone.json` exactly):

| | base | head |
|---|---|---|
| IR-routed (ir + both) | 57 (32 + 25) | **62** (37 + 25) |
| legacy | 1626 | 1621 |
| class-member emitted | 15 | 20 |
| `select:class-member-unsupported` | 243 | 239 |
| `select:class-projection-unsupported` | 22 | 17 |
| `select:param-type-not-resolvable` | 29 | 31 |
| `select:return-type-not-resolvable` | 8 | 9 |
| `select:body-shape-rejected` | 1105 | 1106 |
| invariant | 0 | 0 |
| compileOk / compileFail / threw | 1081 / 240 / 19 | 1081 / 240 / 19 |

The gain is smaller than the 157-unit site count suggested. A per-member
dump of the remaining `class-member-unsupported` rows at that site shows why:

- most are **class expressions** (`var C = class { … }`), which
  `buildIrClassShapes` never projects (nested `<anonymous-class>` units);
- most of the "static, shape exists" rows are `static async`, `static *`,
  `static async *` methods, or have destructuring/default parameters. None of
  these project, by design;
- **private static** methods (`static #m(…)`) are skipped by the static
  projection's `ts.isIdentifier(member.name)` check, and their test262 bodies
  read and write static private fields through `this`;
- getters such as `get method() { return this.#method; }` return a function
  value, which has no class-position projection.

Members that now pass the descriptor check but are still refused (they move
from `class-member-unsupported` to `param/return-type-not-resolvable`) fail
the move-only scan on uses it does not admit yet. None needs a new dynamic
instruction. They are planner work, left on legacy:

- `this.m(x)` / `this.#p(x)` / `C.s(x)` with a dynamic argument (the scan
  checks direct-call arguments only against top-level functions);
- a dynamic-returning static call as a return value (`return C.q(1)`);
- reads and stores of dynamic fields through `this` (`return this.a`,
  `this.a = v`);
- constructors with untyped parameters (no ctor evidence: a constructor body
  that stores its parameter is the same field-store shape).

The measured typed corpus is byte-identical. sha256 of the binary, base copy vs head,
gc + standalone + wasi: playground examples, `examples/`, `benchmarks/` and
every `export`-bearing template in `tests/equivalence/*.test.ts`, 1,738
sources and 5,214 records. The only rows that differ are the three lanes of
one source in this issue's own new test (the untyped subclass case).

test262 class sample: 326 files (every 30th of
`language/{statements,expressions}/class`, every 8th class-bearing
`built-ins` file, plus the raw-compile route-diff files), run through
`scripts/run-test262-paths.mts` on a base tree and on head:

| lane | base | head | head-only non-pass |
|---|---|---|---|
| standalone | 260 pass / 57 fail / 9 CE | 260 / 57 / 9 | 0 |
| gc | 220 pass / 96 fail / 10 CE | 220 / 96 / 10 | 0 |

Test: `tests/equivalence/issue-7223-ir-class-shape-any.test.ts`. It has 18
cases (6 shapes × standalone/wasi/gc), each asserting the node result and the
IR route of the listed members. On base 15 of them fail. The setter case
already routed IR there through the exact-accessor path.

Not every typed program is byte-identical. A typed class with one `any`
member or field now gets a shape. Its `any` methods, and top-level functions
that use the class, can then move to the IR, and the bytes change. The PR
review measured such programs and found their results correct. The byte A/B
above holds for the measured corpus.

### Round 2: `+` on dynamic values (review of `d0266a7742`)

The review found that members newly routed to the IR that do `x + y` on
untyped values went through `__ir_dyn_add`, and it was wrong:

- it ignored a user `valueOf` (`c.add({valueOf(){return 4}}, 1)` gave
  `"[object Object]1"`);
- it did not throw a TypeError for a Symbol operand.

Plain IR functions (`function f(x, y) { return x + y; }`) already had the
same bug on base.

The fix is in `ensureDynamicAdd` (`src/codegen/dyn-ops.ts`). The
externref-carrier `__ir_dyn_add` is now a helper whose body is built by
`emitAnyAddFromExternTemps`, the same §13.15.3 dispatch binary `+` uses
(#7214). That dispatch does ToPrimitive(default): user `valueOf` before
`toString`, and `Symbol.toPrimitive`. A Symbol operand throws TypeError, and
then it concatenates or adds. Its old body, honest from-extern →
`__any_add` → to-extern, is gone; this is no third implementation.

- **`__any_add` itself is unchanged.** It works on the `$AnyValue`
  representation, not on externref; the externref dispatch above cannot
  replace it.
- **Fast lane:** `__ir_dyn_add` still aliases `__any_add` there. No default
  target sets `fast`, and the review found the fast lane does not claim these
  members.
- **Other `__any_add` callers are untouched:** `binary-ops.ts` (fast `any`
  arithmetic) and `implicit-global-binding.ts`.
- **Callers affected:** both are in `src/ir/from-ast.ts`. One is binary `+`
  with a dynamic operand. The other is `+=` on a dynamic slot (#7106
  Stage 4, the assert.js `message +=`).

The test now has a `+` matrix: the review's four cases, plus strings,
null/undefined, `-0`, Date and `Symbol.toPrimitive`. It runs on class
members (`C_add`, `C_a1`, static `C_sa`) and on a plain function `f`, all
IR-routed, on all 3 lanes, and is checked against node. Lane results:

- **standalone and gc:** all checks pass.
- **wasi:** the two `Symbol.toPrimitive` checks are skipped. The legacy body
  already gets them wrong on wasi on base, so the gap predates this PR.

Round-2 measurements, base = merge-base `a8e470a395`:

- **Ledger:** unchanged from round 1. IR-routed goes 57 → 62, 0 invariants,
  and `compileOk` stays at 1081.
- **test262 `+` sample, standalone:** 418 files. They are all of
  `language/expressions/addition` and `built-ins/Symbol/toPrimitive`, every
  3rd file of `template-literal`, every 6th of `compound-assignment`, every
  12th of `built-ins/Date`, every 15th of `built-ins/String`, and every 60th
  of the class directories. Base and head both score 376 pass / 37 fail /
  5 compile errors, with identical non-pass lists.
- **Byte corpus:** 1,742 sources / 5,226 records on gc, standalone and wasi.
  The only sources whose bytes differ, beyond this issue's own test, are two
  untyped/`any` programs that already used IR dynamic `+` on base:
  `issue-7001-ir-string-result-native-strings` #0 (`addOne(x) { return x + 1; }`)
  and `typeof-narrowing` #3 (`x + " world"`, with `x: any`). Their bytes
  change because the helper body is new. Both test files pass (27 tests).

### Growth grants (2026-11-04)

- `src/codegen/index.ts` +4: the `any → dynamic` mapping, the dynamic field
  arm and its import. Both edits have to sit in the two functions that live
  there; the helper went to `ir-class-shapes.ts`.
- `src/ir/select-identity.ts` +1: the evidence import. The evidence function
  itself lives in `class-accessor-safety.ts`.
