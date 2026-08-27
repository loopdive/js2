---
id: 3481
title: "bigint/symbol coercion: value-substrate ToPrimitive/ToNumeric fidelity (host ~164 fails) — architect-spec hand-off"
status: in-progress
assignee: ttraenkler/opus-3481
created: 2026-07-20
priority: medium
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
goal: test262-conformance
model: opus
sprint: current
horizon: xl
related: [3422, 3328]
loc-budget-allow:
  - src/codegen/binary-ops.ts
  - src/runtime.ts
---

# #3481 — bigint/symbol coercion fidelity (value substrate)

**HAND-OFF ISSUE — needs a senior-dev + architect-spec, NOT a developer quick-fix.**
Overlaps the toPrimitive-nominal-struct epic (see MEMORY: project_2358_toprimitive_*,
project_toprimitive_nominal_struct_gap). Verified via verify-first while working #3422;
do not fold into a throw-class fix (that was the initial mis-framing — the arithmetic
`+`/coercion operators already throw real `instanceof TypeError`).

## Scope (host oracle-v8 baseline 2026-07-19, ~164 fails; Temporal excluded)

Two sub-families, both rooted in the value substrate's ToPrimitive/ToNumeric path,
NOT in throw-class (the delete/read-only bare-string bug fixed by #3422/#3471):

### A. Wrong-coercion (~106): we throw the CORRECT TypeError but shouldn't throw at all
The thrown errors are already real `instanceof TypeError`; the bug is that we coerce
Symbol/BigInt to number where the spec does something else. Repros:
- `Object(2n) * 2n` → we throw "Cannot mix BigInt and other types" because we do NOT
  ToPrimitive-unwrap the BigInt **wrapper object** to its primitive `2n` before the
  multiply (should be `4n`). (`language/expressions/multiplication/bigint-wrapped-values.js`)
- `Array[Symbol.species]` descriptor read / `Map.prototype[Symbol.iterator]`
  verifyProperty → a Symbol key gets coerced to a number during normal execution
  ("Cannot convert a Symbol value to a number in __module_init / isWritable").
- Signatures: "Cannot convert a Symbol value to a number" ×79, "Cannot mix BigInt and
  other types" ×27.

### B. Missing-throw (~26): ToPrimitive result not re-validated
An object whose `@@toPrimitive`/`valueOf` returns a Symbol/BigInt, passed where a
string/integer/index is expected — we call ToPrimitive, get the Symbol/BigInt back, and
do NOT re-validate it on the subsequent ToString/ToInteger/ToIndex, so no throw occurs.
- ToPrimitive-tangled (~16, same root as A): `String.prototype.indexOf`
  searchstring/position, `Error`/`AggregateError`/`SuppressedError`/`NativeError` message
  ToString, `DataView.getBigInt64` / `BigInt.asUintN` ToIndex, `ArrayBuffer` length.
  The runtime `__extern_to_string_default` DOES re-check Symbol (runtime.ts ~8722-8736),
  but the inlined codegen coercions (string-ops.ts `$__any_to_string`) and the
  ToInteger/ToIndex paths do not — route them through the checking helper.
- Genuinely isolated (~10, scattered across ~6 sites — could be split off as small
  independent fixes if desired): `1n >>> 1n` (BigInt has no `>>>`, must throw TypeError);
  `(x).toFixed(sym)` throws RangeError **before** the ToNumber TypeError (coercion-order
  bug — coerce fractionDigits before range-validating); `[].sort(Symbol())` comparefn
  IsCallable validation; `ArrayBuffer.prototype.slice` species-not-constructor;
  `String.fromCharCode(1n)` ToNumber(BigInt).

## Why hard / hand-off
The dominant A + B-tangled clusters require correct ToPrimitive/ToNumeric on nominal
struct wrappers (`Object(2n)`, boxed Symbol) and Symbol-keyed access — the same substrate
as the toPrimitive-nominal-struct work. Regression-prone; needs an architect spec that
sequences: (1) wrapper-object ToPrimitive unwrap, (2) ToString/ToInteger/ToIndex Symbol/
BigInt re-check on ToPrimitive results, (3) the isolated operator/arg-validation fixes.

## Acceptance
- `Object(2n) * 2n === 4n`; Symbol-keyed descriptor reads don't spuriously coerce.
- ToPrimitive returning a Symbol/BigInt into a String/Integer/Index context throws a real
  `instanceof TypeError` at the coercion site.
- The ~10 isolated cases (`>>>`, toFixed order, sort comparefn, species, fromCharCode) throw.
- Zero regression on the arithmetic-coercion cases that already pass.

## Implementation Notes — senior-dev, 2026-07-21 (branch `issue-3481-value-rep-coercion`)

**Verify-first disproved the "bigint-wrapper is a tight slice" premise. This IS the
epic the issue predicted — there is no single-PR slice that flips a whole host
test262 file.** What landed on the branch is a correct, low-regression *prerequisite*,
not a self-merge. Escalated to the tech lead for sequencing (do NOT enqueue).

### What the branch implements (step 1 of the issue's own sequence — "wrapper-object ToPrimitive unwrap")
A new internal host import `__host_bigint_binop(op:i32, a:externref, b:externref)->externref`
(mirrors the existing `host_add`/`host_compare`/`host_eq` precedent — compiler-emitted,
not user-facing, so the host-import allowlist gate does not bite):
- `src/index.ts` — `ImportIntent` union: `{ type: "host_bigint_binop" }`.
- `src/compiler/import-manifest.ts` — name→intent mapping.
- `src/runtime.ts` (`case "host_bigint_binop"`) — struct operands ToPrimitive-reduced via
  `_toPrimitiveSync` (hint `default` for `+`, `number` otherwise), then JS applies the
  operator → ToNumeric + the mix-TypeError check + BigInt arithmetic + `>>>`-on-BigInt
  throw, all for free. i32 opcode is a private ABI shared with `bigIntHostBinopOpcode`.
- `src/codegen/binary-ops.ts` — in the mixed-BigInt arithmetic block, BEFORE the
  `emitThrowTypeError("Cannot mix BigInt…")`, delegate to the host binop when the
  **non-bigint operand is `Any|Unknown|Object`** and mode is JS-host + default
  (`anyValueTypeIdx < 0`). Standalone/WASI keeps the throw (no JS host). Gate includes
  `Object` (not just `Any`) deliberately — object-literal operands are `TypeFlags.Object`,
  and broadening is safe *because* the binop pre-reduces structs via `_toPrimitiveSync`
  (the #1374 regression was raw `a<b` on opaque structs with NO pre-reduction).

**Regression surface = zero on passing tests**: the delegated arm replaces a path that
*currently always throws at runtime*. Only outcomes are throw→compute (fix) or
TypeError-msgA→TypeError-msgB (benign — `assert.throws(TypeError)` still passes).
Empirically verified: `Object(2n)*2n=4n`, `2n*Object(2n)=4n`, `-`/`+`/`**`/`|`/`>>` on
`Object(bigint)` correct; `(5 as any)*2n` and `2n*(3 as number)` still throw TypeError;
`Object(4n) >>> 1n` throws; plain `2n*2n`/`5n+3n`/`1n<<4n` untouched.

### Why it flips 0 whole host files ALONE (inferred from assertion-path analysis)
test262 aborts on the FIRST failed `assert.*`, and every failing FILE bundles the
wrapper case with an assertion this slice does NOT cover:
- **`.../bigint-wrapped-values.js` (13 files)** — assertion #3 (before the passing
  `Object(2n)` rows finish the file) is `{[Symbol.toPrimitive](){return 2n}} * 2n`, then
  `{valueOf}`/`{toString}`. These are WasmGC structs; two substrate gaps block them:
  - **Gap A** — a compiled `valueOf`/`toString` dispatched via a method-call-through-`any`
    loses the BigInt brand: it returns `2` (number), not `2n`, so `2 * 2n` throws the JS
    mix error. (A *direct* closure return preserves the brand — the loss is in the
    method-via-any / `__call_fn_method_0` return boxing.)
  - **Gap B** — an object-literal computed `[Symbol.toPrimitive]` is NOT dispatched by
    `_hostToPrimitive` at all (no sidecar / no `__call_@@toPrimitive` for object literals)
    → falls to `"[object Object]"`.
  Both are `_hostToPrimitive` / nominal-struct ToPrimitive substrate — **the same lane as
  the active `issue-3328-capturing-closure-toprimitive-dispatch` worktree.** Not touched
  here to avoid duplicate-work collision (lane-partition rule). Once #3328's dispatch
  lands, this binop is what routes the reduced primitive back into a BigInt op → the
  wrapped-values files flip. The binop is a genuine dependency of that flip, not redundant.
- **`.../bigint-and-number.js` (9 files)** — assertions like `Object(1n) * 1` and
  `Object(1n) * Object(1)` have **neither** operand statically bigint, so they never enter
  the mixed-BigInt block; they need general `any`-arithmetic host delegation, which changes
  the result type of ALL `any * number` from f64→externref (blast radius across every
  any-arithmetic site + the AnyValue fast-mode ABI) — explicitly NOT a low-regression first
  slice (#1374 lesson). Deferred.

### Remaining slices (for the architect/PO to sequence)
1. **Gap A + Gap B in `_hostToPrimitive`** (coordinate with #3328) — unblocks the 13
   `bigint-wrapped-values.js` files given the binop above.
2. **General `any`-arithmetic host delegation** (multiplicative/bitwise) — unblocks the 9
   `bigint-and-number.js` files; needs its own regression budget (result-type f64→externref).
3. **Symbol ×79 cluster** — the larger, unexplored lever (localized property-access Symbol-key
   coercion per the scope notes). Needs a short feasibility probe (single coercion site vs
   shared substrate) before commit; likely the better flip-positive host win this session,
   but a different subsystem from the bigint work here.
4. Family-B ToString/ToInteger/ToIndex Symbol/BigInt re-check on ToPrimitive results, and the
   isolated operator/arg-validation cases.

## Slice record — 2026-08-27, senior-dev (branch `claude/issue-3481-toprimitive-unwrap`)

**Step 1 of the issue's own sequence ("wrapper-object ToPrimitive unwrap") is now
COMPLETE and the `bigint-wrapped-values.js` family flips.** The 2026-07-21 branch
landed as PR #3458 (commit `25c596d21c`) — that part is on `main` and its Gap-A
prediction has since been resolved by other work. What was left was **Gap B alone**,
and it turned out to be one missing probe, not a substrate rewrite.

### What was actually still broken (re-measured on main, 2026-08-27)

Of the three shapes the 2026-07-21 notes flagged, only one still failed:

| shape | today |
| --- | --- |
| `Object(2n) * 2n`, `2n * Object(2n)` | already correct (the #3458 binop) |
| `{ valueOf() { return 2n } } * 2n`, same for `toString` | already correct — **Gap A is gone** |
| `{ [Symbol.toPrimitive]: function () { return 2n } } * 2n` | **still threw** "Cannot mix BigInt and other types" |

So every `bigint-wrapped-values.js` file was failing at assertion #3, on Gap B only.

### Root cause

`@@toPrimitive` reaches the runtime in **three physically different shapes**, and
`_hostToPrimitive` probed only two:

1. dynamic assignment `o[Symbol.toPrimitive] = fn` → the **sidecar** slot;
2. a METHOD body `[Symbol.toPrimitive](hint) {…}` → the `__call_@@toPrimitive`
   struct-method export (#1716);
3. an object-literal computed PROPERTY `{ [Symbol.toPrimitive]: fn }` → the closure
   lives in a **struct FIELD** named `@@toPrimitive`, and codegen emits only the
   shape-dispatched accessor `__sget_@@toPrimitive` for it (verified: for that
   literal the module exports `__sget_@@toPrimitive` / `__sset_@@toPrimitive` and
   `__struct_field_names` answers `@@toPrimitive`, with **no** `__call_@@toPrimitive`).

Shape 3 hit none of the probes, so the walker fell through to its `"[object Object]"`
sentinel — and `__host_bigint_binop` then multiplied a **string** by a BigInt, which is
why the symptom read as a mix-TypeError rather than a missing-method one.

### Fix (`src/runtime.ts` only, +121 LOC, inside the granted `loc-budget-allow`)

Probe `__sget_@@toPrimitive` at §7.1.1 **step 2** (before OrdinaryToPrimitive),
mirroring the `__sget_${mName}` fallback the valueOf/toString loop below it already
relies on. Two guards keep it from over-firing:

- `__shas_@@toPrimitive` (#2847) confirms **own presence**, so a conditionally
  initialized default slot is never mistaken for a user-supplied method;
- the new `_callExoticToPrimitiveSlot` returns the `_PRIM_ABSENT` sentinel when no
  dispatcher can run the closure, so the walker keeps its pre-slice behaviour rather
  than inventing a failure. Both spec violations now throw a real TypeError: a
  non-callable slot (step 2d) and a method returning an object (step 5).

Runtime-only, JS-host lane. Standalone/WASI has no host binop and is untouched.

### Measured deltas (this worktree, `--isolate`, one child process per row)

Base and fix were measured with the file-copy A/B pattern — `git show HEAD:src/runtime.ts`
captured before the first edit — so both sides ran on the same harness.

**Cohort A — the acceptance bar (14 rows):** the 12
`language/expressions/*/bigint-wrapped-values.js` files plus the two
`built-ins/BigInt/as{Int,Uint}N/bigint-tobigint-wrapped-values.js` twins.

| | pass | fail |
| --- | --- | --- |
| before | 3 | 11 |
| after | **14** | **0** |

**Cohort B — the full blast radius (293 rows):** every counted test262 file whose
source mentions `Symbol.toPrimitive`. This is the *complete* reachable set, not a
sample: a test can only build an own-`@@toPrimitive` struct if that identifier is in
its own source or in a harness file it includes, and only two harness files use it —
`typeCoercion.js`, which **no** test includes, and `testIntl.js`, included by 175
tests that are **all** `intl402/` (absent from the baseline entirely, i.e. not run or
counted).

| | pass | non-pass | skip |
| --- | --- | --- | --- |
| before | 94 | 188 | 11 |
| after | **110** | **172** | 11 |

**+16 fixed, 0 pass→fail.** The 16: the 11 `bigint-wrapped-values.js` files from
cohort A, plus `built-ins/BigInt/constructor-coercion.js`,
`built-ins/String/prototype/indexOf/searchstring-tostring-{bigint,errors}.js`,
`language/expressions/addition/bigint-errors.js` and
`language/expressions/unsigned-right-shift/bigint-toprimitive.js`. The two
`String.prototype.indexOf` rows are family-B ToString re-validation rows that fell out
for free.

One after-run row (`built-ins/Symbol/prototype/Symbol.toPrimitive/name.js`) recorded
`compile_error: compilation timeout (15.1 s)`; re-run serially it is `fail`, same as
before — a load artifact on a 4-core box, not a status change.

**Cohort C — 27 rows (control):** the 18 A-family rows whose baseline error is
"Cannot convert a Symbol value to a number", plus the 9 rows that mention `toPrimitive`
but not `Symbol.toPrimitive` (Temporal excluded — unimplemented, fail either way).

| | pass | fail | compile_error | skip |
| --- | --- | --- | --- | --- |
| before | 1 | 24 | 1 | 1 |
| after | 1 | 21 | 4 | 1 |

**0 fixed, 0 pass→fail.** All five status flips are `built-ins/Array/fromAsync/*`
compilation timeouts (15–19 s) that move in *both* directions between the runs;
neither state is a pass. **The Symbol ×18 cluster is deliberately untouched by this
slice** — every one still reports "Cannot convert a Symbol value to a number".

### Cohort drift since the 2026-07-19 scope note

The two A-family signatures have shrunk a lot under other work: "Cannot convert a
Symbol value to a number" ×79 → **×18**, "Cannot mix BigInt and other types" ×27 →
**×10** (host oracle baseline, 2026-08-27 12:49, `loopdive/js2wasm-baselines`). The
×10 is exactly cohort A's failing rows and is now zero. Re-measure before sizing
steps 2–3.

### Tests

`tests/issue-3481-toprimitive-wrapper-unwrap.test.ts` — 38 cases: one per operator
routed to `__host_bigint_binop` (× both operand orders), hint propagation
(`default` for `+`, `number` otherwise), @@toPrimitive-beats-valueOf precedence,
string-hint dispatch; regression guards for the shapes that already worked
(`Object(2n)`, `valueOf`, `toString`, the #1716 method arm, plain bigint arithmetic,
the `"[object Object]"` sentinel, a genuine mix); and the negatives that must still
throw (`@@toPrimitive` returning a Symbol, a non-callable slot, a method returning an
object, a user throw propagating unchanged). Non-vacuity checked: **27 of the 38 fail
against the base runtime**; the 11 that pass on base are exactly the regression guards.

### Gates run

`typecheck` · `lint` · `prettier --check` · `check:loc-budget` · `check:func-budget` ·
`check:oracle-ratchet` · `check:coercion-sites` · `check:dead-exports` ·
`check:ir-fallbacks` (unchanged) · all **8/8 equivalence shards** (separate processes,
"No new equivalence regressions" each).

Pre-existing, NOT from this slice: `tests/issue-1716.test.ts > Object.getOwnProperty
Descriptor with an object key` fails identically (NaN vs 42) on the base runtime and on
this branch.

### CI follow-up — the host-import migration ratchet (2026-08-27)

`quality` went red on `check:host-import-policy` with
`runtimeTsLines 18396 > maximum 18275`. That is a **second, independent** ceiling
on `src/runtime.ts`: the `loc-budget-allow` grant in this issue's frontmatter
governs `scripts/check-loc-budget.mjs`, while `plan/audit/host-import-policy-baseline.json`
governs the #4401 native-first migration gate. A grant to one says nothing to the
other.

**Precedent.** `git log -p` on that file shows the ceiling is raised **in the PR
that needs it**, to the **exact measured value** with no rounding, rationale in
the commit message — `17949 → 18188 → 18275` across `433d7766ff`, `70d0e288b3`,
`569d78f78a`, and two commits titled outright "fix(ci): ratchet host-import
source budget …" (`cfcf8c8c12`, `63f87a27f8`). It is **not** the
`scripts/*-baseline.json` class that CLAUDE.md reserves to main. So: `18275 → 18396`.

**The gate's real target is host imports, and this change adds none.** Measured
by running the gate on both sides — only one of its nine tracked numbers moves:

| metric | base | new | delta |
| --- | --- | --- | --- |
| `runtimeTsLines` | 18275 | 18396 | **+121** |
| `resolveImportLines` | 7592 | 7592 | 0 |
| `resolveImportCases` | 15 | 15 | 0 |
| `ownedAdapterLines` | 792 | 792 | 0 |
| `explicitCapabilityLines` | 1194 | 1194 | 0 |
| native-first `imports` | 394 | 394 | 0 |
| native-first `legacySemanticImports` | 0 | 0 | 0 |
| native-first `unknownImports` | 0 | 0 | 0 |
| `compatibilityLegacySemanticImports` | 23 | 23 | 0 |

The growth is the §7.1.1 step-2 field probe plus its two guards — ToPrimitive
semantics for the **host lane**, which by the dual-mode architecture is where
host-lane semantics belong. It adds no import, no `resolveImport` case and no
adapter. The separate `#1524` host-import allowlist + strict-mode gate also
passes (13/13).

**Remaining `quality` steps run locally** so a second failure would not surface
one push later — everything after the failing step, plus the earlier ones:
`check:ir-dialect` · `check:ir-kind-neutrality` · `check:jstag-seam` ·
`check:ir-layering` · `check:ir-fallbacks` · `check:ir-only --policy=hybrid`
(READY) · `check:standalone-ir-cutover-corpus` · `check:dead-exports` ·
`check:oracle-ratchet` · `check:pushraw` · `check:loc-budget` ·
`check:func-budget` · `check:harness-compile-budget` · `check:ir-adoption` ·
`check:stack-balance` · `check:codegen-fallbacks` · `check:any-box-sites` ·
`check:speculative-rollback` · `check:coercion-sites` · `check:issues` ·
`check:issue-spec-coverage` · `check:done-status-integrity` ·
`check:verdict-oracle` · `sync:conformance:check` ·
`generate:feature-badges:check` · `test:ir:alloc` · the `#1524` allowlist tests ·
`tests/issue-{3004,3303,1580}.test.ts` — all green.

**One `quality` step is red and it is NOT this branch's:
`scripts/run-guard-suite.mjs` — 26 failures in 4 files** (`issue-3164`,
`issue-3386`, `issue-3565`, `issue-680`), all `RuntimeError: unreachable` in
`__gen_resume___closure_*`, i.e. the standalone native-generator lane.
A/B-confirmed against `origin/main`'s own `src/runtime.ts` on the merged head:
**byte-identical failure sets**, 26/26, same test names. It is a live red on
`main`, not collateral from #3481, and it will block any PR that runs `quality`
until someone owns it. Escalated to the coordinator.

### What is still open (steps 2–3, deliberately not attempted here)

- **Step 2 — family-B ToString/ToInteger/ToIndex re-validation** of a ToPrimitive result
  that is a Symbol/BigInt. Two of its rows fell out incidentally
  (`String.prototype.indexOf`); the `Error`/`AggregateError` message-ToString,
  `DataView.getBigInt64` / `BigInt.asUintN` ToIndex and `ArrayBuffer` length rows still
  fail and need the inlined codegen coercions (`string-ops.ts` `$__any_to_string`) and
  the ToInteger/ToIndex paths routed through the checking helper.
- **Step 3 — the ~10 isolated operator/arg-validation fixes** (`1n >>> 1n`,
  `toFixed(sym)` coercion order, `sort` comparefn IsCallable, `ArrayBuffer.slice`
  species, `String.fromCharCode(1n)`).
- **The Symbol ×18 cluster** (was ×79) — a different subsystem (property-access
  Symbol-key coercion), unmoved by this slice and still wanting the feasibility probe
  the 2026-07-21 notes called for.
- **`bigint-and-number.js` (9 files)** — still needs general `any`-arithmetic host
  delegation (`Object(1n) * 1` has neither operand statically bigint), whose f64→externref
  result-type change is its own regression budget. Unchanged from the 2026-07-21
  analysis.
- **`_toPrimitive`** (the non-host walker) has the same shape-3 blind spot. Its callers
  mostly chain to `_hostToPrimitive` on a miss, so they inherit this fix; the
  non-chaining sites were left alone to keep this slice's blast radius at the measured
  293 rows.
