---
id: 6798
title: "codegen: probe-backed semantic divergences — `typeof (class {})` → 'object', `typeof y` before `let y` → 'number', `yield*` return value → null, `String(false && f())` → '0', `type i32` saturates while `|0` wraps, resolve-stage catch cannot tell demote from bug"
status: done
sprint: Backlog
created: 2026-09-30
updated: 2026-10-02
completed: 2026-10-02
priority: medium
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: multi
goal: core-semantics
related: [6420, 4529, 2035, 1691, 4044, 1236, 2715]
requested_by: ttraenkler/claude-review
assignee: "ttraenkler/claude-dev-6798"
branch: "claude/issue-6798-misc-semantics"
origin: "2026-09-30 codebase review (plan/agent-context/claude-codebase-review-2026-09-30.md) — MEDIUM cluster"
loc-budget-allow:
  # 2026-10-02 resolve-stage-catch: typed demote helper + classify the catch (+4)
  - src/codegen/index.ts
  # 2026-10-02 typeof-class (+2) / yield-star-return (+20): class-object typeof, yield* completion (+22)
  - src/runtime.ts
  # 2026-10-02 typeof-tdz: one TDZ-guard call before each static typeof fold (+2)
  - src/codegen/typeof-delete.ts
  # 2026-10-02 yield-star-return: host-lane completion guards in the native planner (+7)
  - src/codegen/generators-native.ts
  # 2026-10-02 i32-saturate: the f64 -> i32 arm picks ToInt32 for an int32-branded destination (+2)
  - src/codegen/type-coercion.ts
func-budget-allow:
  # 2026-10-02 typeof-class (+2) / yield-star-return (+14): arms live inside resolveImport
  - src/runtime.ts::resolveImport
  # 2026-10-02 typeof-tdz: the TDZ guard before the fold (+1 each)
  - src/codegen/typeof-delete.ts::compileTypeofExpression
  - src/codegen/typeof-delete.ts::compileTypeofComparison
  # 2026-10-02 yield-star-return: the native planner's host-lane completion guards (+7)
  - src/codegen/generators-native.ts::buildNativeGeneratorPlan
  # 2026-10-02 i32-saturate: the int32-brand branch in the f64 -> i32 arm (+1)
  - src/codegen/type-coercion.ts::coerceType
---

# #6798 — six smaller divergences, each reproduced on the JS-host lane (2026-09-30)

Each row is an independent slice; claim them as `6798:<slug>` slices.

| slice | source | wasm | JS | where to look |
|---|---|---|---|---|
| `typeof-class` | `typeof (class {})` | `"object"` | `"function"` | host-lane `typeof` on a class value; #6420 fixed the standalone lane only |
| `typeof-tdz` | `(() => { const t = typeof y; let y = 1; return t })()` | `"number"` | throws `ReferenceError` | TDZ check exists for plain reads (verified) but `typeof` takes the static-type shortcut |
| `yield-star-return` | `function* inner() { yield 1; return "r" } function* outer() { const rv = yield* inner(); yield "o:" + rv }` | `"o:null"` | `"o:r"` | `generators-native.ts` delegation result; related #2035/#1691 |
| `string-bool-union` | `String(false && f())`, `String(true \|\| f())` | `"0"`, `"1"` | `"false"`, `"true"` | a `boolean \| number` union carried as f64 loses the tag at the ToString site |
| `i32-saturate` | `type i32 = number; fromNum(2147483648)` / `NaN` / `i32 / 0` / `% 0` / `-(-2^31)` | `2147483647` / `0` / `2147483647` / `0` / wraps | `\|0` semantics: `-2147483648` / `0` / … | `src/codegen/type-coercion.ts:1057, 1062, 1143, 1176` use `i32.trunc_sat_f64_s`; opt-in feature but silent and inconsistent with the verified ToInt32 behaviour of `\|0`; #4044 notes the sanitizer that would catch this is not required |
| `resolve-stage-catch` | any throw inside the IR resolve stage | warning `type-resolution-unsupported` | — | `src/codegen/index.ts:3357-3391` catches every throw and labels it `unsupported`; designed sites throw bare `Error` (`resolvePositionType`, `:1274/1330/1395/1409/1411`), so a `TypeError` from a real bug is indistinguishable; build/verify/lower stages already use `classifyIrFailure` correctly |

## Correction per slice

- `typeof-class`: port #6420's class-value tag check to the host lane.
- `typeof-tdz`: `typeof <identifier>` on a `let`/`const` binding in its TDZ
  must go through the same TDZ guard as a plain read (the guard is there;
  route the `typeof` operand through it).
