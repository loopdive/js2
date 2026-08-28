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
  # 2026-08-28, cause 2 — restated so the grant is not STRANDED (a grant only
  # counts when it lives in an issue file the PR itself modifies). +214 lines in
  # `src/runtime.ts`, and they cannot live anywhere else: the over-throw happens
  # where an opaque WasmGC struct meets the HOST constructor, which is the
  # import bridge in this file. `_errorMessageToString` is one shared helper for
  # all three Error-family lanes (extern-class, AggregateError, SuppressedError)
  # precisely so the ToString spelling cannot drift between them; most of the
  # +83 is the comment explaining the two-walker order, which is load-bearing
  # and was arrived at by measurement.
  - src/runtime.ts
  # 2026-08-27, step 2 — the §7.1.4 / §7.1.17 Symbol guard is a per-site early
  # return, so it lands where each argument is coerced rather than in one new
  # file. +9…+23 lines per site; the shared helper it calls
  # (src/codegen/tonumber-symbol-throw.ts) stays under the 1500-line threshold.
  - src/codegen/array-methods.ts
  - src/codegen/literals.ts
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/expressions/new-builtin-globals.ts
  - src/codegen/expressions/new-super.ts
  # 2026-08-27, step 3 — the @@toPrimitive-FIELD dispatch. The new driver pair
  # lives in its own module (src/codegen/objlit-to-primitive.ts, ~180 lines,
  # well under the threshold); what lands in these three is the minimum that
  # cannot live anywhere else. `type-coercion.ts` +147: the ref -> f64 arm is
  # where §7.1.1 step 2 has to happen, and the arm must build BOTH branches
  # inside `fctx.body` (index discipline, see the helper's comment), so it
  # cannot be a one-line delegation. `index.ts` +10 and `context/types.ts` +9
  # are the two `fillObjLitToPrimitive` calls and the reserved-flag field, i.e.
  # the fixed cost of the reserve/fill pattern this file's own precedents use.
  - src/codegen/type-coercion.ts
  - src/codegen/index.ts
  - src/codegen/context/types.ts
coercion-sites-allow:
  # 2026-08-27, step 3 — one added `__unbox_number` in `type-coercion.ts`: the
  # driver returns the §7.1.1 step-2 primitive as externref and the coercion's
  # target is f64. It is not a hand-rolled matrix — it is the SAME unbox the
  # neighbouring @@toPrimitive-METHOD arm already uses for its externref
  # return, in the coercion engine's own file.
  - src/codegen/type-coercion.ts
func-budget-allow:
  # 2026-08-28, cause 2 — `resolveImport` +32. The Error family's message
  # argument is coerced in the extern-class constructor bridge, which lives
  # inside this (already very large) dispatcher; the coercion has to sit exactly
  # there, between the argument arriving and `new Ctor(...)` running. It could
  # NOT join the existing `coercesArgsToPrimitive` list next to it — that loop
  # walks EVERY argument, and §20.5.1.1 runs ToString on the message alone
  # (argument 1 is the `options` bag, whose `cause` must survive as an object),
  # so it is a single-INDEX arm instead. The reusable half is already factored
  # out into `_errorMessageToString` at module level.
  - src/runtime.ts::resolveImport
  # 2026-08-27, step 2 — same reason as the LOC grant: the Symbol guard belongs
  # at the argument-coercion site, which is inside these already-large builtin
  # dispatchers. +8…+22 lines each, all of it one `if (…) return …;` plus the
  # comment that explains which spec step it implements.
  - src/codegen/array-methods.ts::compileArrayMethodCall
  - src/codegen/expressions/new-indexed.ts::tryCompileIndexedBuiltinNew
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/codegen/expressions/new-builtin-globals.ts::tryCompileBuiltinGlobalNew
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
  # 2026-08-27, step 3 — see the LOC note above. `coerceType` +28 is the new
  # arm plus its fallback-capture comment; the two `generateModule` /
  # `generateMultiModule` deltas are one `fillObjLitToPrimitive(ctx);` call and
  # its comment on each finalize path.
  - src/codegen/type-coercion.ts::coerceType
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
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

**`scripts/run-guard-suite.mjs` fails LOCALLY but is green in CI — a Node-version
divergence, not a main regression.** Locally it gives 26 failures in 4 files
(`issue-3164`, `issue-3386`, `issue-3565`, `issue-680`), all
`RuntimeError: unreachable` in `__gen_resume___closure_*`, i.e. the standalone
native-generator lane. Two facts place it:

- A/B against `origin/main`'s own `src/runtime.ts` on this merged head gives
  **byte-identical failure sets**, 26/26, same test names — so it is not
  collateral from #3481.
- CI's `quality` is **green on this exact head** (`7ab44e0857`), and that job
  runs the guard suite. CI uses **Node 25** (`.github/actions/setup-node-pnpm`
  default); this container has only Node 20/21/22, and the suite fails on both
  20 and 22.

So it is an engine-version-dependent failure in the WasmGC generator-resume path
that newer V8 handles — worth knowing when validating locally on Node ≤22 (it
will look like a red main and it is not), but it blocks nothing.

> Correction: the commit message on `7ab44e0857` calls this "a live red on main"
> that "will block any PR that runs `quality`". That was written before the CI
> run came back and is **wrong** — the A/B (not mine) held up, the impact claim
> did not. This paragraph is the accurate record.

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

## Step-2 record — 2026-08-27, senior-dev (branch `claude/issue-3481-step2-revalidation`)

**Step 2 landed as a Symbol re-validation at the ToString / ToInteger / ToIndex
argument sites. 12 test262 rows fail→pass, 0 regress.** The premise the slice-1
notes handed forward — "the ToPrimitive RESULT is not re-validated" — turned out
to describe only part of the family, and not the part that was blocking rows.
The measurement below is what redirected the work; it is recorded because the
same wrong premise will otherwise be inherited again by step 3.

### What was actually broken (measured on main, 2026-08-27)

A per-site matrix (24 sites × the shapes that reach them) was run in the shape
the failing test262 files use — a symbol bound as a plain local inside a
function, e.g. `var s = Symbol(); … new ArrayBuffer(s)`. Writing
`Symbol() as any` instead probes a **different** path and answers "already
correct", which is why the earlier reading of this family looked smaller than it
is.

| site | on main | spec |
| --- | --- | --- |
| `new ArrayBuffer(s)` · `new SharedArrayBuffer(s)` | allocated a buffer of `id` bytes | TypeError |
| `new DataView(buf, s)` · `new DataView(buf, 0, s)` | no throw | TypeError |
| `Symbol(s)` | description `"101"` | TypeError |
| `new AggregateError([], s)` | message `"Symbol()"` | TypeError |
| `[1,2].at(s)` · `[1,2].includes(1, s)` | ordinary index | TypeError |
| `isNaN(s)` · `isFinite(s)` | `false` / `true` | TypeError |
| `new Error(s)` · `"".indexOf(s)` · `"".replaceAll("a", s)` · `BigInt.asUintN(s, 1n)` · `Number(s)` | already TypeError | — |

**Root cause: the guard that exists is STATIC-only and was simply absent at
these nine sites — not a missing re-validation of a ToPrimitive result.** A
symbol VALUE lowers to a bare `i32` id (`compileSymbolCall`, literals.ts), so an
argument compiled with an `{kind:"f64"}` target is a silent
`f64.convert_i32_s` of that id and `ToIndex` then sees an ordinary small
integer. The DYNAMIC twin — a symbol that reaches the site as an `externref` —
was never broken: `__unbox_number` runs ToPrimitive and lets `Number(prim)`'s
TypeError propagate (runtime.ts, the `unbox`/`number` intent). That asymmetry is
why `new ArrayBuffer(Symbol() as any)` threw while
`var s = Symbol(); new ArrayBuffer(s)` did not.