- `yield-star-return`: propagate the delegate's `{done: true, value}` value as
  the `yield*` expression result.
- `string-bool-union`: carry the boolean tag (box, or a 2-bit tagged f64
  convention already used elsewhere) through `&&`/`||` when the static type
  is a boolean/number union; at minimum, make ToString of a union operand go
  through the any-box path.
- `i32-saturate`: document the choice in `docs/` **and** make it consistent:
  either `type i32` means ToInt32 (wrap, matches `|0`) or the compiler
  refuses out-of-range literals and traps at runtime. Pick wrap (cheaper to
  reason about, matches the standalone typed-array stores per #2715).
- `resolve-stage-catch`: throw `IrUnsupportedError` at the designed sites,
  classify everything else as `unexpected-internal-throw` (already an
  invariant class in `src/ir/outcomes.ts:96-120`).

## Acceptance

- Each row's wasm column equals the JS column; one regression test per slice
  under `tests/equivalence/`.
- `resolve-stage-catch`: a test injects a `TypeError` into `resolvePositionType`
  and asserts a hard compile error, not a warning.

## Implementation Plan

One commit per slice, cheapest first (branch `claude/issue-6798-misc-semantics`).
Decisions taken up front: `i32-saturate` picks WRAP (ToInt32, same as `| 0`);
`resolve-stage-catch` types the designed throws and hard-errors the rest;
`string-bool-union` takes the minimum fix (box at the value's consumer), not a
tagged-f64 convention.

1. **resolve-stage-catch** (`src/codegen/index.ts`): the seven throws in
   `resolvePositionType` go through a new `unresolvablePosition()` that throws
   `IrUnsupportedError("type-resolution-unsupported", "resolve")`. The
   `planIrOverlay` resolve catch now calls `classifyIrFailure(e, "resolve")`:
   a typed demote keeps the #1921 warning; any other throw is the
   `unexpected-internal-throw` invariant, recorded as such and reported as a
   `Codegen error:` (severity error). `latticeToIr`'s guarded throw and the
   class-shape identity invariants stay untyped on purpose.
2. **typeof-class** (`src/runtime.ts`): the host `__typeof` import and the
   `typeof_check` intent recognise a class-object singleton through the
   `__register_class_object` registry the runtime already keeps (the host twin
   of #6420's identity check). Standalone was already correct.
3. **typeof-tdz** (`src/codegen/typeof-static-folds.ts`,
   `src/codegen/typeof-delete.ts`): new `emitTypeofTdzGuard` emits the same TDZ
   guard an identifier read emits (local flag via `analyzeTdzAccess` /
   `emitLocalTdzCheck` / `emitStaticTdzThrow`, else the module flag via
   `moduleTdzGlobalIndexForIdentifier` / `emitTdzCheckAtGlobal`) right before
   the static fold in `compileTypeofExpression` and in the
   `compileTypeofComparison` ladder.
4. **yield-star-return**:
   - eager host model: `__gen_yield_star` steps the delegate by hand and keeps
     its terminal `{done: true, value}` per buffer; a new
     `__gen_yield_star_result` (read-and-clear) supplies it to any
     non-statement `yield*` in `compileYieldExpression`
     (`src/codegen/expressions/misc.ts`);
   - native planner (`src/codegen/generators-native.ts`): `return yield* x`
     takes the delegation-completion arm on every lane (the host lane compiled
     it through the plain return arm without suspending), and a bound
     completion whose type is neither number nor any/unknown stays on the
     eager path on the host lane (its f64 carrier slot turned a string into NaN).
5. **string-bool-union** (`src/codegen/expressions/logical-ops.ts`):
   `logicalMergeType` keeps the f64 merge for a boolean/number `&&`/`||`
   except where the value is stringified (`String()`, a template span, `+`
   with a string operand) or an externref is expected; there the merge is an
   externref with each arm boxed by its own type.
6. **i32-saturate**: an `int32` brand on the i32 `ValType`
   (`src/wasm/model/instructions.ts`), set on the `i32` entry of
   `NATIVE_TYPE_MAP` (`src/codegen/native-type-annotations.ts`, whose contract
   comment now states ToInt32), selects `emitToInt32` (the `| 0` lowering,
   `binary-ops.ts`) in `coerceType`'s f64 → i32 arm; the generic arm keeps
   `i32.trunc_sat_f64_s` (index computations need saturation). The brand is
   part of `funcTypeKey` / `sameValTypes` (`src/wasm/physical/function-types.ts`)
   so an i32-annotated signature is never deduplicated onto a plain
   `(i32)->i32` type and lose it (that is what kept standalone saturating).
   Documented in `docs/faq.md`.

## Resolution

Probe harness: `.tmp/probe.mts` (JS host) and a `target: "standalone"` twin;
BEFORE is the same probe on the pre-change sources.

| slice | probe | before | after |
|---|---|---|---|
| `resolve-stage-catch` | `TypeError` injected into `resolvePositionType` (mocked `irClosureSignatureFromFunctionTypeNode`) | warning, compile succeeds | hard `Codegen error: IR path: could not resolve types for apply: …`; the designed `null` answer is still a warning |
| `typeof-class` | `typeof x` for `x: any = class {}`, a class through a parameter / `unknown` / array element | `"object"` (bitmask host 8, standalone 15) | `"function"` (host 15, standalone 15) |
| `typeof-tdz` | `(() => { const t = typeof y; let y = 1; return t })()`, also `typeof z === "number"` before `const z` | `"number"`, no throw (host and standalone 000) | `ReferenceError` (both lanes 110) |
| `yield-star-return` | `"o:" + (yield* inner())`, `yield (yield* inner())`, `return yield* inner()`, `const rv: string = yield* inner()` | `"o:null"`, `""`, `undefined`, `rv.length` 0 | `"o:r"`, `"r"`, `"r"`, 1 (the issue's own `const rv = yield* inner()` form was already right at HEAD) |
| `string-bool-union` | `String(false && f())`, `String(true \|\| f())`, template / `+ ""` / `any` forms | `"0"`, `"1"` (bitmask host 4, standalone 4) | `"false"`, `"true"` (host 127, standalone 63) |
| `i32-saturate` | 39 checks of `i32` destinations against `v \| 0` (init, assignment, parameter, field, return, `/ 0`, `-(-2**31)`, `65536 * 65536`) | 13/39 agree (both lanes); `fromNum(2**31)` = 2147483647 | 39/39 (both lanes); `fromNum(2**31)` = -2147483648, `7 / 0` = 0 |

Tests: `tests/equivalence/issue-6798-misc-semantics.test.ts`, one `it` per
slice (the i32 one checks both lanes against `| 0`, since erased-type JS is not
the oracle for an opt-in that changes semantics). Each `it` was run against the
pre-change sources and fails there.

Left out, measured, not fixed here:

- `typeof-class`: `{ k: class {} }` stores `null` in the property (the class
  expression is lost when stored in an object literal) — a storage bug, not
  `typeof`.
- `typeof-tdz`: a module-level `let` read in its TDZ from a closure throws a
  non-`ReferenceError` (null payload) on the host lane — for the plain read as
  much as for `typeof`, which now matches the read.
- `yield-star-return`: an `any`-typed `var r = yield* hostIterable` on an f64
  carrier keeps its f64 slot (#1691's test pins the native machine there), so a
  non-numeric completion would read NaN.
- `string-bool-union`: a declared `boolean | number` variable and a `c ? b : n`
  stored to `any` still lose the tag (the union's f64 carrier — a
  representation change across every union position); in standalone an
  `any`-typed local holding a boxed boolean still stringifies wrongly.
- `i32-saturate`: the four `type-coercion.ts` lines the issue cites (now
  ~1058/1063/1144/1177) are the host-array → `__vec_i32` materialisation
  (element unbox and length), not the `type i32` scalar path the probe
  exercises; they stay saturating because that vec type is shared with
  `boolean[]` and fast-mode `number[]`. `u8`/`u16`/`u32`/`i8`/`i16` aliases are
  unchanged.

Pre-existing failures seen while running neighbouring suites, identical on
`origin/main`: `issue-4470` (1), `issue-4486` (1), `issue-5166` (3),
`issue-4755` (3), `logical-conditional-identity` (3),
`issue-3518-logical-vector-lowering` (1), `logical-assignment` (11),
`native-i32-type` (8) and `i32-loop-inference` (10) (both: the test harness
passes no `string_constants`), `issue-2173-yieldstar-generic-iterable` (9) and
`issue-2864-standalone-generator-carrier` (2).

Gates (after merging `origin/main` fcf4b188d0, all exit 0): `check-loc-budget`
and `check-func-budget` (default base and `LOC_GATE_BASE=origin/main`),
`check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`,
`typecheck`, `format:check`, `check-compiler-boundaries --mode inventory` (no
unclassified module), the 18-gate quality loop (`check:ir-dialect` …
`check:verdict-oracle`, `lint`), `check:ir-fallbacks` (no increase),
`test:guard` (21 files / 261 tests), and the slice test file with the typeof,
logical, yield-star, native-i32 and #3519 outcome suites (14 files / 127 tests).