`src/codegen/tonumber-symbol-throw.ts` already existed for exactly this class
(#4556, extracted "so a third site cannot forget it") but owns a whole argument
LIST, which only fits a site that has evaluated nothing yet. Every site here
coerces an argument in the MIDDLE of a lowering that has already stashed the
earlier operands, so the slice adds the single-operand form,
`emitSymbolOperandCoercionThrow`, with an explicit `before` list for the one
site (`arr.at` / `arr.includes`) whose receiver is evaluated inside the arm the
guard skips.

### Deltas — per row, both sides run on this branch

**Method: a byte-identity sweep, not a two-sided status run.** Every guard is an
early return that emits NOTHING unless `staticJsTypeOf(arg) === "symbol"`, so a
row whose emitted module is byte-identical cannot have changed verdict. The box
was at load ~12 on 4 cores, where a two-sided 265-row status run projected to
>5 h; hashing the compiled binary is ~15× cheaper per row (in-process, one
compiler load per shard) and is *stronger* evidence — it separates "unchanged"
from "changed but happened to score the same".

**1,160 rows swept on each side** (base captured via `git apply -R` of this
branch's own diff, so both sides share the harness):

| group | rows | what it is |
| --- | --- | --- |
| candidates | 265 | a guarded builtin called with a non-literal argument, in a file that mentions `Symbol` |
| dropped | 596 | a guarded builtin called only with a numeric/string LITERAL (`new ArrayBuffer(8)`, `Symbol("d")`) — the tightening made to keep the run affordable, checked rather than assumed |
| excluded | 300 | deterministic stride sample of the 34,560 otherwise-PASSING rows |

| | rows |
| --- | --- |
| byte-IDENTICAL | **1,148** |
| binary changed | **12** |

**All 12 changed rows are the intended targets, and all 12 flip fail → pass:**

| row | before | after |
| --- | --- | --- |
| `built-ins/ArrayBuffer/return-abrupt-from-length-symbol.js` | fail | **pass** |
| `built-ins/SharedArrayBuffer/return-abrupt-from-length-symbol.js` | fail | **pass** |
| `built-ins/DataView/return-abrupt-tonumber-byteoffset-symbol.js` | fail | **pass** |
| `built-ins/DataView/return-abrupt-tonumber-byteoffset-symbol-sab.js` | fail | **pass** |
| `built-ins/DataView/return-abrupt-tonumber-bytelength-symbol.js` | fail | **pass** |
| `built-ins/DataView/return-abrupt-tonumber-bytelength-symbol-sab.js` | fail | **pass** |
| `built-ins/AggregateError/message-tostring-abrupt-symbol.js` | fail | **pass** |
| `built-ins/Symbol/desc-to-string-symbol.js` | fail | **pass** |
| `built-ins/Array/prototype/at/index-non-numeric-argument-tointeger-invalid.js` | fail | **pass** |
| `built-ins/Array/prototype/includes/return-abrupt-tointeger-fromindex-symbol.js` | fail | **pass** |
| `built-ins/isNaN/return-abrupt-from-tonumber-number-symbol.js` | fail | **pass** |
| `built-ins/isFinite/return-abrupt-from-tonumber-number-symbol.js` | fail | **pass** |

**ZERO pass→fail, and for 1,148 of the 1,160 rows that is a byte-level
guarantee rather than a same-verdict observation.** An earlier 22-row status run
of the originally-scoped family-B cohort agrees (8 fixed / 0 regressed on its
overlap).

**What the sweep does NOT cover, stated plainly:** it is 1,160 of 48,735 counted
rows. The completeness argument for the rest is syntactic — a guard sits inside
the lowering of `new ArrayBuffer` / `new SharedArrayBuffer` / `new DataView` /
`new AggregateError` / `Symbol(…)` / `.at(` / `.includes(` / `isNaN(` /
`isFinite(`, and fires only when the oracle types that argument `symbol`, which
needs a symbol-typed binding in the test's own source. The 300-row excluded
sample is the empirical check on that argument, and it found nothing. The 8
equivalence shards are the independent backstop.

### Tests

`tests/issue-3481-step2-symbol-arg-revalidation.test.ts` — 36 cases: one per
guarded site; two that pin the *terminal* nature of the throw (pre-fix the call
SUCCEEDED with a wrong buffer length / description, so "something threw" is too
weak an assertion); two evaluation-order cases (`new ArrayBuffer(mk())` still
calls `mk`, `recv().at(s)` still calls `recv`); regression guards for every
non-Symbol argument shape including `String(sym)` and `sym.toString()`, which
must keep returning the descriptive string (§22.1.1.1 is the one ToString
spelling that does not throw); and the dynamic-`externref` cases that already
worked, kept so a later refactor of the static guard cannot quietly take the
dynamic one with it. Assertions use `e instanceof TypeError`, not a `.name`
match — the issue's acceptance bar is a real catchable TypeError, and a
bare-string throw passes a name check while failing the authentic harness.
**Non-vacuity: 12 of 36 fail against base**; the 24 that pass on base are
exactly the regression, evaluation-order and dynamic-path guards.

### Two PRE-EXISTING gaps this slice measured but did not touch

Both were found while writing the tests, verified identical on base and on this
branch, and are recorded so they are not misread later as collateral:

- `[10, 20].at()` with **no** argument answers `0` where §23.1.3.1 says `10`.
  The guard keys off `arguments[0]`, so an absent argument never reaches it; the
  test asserts only that nothing throws, rather than pinning the wrong value.
- A user `class SharedArrayBuffer` does not work at all (`SharedArrayBuffer is
  not a constructor`, from the runtime's generic construct bridge). The SAB
  guard is behind `resolvesToNamedAmbientGlobal` + `!ctx.classSet.has(…)`, so
  the test asserts the failure is still that one and **not** the guard's
  message — which is what a hijack would look like.

### Gates

`typecheck` · `lint` · `prettier --check` · `check:loc-budget` ·
`check:func-budget` · `check:oracle-ratchet` · `check:coercion-sites` ·
`check:dead-exports` · `check:ir-fallbacks` (unchanged) · 8/8 equivalence
shards. `plan/audit/host-import-policy-baseline.json` needs **no** bump: this
slice does not touch `src/runtime.ts`, so `runtimeTsLines` is unmoved (slice 1's
`18275 → 18396` ratchet stands).

The five `loc-budget-allow:` paths added to this issue's frontmatter are the
guarded call sites that are already over the 1,500-line threshold. The guard is
a per-site early return by construction — a central chokepoint would have to be
`coerceType(i32 → f64)`, which cannot distinguish a symbol id from a number
(the `{kind:"i32", symbol:true}` brand is carried only in the native-symbol
lanes, deliberately: branding it in the js-host lane shifted baked function
indices and cost 216 invalid-module regressions — see the #4626 note in
`compileSymbolCall`).

### What step 3 inherits — the premise is NOT what slice 1 recorded

The remaining family-B rows are **not** blocked on ToString/ToInteger/ToIndex
re-validation. Re-measured, they split into two different root causes:

1. **`@@toPrimitive` is not dispatched for the NUMBER hint** on an object
   argument — `built-ins/BigInt/as{Int,Uint}N/{bits-toindex,bigint-tobigint}-toprimitive.js`
   (×4), `built-ins/DataView/prototype/getBig{Int,Uint}64/toindex-byteoffset-toprimitive.js`
   (×2), `built-ins/String/prototype/indexOf/position-tointeger-toprimitive.js`.
   All fail at assertion #1 (`{[Symbol.toPrimitive](){return 1}}` → `0`, or the
   V8 message `'0' returned for property 'Symbol(Symbol.toPrimitive)' … is not a
   function`), i.e. the host reads the struct FIELD's raw value. This is
   slice 1's shape 3 again, but on the host `Number()` / ToIndex path rather
   than in `_hostToPrimitive`. `{valueOf}` and `{toString}` already work.
   Additionally `{[Symbol.toPrimitive](){…}}` captured into a closure and passed
   to `new ArrayBuffer` traps with `RuntimeError: illegal cast`.
2. **`new Error(obj)` / `new AggregateError([], obj)` OVER-throw** — an object
   message with a plain `toString` raises TypeError instead of stringifying,
   which is what `built-ins/{AggregateError,SuppressedError}/message-tostring-abrupt.js`
   report as "Expected a Test262Error but got a TypeError".

Also still open and unchanged: `Number.prototype.toExponential(sym)` throws a
NAMELESS payload (so `assert.throws(TypeError, …)` fails on the `.name` check)
and has two twin lowerings, dot-access and element-access, that would both need
the guard; and the step-3 list from the original scope note (`1n >>> 1n`,
`toFixed` coercion order, `sort` comparefn, `ArrayBuffer.slice` species,
`String.fromCharCode(1n)`).

## Step-3 record — 2026-08-28, senior-dev (branch `claude/issue-3481-step3-number-hint`)

**The `@@toPrimitive`-FIELD dispatch is fixed for the number hint. The premise
step 2 handed forward is HALF right, and the half it got wrong is the half that
was blocking the 7 rows** — so read the root-cause section below before sizing
anything else in this family. (Third slice in a row whose first job was to
correct the previous slice's inherited premise; the pattern is that each slice
measured only the shape it fixed.)

### What step 2 handed forward, and what is actually true

Step 2 recorded cause (1) as "`@@toPrimitive` is not dispatched for the NUMBER
hint on an object argument", citing 7 rows. Re-measured on main, that splits in
two, and only the first is what this slice fixes:

| | claim | measured |
| --- | --- | --- |
| **1a** | `@@toPrimitive` in a struct FIELD is not dispatched by the number-hint coercion | **TRUE.** `Number({[Symbol.toPrimitive]: () => 5, valueOf: () => 7})` answered **7**, inside an ordinary function, on `main`. |
| **1b** | …and that is why the 7 named test262 rows fail | **FALSE.** Those rows fail because **NO** ToPrimitive works at module scope — `valueOf` and `toString` fail there too. |

The 2 × 17 matrix that settled it (each expression run once at MODULE scope and
once inside an exported function, on `main`):

| expression | module scope | in a function | spec |
| --- | --- | --- | --- |
| `BigInt.asIntN({[Symbol.toPrimitive]:()=>1}, 1n)` | `0` | `-1` | `-1` |
| `BigInt.asIntN({valueOf:()=>1}, 1n)` | `0` | `-1` | `-1` |
| `BigInt.asIntN({toString:()=>1}, 1n)` | `0` | `-1` | `-1` |
| `"aaa".indexOf("a", {valueOf:()=>1})` | `0` | `1` | `1` |
| `new DataView(buf).getBigInt64({valueOf:()=>0})` | TypeError | `0` | `0` |
| `Number({[Symbol.toPrimitive]:()=>5})` | `NaN` | `5` | `5` |
| `Number({valueOf:()=>5})` | `5` | `5` | `5` |

**Root cause of the module-scope column: `__module_init` is the wasm START
function.** It runs inside `WebAssembly.instantiate`, i.e. **before**
`__setExports` can hand the host runtime `instance.exports` — so
`callbackState.getExports()` is `undefined`, `_resolveHostField` cannot call any
`__sget_<name>` / `__call_fn_method_N`, and `_hostToPrimitive` falls through to
its `"[object Object]"` sentinel. `BigInt.asIntN("[object Object]", 1n)` is
`asIntN(0, 1n)` = `0n`, which is exactly the `0` in that column; the V8 message
step 2 quoted (`'0' returned for property 'Symbol(Symbol.toPrimitive)' … is not a
function`) is the same failure one shape further along, where a sibling literal
put a non-closure in the field.

This is a known, documented hazard in this codebase — `finalizeInModuleInitFlag`
(#2800), the numeric-key `struct.get` switch (#2582) and the lazy Proxy bridge
(#2618) all exist to work around it — but it had not been connected to this
family. **Every test262 file is module-level code**, which is why the whole
`*-toprimitive.js` cluster sits behind it.

**Consequence for sizing.** Those 7 rows are not a coercion-site slice. Each
needs a full §7.1.1.1 walk (skip a non-callable `valueOf`, skip a `valueOf` that
returns an object, honour `[Symbol.toPrimitive]: undefined`, …) available with
**no host at all**, at the point where a struct is handed to a host builtin.
That is either (a) a host-free compiled OrdinaryToPrimitive at each such
argument slot, or (b) making the module's own accessors reachable from the host
during start — a `ref.func` hand-over at the top of `__module_init`, or retiring
the `start` section in favour of the WASI-style `__init_done` + call-on-entry
that #1789 already implements for the other lane. (b) is the one that also
retires the #2800 / #2582 / #2618 workarounds. Neither is a slice.

### What this slice changes

`@@toPrimitive` reaches codegen in three physically different shapes — slice 1's
taxonomy. Only the METHOD shape had a **compiled** dispatch:

| shape | source | storage | compiled dispatch before this slice |
| --- | --- | --- | --- |
| sidecar | `o[Symbol.toPrimitive] = fn` | host sidecar | n/a (host-only) |
| method | `{ [Symbol.toPrimitive](hint) {…} }` | `${name}_@@toPrimitive` | yes |
| **property** | `{ [Symbol.toPrimitive]: fn }` | struct FIELD `@@toPrimitive` | **no** |

`coerceType(ref → f64)` therefore skipped §7.1.1 step 2 for the property shape
and went straight into OrdinaryToPrimitive, so `valueOf` won.

The fix adds the missing arm, host-free:

- `src/codegen/objlit-to-primitive.ts` (new) — the reserved driver pair
  `__objlit_tp_callable(tp) -> i32` and
  `__objlit_tp_call(recv, tp, hint) -> externref`, filled at finalize
  (`fillObjLitToPrimitive`, on both `index.ts` paths) once the closure
  base-wrapper set and the `__call_fn_method_N` family exist. Reserve/fill
  rather than inline calls because a coercion site is compiled long before
  either exists — the #2191 stale-funcIdx hazard; same discipline as
  `reserveAccessorGetDriver` / `reserveClassToPrimitive`.
- `src/codegen/type-coercion.ts` — the `ref → f64` arm reads the
  `@@toPrimitive` field and dispatches only when `__objlit_tp_callable` says the
  value is a live closure. That guard is what makes the change inert: a null
  field, a **host `undefined` carrier** (which is NOT `ref.null`, so a plain
  null test would have mistaken it for a method), and any non-callable value all
  answer 0 and take the untouched fallback.

**Two implementation notes worth keeping.**

1. _Both_ branches of the new `if` are emitted into `fctx.body` and lifted into
   the `if` only at the very end, with no registration in between. Registering
   the hint string constant adds an imported GLOBAL and shifts the
   defined-global range; the shift pass rewrites the ops **in `fctx.body`**, so
   the first cut — which built the dispatch as a detached array — left the
   fallback's `__current_this` save/restore pointing at a string-constant global
   and the module failed to validate with _"immutable global #2 cannot be
   assigned"_. That is the #2679 / `project_type_index_shift_and_deadelim`
   hazard in a new costume.
2. The fallback branch is obtained by **re-entering `coerceType`** under a skip
   flag and splicing off what it emitted, so the existing valueOf/toString
   lowering is reused verbatim rather than duplicated. The re-entry must hand
   back `__insideValueOfCoercion`, or the recursive call short-circuits to NaN.

### Measured deltas

Behaviour, A/B on this branch with the file-copy pattern (`git show
HEAD:src/codegen/type-coercion.ts` and the three other touched files captured
before the first edit, so both sides ran the same harness):

| case | before | after | spec |
| --- | --- | --- | --- |
| `Number({@@tp:()=>5, valueOf:()=>7})` (in a function) | 7 | **5** | 5 |
| sibling literals `{@@tp:()=>5, valueOf:()=>1}` / `{valueOf:()=>7}` | `1,7` | **`5,7`** | `5,7` |
| `Number({@@tp:()=>5})` at MODULE scope | NaN | **5** | 5 |
| `{@@tp:()=>5} * 2` at MODULE scope | NaN | **10** | 10 |
| `Math.abs({@@tp:()=>5})` at MODULE scope | NaN | **5** | 5 |
| `Number({@@tp:()=>5})` under `--target standalone` | NaN | **5** | 5 |
| `{[Symbol.toPrimitive]: undefined, valueOf:()=>7}` | 7 | 7 | 7 |
| `{[Symbol.toPrimitive]: null / 1, valueOf:()=>7}` | 7 | 7 | 7 |
| `{valueOf:()=>7}` (no `@@toPrimitive` at all) | 7 | 7 | 7 |

The standalone row is the one with no fallback at all before this slice: the
host lane at least had `_hostToPrimitive` inside a function; standalone had
nothing.

### Byte-identity sweep — 1,170 rows, **0 changed verdicts**

Byte-identity is the right instrument here because the change is pure codegen: a
row whose compiled module is byte-identical cannot have changed verdict, which
is stronger than "scored the same twice". Both sides ran the same harness
(`.tmp/hash-shard.mts`, reused from step 2), the base captured by swapping in
`git show HEAD:` copies of all four touched files.

| group | rows | what it is |
| --- | --- | --- |
| `Symbol.toPrimitive` | 268 | **every** counted row whose source mentions it |
| stride sample | 607 | every 80th row of the 48,619 counted rows |
| valueOf/toString sample | 332 | every 3rd row under Array / String.indexOf / DataView / BigInt / ArrayBuffer / language-expressions mentioning `valueOf` or `toString` |
| **swept (deduped)** | **1,170** |  |

|  | rows |
| --- | --- |
| byte-IDENTICAL | **1,166** |
| binary changed | **4** |

The 4 changed rows were then run through the real runner on both sides
(`--isolate`) and are **`fail` → `fail` with byte-identical error text**:
`language/expressions/{exponentiation/bigint-toprimitive, exponentiation/bigint-errors, bitwise-not/bigint-non-primitive, unary-minus/bigint-non-primitive}.js`
— each aborts at an earlier assertion for an unrelated reason.

**So: 0 pass→fail, and 0 fail→pass.** Stated plainly — **this slice flips no
test262 row.** The reason is the same asymmetry the root-cause section
describes: the arm fires only when the object is statically STRUCT-typed
(`ref`), and test262 writes its object literals straight into a builtin's
argument position, where they travel as `any`/`externref` and are coerced by the
host `__unbox_number` — correct inside a function, unavailable at module scope.
What the slice buys is a real spec fix (`@@toPrimitive` losing to `valueOf` is a
plain §7.1.1 violation), the first `@@toPrimitive`-property support in the
**standalone** lane, and correctness at module-init for the struct-typed shape.

The completeness argument for the rows NOT swept is the same one slice 1 used,
and it is tight here: the arm needs a struct field literally named
`@@toPrimitive`, which a test can only build if `Symbol.toPrimitive` appears in
its own source or in an included harness file — and only `typeCoercion.js` (no
test includes it) and `testIntl.js` (only `intl402/`, not counted) use it. All
268 such rows are in the sweep.

### Tests

`tests/issue-3481-step3-toprimitive-field-number-hint.test.ts` — 23 cases:
precedence over `valueOf` / `toString` / both; the `number` hint reaching the
method; the receiver bound as `this`; arithmetic and `Math.*` argument coercion;
a user throw propagating; sibling shapes keeping their own answers; the three
module-scope cases and the standalone case; and regression guards for every
shape that must NOT change — no `@@toPrimitive` at all, an `@@toPrimitive` field
holding `undefined` / `null` / a non-callable, the #1716 METHOD shape, and a
plain object still coercing to NaN. **Non-vacuity: 8 of 23 fail against base**;
the 15 that pass on base are exactly the guards.

One case is pinned as a KNOWN GAP rather than as correct behaviour: the STRING
hint still ignores the `@@toPrimitive` field
(`String({@@tp:()=>5, toString:()=>"s"})` is `"s"`, spec says `"5"`).
`ref → externref` has its own, differently shaped lowering; pinning it forces a
future string-hint fix to update the expectation instead of quietly flipping an
untested path.

### Gates

`typecheck` · `lint` · `prettier --check` · `check:loc-budget` ·
`check:func-budget` · `check:coercion-sites` · `check:oracle-ratchet` (+0) ·
`check:dead-exports` · `check:ir-fallbacks` (unchanged) · `check:ir-dialect` ·
`check:ir-kind-neutrality` · `check:jstag-seam` · `check:ir-layering` ·
`check:codegen-fallbacks` · `check:any-box-sites` ·
`check:speculative-rollback` · `check:issues` · `check:issue-spec-coverage` ·
`check:done-status-integrity` · `check:pushraw` ·
`check:harness-compile-budget` · `check:ir-adoption` · `check:stack-balance` ·
`check:host-import-policy` · **8/8 equivalence shards** ("No new equivalence
regressions" each) · the slice-1 (38) and step-2 (36) suites, 97/97 together
with this slice's 23.

`plan/audit/host-import-policy-baseline.json` needs **no** bump: this slice does
not touch `src/runtime.ts`, so `runtimeTsLines` is unmoved. The LOC / func /
coercion-site grants added to this issue's frontmatter are the reserve/fill
pattern's fixed cost plus the one `__unbox_number` that turns the driver's
externref result into the coercion's `f64` target.

Local-validation note for whoever runs this next: `scripts/run-guard-suite.mjs`
fails on Node ≤ 22 in the standalone generator-resume path and is green in CI
(Node 25) — see the slice-1 correction above. This container is Node 22.22.2.

### What remains after this slice

- **Cause (2) from step 2 — `new Error(obj)` / `new AggregateError([], obj)`
  OVER-throw** on a plain-`toString` message. Re-confirmed on this branch and
  **unchanged by this slice** — it does not fall out of the dispatch correction,
  as step 2 hoped: `new Error({toString(){return "msg"}})` raises TypeError
  instead of producing `message === "msg"`, inside a function as well as at
  module scope. That is the next slice, and it is independent of everything
  above.
- **The 7 `*-toprimitive.js` rows** — blocked on the module-init/exports
  problem, not on hint dispatch. Sized above.
- **The STRING hint** for the `@@toPrimitive` FIELD shape (pinned in the tests).
- Unchanged from step 2: the Symbol ×18 cluster, `bigint-and-number.js` (9
  files), `Number.prototype.toExponential(sym)`'s nameless payload, and the
  original isolated list (`1n >>> 1n`, `toFixed` coercion order, `sort`
  comparefn, `ArrayBuffer.slice` species, `String.fromCharCode(1n)`).
- **Could not reproduce** step 2's `RuntimeError: illegal cast` for a
  closure-captured `{[Symbol.toPrimitive](){…}}` passed to `new ArrayBuffer`.
  Six shapes were tried on `main` — property and method form, inline and
  closure-returned, module scope and function scope, an outer-variable capture,
  and an arrow reading the hint. All either answered correctly (`8`) or threw
  `RangeError` from the module-scope path above; none trapped. Recorded as
  unreproduced rather than as fixed.

## Cause-2 record — 2026-08-28, opus (branch `claude/issue-3481-cause2-error-tostring`)

**The Error-family `message` over-throw is fixed, in `src/runtime.ts` alone.
`built-ins/AggregateError/message-tostring-abrupt.js` flips fail → pass, 0 rows
regress, and every compiled module is byte-identical.** The step-3 record handed
this forward as "independent of everything above"; that held, but the *mechanism*
it implied (a coercion-site fix) was wrong, and so was my own first
implementation. Both corrections are recorded below, because each was found only
by a measurement that is cheap to skip.

### Root cause — an existing mechanism the Error family was never added to

The message argument crosses to the host `__new_<Name>` import as an **opaque
WasmGC struct**. V8's own `new Error(msg)` then performs `ToString` on a value it
cannot introspect and raises `TypeError: Cannot convert object to primitive
value`. So *every* object message over-threw:

| expression | on main | spec |
| --- | --- | --- |
| `new Error({toString(){return "msg"}})` | TypeError | `message === "msg"` |
| `new Error({[Symbol.toPrimitive](){…}})` | TypeError | the method's result |
| `new AggregateError([], {toString(){…}})` | TypeError | the method's result |
| `new Error({a: 1})` | TypeError | `"[object Object]"` |

This is **not a new bug class**. `resolveImport`'s extern-class constructor
bridge already carries `coercesArgsToPrimitive` for exactly it — added by #1716
for `RegExp` / `Date` / `String` / `Number`, with a comment describing this
failure verbatim. The Error family was simply never added to the list.

It could not simply *join* that list: the loop coerces **every** argument, while
§20.5.1.1 runs ToString on the message alone (argument 1 is the `options` bag,
and `AggregateError`'s argument 0 is an iterable that must survive as a list). So
the fix is a single-INDEX coercion, plus the shared helper
`_errorMessageToString` also used by the `__new_AggregateError` and
`__new_SuppressedError` builtins, whose `String(message)` had the same defect.

### Correction 1 — the codegen fix was built, measured, and DISCARDED

The first implementation was a codegen change (compile the message without the
`externref` target so the struct type is visible, then
`coerceType(ref → externref, "string")`). It worked on an inline object literal
and **not** on the shape test262 actually uses:

```js
var case1 = { … };                                  // module scope
assert.throws(Test262Error, () => new AggregateError([], case1));
```

`case1` reaches the constructor as an `externref` CARRIER, not a `ref`, so
codegen cannot see that it is a struct at all. Measured side by side, the runtime
fix alone matched the codegen fix on 22 of 23 probe rows; the only difference was
an object message at MODULE scope, which is the `__module_init` START-function
blocker this issue's step-3 record already sized as a non-slice.

So the codegen change was deleted. The payoff is not just simplicity: with no
codegen change, **no compiled module can move**, which turns the blast-radius
argument from a sampling exercise into a proof (measured below anyway).

### Correction 2 — the first runtime cut REGRESSED 3 rows; the base run caught it

The first runtime cut looked right on every hand-written probe. Run against the
234-row cohort it was **96 → 93 pass**: three rows that pass on `main` **because
of the over-throw** turned into failures. Each exposed a separate defect, and
none was visible without the base side:

| row | what my code did | why it was wrong |
| --- | --- | --- |
| `Error/error-message-tostring-toprimitive.js` + `NativeErrors/…-toprimitive.js` | answered `"[object Object]"` for `{toString: undefined, valueOf: undefined}` | no callable method ⇒ §7.1.1.1 step 6 is a **TypeError**; both rows assert it |
| `AggregateError/message-tostring-abrupt-symbol.js` | answered `"Symbol()"` / ran `toString` | `@@toPrimitive` returned a Symbol ⇒ ToString must throw, and `toString` must NOT run |

Three rules came out of fixing them, and all three are load-bearing:

1. **A walker that RETURNS has completed ToPrimitive — commit to its answer.**
   The first cut fell through to the second walker whenever the answer was one it
   could not stringify. The two walkers dispatch *different* methods, so that ran
   user code the spec never calls: for
   `{[Symbol.toPrimitive](){return Symbol()}, toString(){throw …}}` the `toString`
   error escaped, which the row reported as "Expected a TypeError but got a
   undefined".
2. **A NUMBER result is refused.** A native Symbol crosses this boundary as a
   bare i32 id — measured, the id `100` — so it is indistinguishable from a
   method that genuinely returned `100`. The existing re-checks elsewhere in
   `runtime.ts` test `typeof prim === "symbol"` and cannot see an id either.
   Refusing falls back to the pre-existing TypeError, i.e. exactly base.
3. **`"[object Object]"`, `null` and `undefined` from the host walker mean
   "found nothing", not "answered".** `_hostToPrimitive` returns `null` when the
   `@@toPrimitive` slot merely HOLDS `undefined` — a slot §7.1.1 step 2b says to
   SKIP. Treating that `null` as a result is what kept
   `message-tostring-abrupt.js` failing (case 2 raised the ToString TypeError
   instead of letting `toString` throw its `Test262Error`). **This one line is
   the difference between the target row passing and not.**

The two walkers are ordered `_hostToPrimitive` first, `_toPrimitive` second.
Only the host walker implements §7.1.1 step 2 in full (it dispatches an
`@@toPrimitive` METHOD as well as the FIELD shape slice 1 taught it), but it is
not a superset — it mishandles an explicitly-undefined slot, which the module
walker gets right.

### Measured deltas — the COMPLETE Error-family cohort, both sides run by me

**Cohort: all 234 counted rows under `built-ins/{Error,NativeErrors,AggregateError,SuppressedError}/`.**
Not a sample — the whole of the four directories. `--isolate`, one child process
per row; base captured with the file-copy A/B pattern (`git show HEAD:src/runtime.ts`
taken before the first edit) so both sides ran the same harness.

| | pass | fail |
| --- | --- | --- |
| base | 96 | 138 |
| fix | **97** | **137** |

**+1 fixed, 0 regressed.** The fixed row is
`built-ins/AggregateError/message-tostring-abrupt.js` — the row cause 2 was
written against. On base it aborts at case 1 (`'toPrimitive'`); mid-way through
this work it aborted at case 2 (`'toString'`); it now passes all three.

Behaviour, A/B on the same harness:

| case | base | fix | spec |
| --- | --- | --- | --- |
| `new Error({toString(){return "msg"}})` | TypeError | **"msg"** | "msg" |
| `new Error({toString: fn})` (property shape) | TypeError | **"msg"** | "msg" |
| `new Error({[Symbol.toPrimitive]: fn})` | TypeError | **"tp"** | "tp" |
| `new TypeError/RangeError/SyntaxError/EvalError/URIError/ReferenceError({toString(){…}})` | TypeError | **the method's result** | ditto |
| `new AggregateError([], {toString(){…}})` | TypeError | **"ag"** | "ag" |
| a `toString` that throws | TypeError | **the user's error** | the user's error |
| `{[Symbol.toPrimitive](){return Symbol()}}` | TypeError | TypeError | TypeError |
| `{toString: undefined, valueOf: undefined}` | TypeError | TypeError | TypeError |
| `new Error("s" / 42 / true / absent / undefined / null / [1,2] / new Object())` | unchanged | unchanged | — |

### Byte-identity sweep — 1,392 rows, 0 changed

The change is runtime-only, but `src/index.ts` does import from `src/runtime.ts`,
so "compiled output cannot move" is an argument that needed measuring rather than
asserting. Each row's compiled binary was hashed on both sides.

| group | rows |
| --- | --- |
| the full Error-family cohort | 234 |
| stride sample — every 80th of the 48,619 counted rows | 608 |
| **every** counted row anywhere that constructs an Error-family ctor | 605 |
| swept (deduped) | **1,392** |

**1,392 / 1,392 byte-IDENTICAL, 0 changed.** No compiled module moves, so the
only reachable behaviour change is host-side, on the path that previously always
threw.

### Why the upside is +1 and not more — stated plainly

Most of the 137 remaining failures in these four directories are nothing to do
with message coercion: `SuppressedError` is **not implemented by the host at all**
(`typeof SuppressedError === "undefined"` → its whole directory fails, including
its own `message-tostring-abrupt.js` twin), and `AggregateError`'s
`newtarget-*` / `errors-iterabletolist*` / `cause` rows fail on separate
mechanisms. Cause 2 was one defect with one row that isolates it, and that row
now passes.

### Tests

`tests/issue-3481-cause2-error-message-tostring.test.ts` — 37 cases: the object
shapes that must now stringify (method, property, `@@toPrimitive` property and
method, one per intrinsic error name, `AggregateError`); the three
`message-tostring-abrupt.js` cases transcribed verbatim, each selecting a
different rung of §7.1.1; the ordering guard that `toString` must NOT run once
`@@toPrimitive` has answered; a thrown STRING propagating unchanged (which pins
the narrow catch); `toString` running exactly once; and regression guards for
every shape that must not move — string, number, boolean, absent, `undefined`,
`null`, a genuine host object, an array, `Error.prototype.toString` rendering,
`AggregateError`'s errors list surviving, and the options bag never being
coerced. Three KNOWN RESIDUALS are pinned as throws rather than quietly left
untested, each with its reason inline.

**Non-vacuity: 23 of the first 34 cases fail against the base runtime**; the 11
that pass on base are exactly the regression guards.

### Known residuals, deliberate

- `new Error({a: 1})` still throws where the spec wants `"[object Object]"`.
  Once both walkers bottom out, that shape is **indistinguishable** from
  `{toString: undefined, valueOf: undefined}`, which MUST throw and which two
  test262 rows assert. Only one of the two has a test, so the throw wins.
- An object message at **MODULE scope** still throws: `__module_init` is the wasm
  START function, so the host has no `instance.exports` and no walker can call
  the module's own `toString`. That is the blocker sized as a non-slice in the
  step-3 record, and it is not chased here.
- A `valueOf`-only object throws rather than answering — the refused-NUMBER rule
  above. V8 answers `"[object Object]"` here anyway (via the inherited
  `Object.prototype.toString` that neither walker models).
- `SuppressedError` is wired for the same ToString repair, but that constructor
  is **unimplemented in this host** (`SuppressedError is not supported by the
  host`), so the repair is unverifiable today and no row can move.

### Out of scope, measured and unchanged (base == branch)

- **`Error`/`AggregateError` `options.cause` does not work at all.**
  `new AggregateError([], "m", {cause: 7}).cause` is absent on both sides, and
  `new Error("hi", {cause: 7}).cause` reads `NaN`. A separate defect.
- The Error-family lowering **compiles and drops** arguments after the message,
  so a side effect in the options position (`new Error(o, {cause: later()})`) does
  not run. Same on both sides.
- In `--target standalone` the object-message ToString is **already correct**
  (`{toString(){…}}` → the result, `{}` → `"[object Object]"`), which is why this
  slice is host-lane only and standalone is untouched by construction.

### Gates

`typecheck` · `lint` · `prettier --check` · `check:loc-budget` ·
`check:func-budget` · `check:coercion-sites` · `check:oracle-ratchet` ·
`check:dead-exports` · `check:ir-fallbacks` · `check:ir-dialect` ·
`check:ir-layering` · `check:ir-kind-neutrality` · `check:stack-balance` ·
`check:codegen-fallbacks` · `check:any-box-sites` · `check:jstag-seam` ·
`check:speculative-rollback` · `check:issues` · `check:issue-spec-coverage` ·
`check:done-status-integrity` · `check:pushraw` · `check:harness-compile-budget` ·
`check:ir-adoption` · `check:verdict-oracle` · `sync:conformance:check` ·
`generate:feature-badges:check` · `check:standalone-ir-cutover-corpus` ·
`check:host-import-policy` · 8/8 equivalence shards.

`plan/audit/host-import-policy-baseline.json` is ratcheted to the exact measured
values, per the precedent in this file's own history (raised in the PR that needs
it, no rounding). **Only the two line counts move; every metric the gate exists to
police is unchanged** — measured by running the gate on both sides:

| metric | base | new |
| --- | --- | --- |
| `runtimeTsLines` | 18475 | 18689 (+214) |
| `resolveImportLines` | 7592 | 7624 (+32) |
| `resolveImportCases` | 15 | 15 |
| `ownedAdapterLines` | 792 | 792 |
| `explicitCapabilityLines` | 1194 | 1194 |
| native-first `imports` | 394 | 394 |
| native-first `legacySemanticImports` | 0 | 0 |
| native-first `unknownImports` | 0 | 0 |
| `compatibilityLegacySemanticImports` | 23 | 23 |

The change adds **no host import**, no `resolveImport` case and no adapter — it
repairs the coercion on an argument that already crossed this boundary.

Local-validation note, unchanged from the step-3 record:
`scripts/run-guard-suite.mjs` fails on Node ≤ 22 in the standalone
generator-resume path and is green in CI (Node 25). This container is Node 22.
