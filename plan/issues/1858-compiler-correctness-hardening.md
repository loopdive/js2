---
id: 1858
title: "Compiler correctness & production-hardening audit (fail-loud, validate, gate)"
status: done
completed: 2026-06-12
created: 2026-06-04
updated: 2026-06-12
priority: high
feasibility: hard
reasoning_effort: max
task_type: refactor+correctness
area: codegen
goal: maintainability
sprint: Backlog
related: [1561, 1172, 1530, 1376, 1784, 1785, 1815, 1816, 1817, 1820]
---
# #1858 — Compiler correctness & production-hardening audit

Second-pass review of the compiler, focused on **correctness and production risk**
(not the modular-decomposition concern tracked in #1561). Conducted 2026-06-04 by
six independent hostile reviewers, one per risk dimension. All `file:line`
anchors below were verified against HEAD; findings are tagged **PROVEN** (confirmed
by code/repro) or **LIKELY** (inferred). Already-filed issues are cross-referenced
rather than duplicated.

## Verdict

This is an impressive research compiler with a **demo-grade correctness posture**.
It is **not** defensible to a compiler engineer, nor safe on untrusted/diverse
input, today — because of one systemic design choice that runs through every layer:

> **When something doesn't fit, the compiler silently produces a wrong answer
> instead of failing loudly — and the CI gates are tuned to let those silent wrong
> answers ship.**

## Root cause: "prefer a wrong answer over a loud failure", at four layers

The same anti-pattern was found independently by four reviewers:

| Layer | Mechanism | Evidence |
|---|---|---|
| Codegen | `stack-balance` **drops a type-mismatched value and substitutes `0`/`null`** ("lossy but valid") | `src/codegen/stack-balance.ts:709-755` — PROVEN repro: a `()->f64` body producing `ref.null.extern` is rewritten to `…; drop; f64.const 0` → returns **0** |
| IR front-end (**ships by default**) | IR build/lower failures **demoted to `severity:"warning"`**, silent fallback to legacy | `src/compiler.ts:666` (`experimentalIR !== false`) + `src/codegen/index.ts` (`severity: isStrict ? "error" : "warning"`; strict-list closed by default) |
| Runtime | `resolveImport` default case **returns a no-op `() => {}`** | `src/runtime.ts:9266` |
| CI | required gate only blocks a **catastrophe (≥200 regressions)**; the zero-tolerance gate is **not required** | `.github/workflows/test262-sharded.yml:566`, `docs/ci-policy.md:47` |

And **nothing verifies the emitted Wasm is valid**: there is no
`WebAssembly.validate()` in the production pipeline; the "typed IR" verifier
(`src/ir/verify.ts`) checks SSA *shape* but **never typechecks operands**; and
**169 `as unknown as Instr` + 490 `as any`** (both grown past the CLAUDE.md
figures, concentrated in the emit path) blind `tsc`. So a type error must survive
to `instantiate`, be hit by a test, *and* exceed 199 siblings before anyone notices.

## CRITICAL findings (miscompiles / corruption)

| # | Finding | File:line | Status |
|---|---|---|---|
| C1 | **stack-balance silently returns `0`/`null` on type mismatch** — turns loud validation failures into silent wrong answers; **amplifies every other codegen bug** (the keystone) | `stack-balance.ts:709-755` (`fixBranchType`), reached via `fixBranch:830`, whole-fn fixup `:2381` | NOVEL, PROVEN |
| C2 | `Array.prototype.sort` **ignores the user comparator** and uses numeric (not lexicographic) default order | `array-methods.ts:5768`, `timsort.ts:441` | filed **#1816**, PROVEN (WAT: `call_ref count: 0`) |
| C3 | **IR ternary → eager Wasm `select`**: both arms evaluated → infinite recursion on `n<=1?1:n*f(n-1)`; `&&`/`||` lose short-circuit | `ir/from-ast.ts:3464-3482`, `:3676` | filed **#1820**, PROVEN |
| C4 | **IR ships by default but its failures are warnings** → silent legacy fallback, no user signal, engineered to keep CI green | `compiler.ts:666`, `codegen/index.ts:1254-1261` | NOVEL, PROVEN |
| C5 | **No `WebAssembly.validate()` in the pipeline + IR verifier never typechecks operands** → invalid Wasm only caught at `instantiate`, only if a test hits it | `ir/verify.ts:112-133`, `emit/binary.ts` | NOVEL, PROVEN/LIKELY |
| C6 | **`try/finally` else-branch branch depths never bumped** — `bumpOuterBranchDepths` reads `(instr as any).elseBody`; the IR `if` field is `else` → wrong jump target / validation failure | `statements/exceptions.ts:55` (field is `else` per `ir/types.ts:224`) | NOVEL, PROVEN |
| C7 | **Standalone enumerates object keys in hash order** (host = spec/insertion order) → `JSON.stringify`/`for-in`/`Object.keys`/`entries`/`values`/`assign` reorder by `--target` | `object-runtime.ts:1099-1102` vs `runtime.ts:5573` | NOVEL, PROVEN (comment admits it) |
| C8 | **`(x >>> 0)` sign-extends** in the i32 fast path → negative for high-bit values (breaks the canonical ToUint32 idiom) | `binary-ops.ts:1247-1252,1330`; correct path at `:2548` | filed **#1817**, LIKELY |
| C9 | `resolveImport` **default → no-op**; standalone **`isFrozen`/`isSealed` wrong** (one bit, ignores descriptors + empty-object rule) | `runtime.ts:9266`; `object-runtime.ts:2063-2065,1963-2001` | NOVEL, PROVEN |
| C10 | **CI lets up to 199 real miscompiles merge green per PR**; **no fuzzing / property / generative differential testing**; negative tests never check error *type* | `test262-sharded.yml:566`, `tests/test262-runner.ts:2541-2625` | NOVEL, PROVEN |

## HIGH findings

- `Array.prototype.splice` **drops inserted items** (args 2+ ignored) — `array-methods.ts:4421` — filed **#1815**, PROVEN.
- **Call-graph closure ignores `ref.func`**: address-taken functions (`arr.map(foo)`, `const g = foo`) get IR-rewritten signatures while a legacy trampoline still calls through the old type → invalid/UB — `ir/select.ts:1932-1979`, `ir/integration.ts:685-698` (the #1602 family) — LIKELY.
- **Exported unannotated functions** get signatures inferred from *internal* callers, not their host contract → host call with off-contract args silently yields `NaN`/wrong — `ir/select.ts:1354`, `codegen/index.ts:552` — LIKELY.
- **Standalone/WASI `Number.prototype.toString()` rounds fractions to 6 digits** → `String(0.1+0.2)` = `"0.3"`, `(1/3).toString()` = `"0.333333"`, `String(1e-7)` = `"0"` — `number-format-native.ts:470-562` (gated `declarations.ts:943`) — PROVEN. Needs shortest-round-trip dtoa (Ryū/Grisu).
- **Standalone/WASI `parseFloat`/`StrToNumber` naive `*0.1` accumulation** loses last-ULP precision — `parse-number-native.ts:299-335` — LIKELY.
- **`C.prototype.method` via JS-side prototype access throws** "not yet supported" — `runtime.ts:3368-3381` — PROVEN.
- **`wasi` vs `standalone` disagree**: dynamic objects compile under `standalone`, hard-refused under `wasi` (gating is `ctx.standalone`-only) — `compiler.ts:955-957`, `late-imports.ts:308` — PROVEN.
- **Standalone refuses `hasOwnProperty`, `getOwnPropertyDescriptor`, `getPrototypeOf`, `for-in`, accessor `defineProperty`** (all work in host) — `late-imports.ts:52-70` — PROVEN.
- **`instrDelta` falls back to `0`** on unresolved `call`/`struct.new`/`call_ref` → poisons stack simulation, `fixBranch` then corrupts correct code — `stack-balance.ts:294,333,343,353,435` — LIKELY.
- **163 of 169 `as unknown as Instr` casts are cargo-cult** (op already in the union) — disable field checking on the most safety-critical ops (`struct.get`/`array.get`/`i64.const`); plus all instruction traversal is `(instr as any).body` (no typed child accessor) — `map-runtime.ts`(76), `walk-instructions.ts:47`, `stack-balance.ts`, `fixups.ts` — LIKELY.
- **`u32` LEB128 encoder truncates ≥2³² and encodes `-1` as `0xFFFFFFFF`** — last line of defense emits plausible-but-wrong bytes instead of throwing — `emit/encoder.ts:14-21` — PROVEN.
- **Late-import shift walker never walks `global.init` / `element.offset`** — latent stale-index bug the moment a `ref.func` is lowered into a global init — `codegen/index.ts:7525-7588` — LIKELY (no producer today).
- **Host ToPrimitive swallows `WebAssembly.RuntimeError`** from user `@@toPrimitive`/`valueOf` and falls through (must propagate per §7.1.1) — `runtime.ts:1907-1975` — LIKELY.
- **AnyValue struct→f64 reads `f64val` for string/object tags** (no ToNumber/ToPrimitive); `f64val` is hard-coded `0` at box time — `type-coercion.ts:1271-1275`, `any-helpers.ts:296-326` — LIKELY.
- **Linear backend is a stale 4,822-line second compiler with zero differential coverage vs WasmGC** — `codegen-linear/index.ts:40` — LIKELY.
- **QA**: 99 grandfathered known-wrong behaviors shipping (`scripts/equivalence-baseline.json`); the differential harness is `continue-on-error: true` against a 2-week-stale 104-program baseline (`diff-test.yml:38`); `--optimize` is functionally unverified (the one test checks only header magic bytes); CLAUDE.md's QA section is stale and references a `tests/equivalence.test.ts` that no longer exists.

## What a compiler engineer will grill us on (credibility)

1. **"Typed, verified IR"** — the verifier never typechecks operands; 163 cargo-cult casts and `(instr as any)` traversal defeat the union; no `WebAssembly.validate()`.
2. **"How do you know it's correct?"** — test262 is largely a dashboard; the real gate only catches ≥200-test catastrophes; **zero fuzzing/property/differential-at-scale**; negative tests pass on *any* failure regardless of error type; 99 grandfathered failures.
3. **"Dual-mode parity"** is marketing — standalone is a partial, *divergent* reimplementation (key order, `isFrozen`, missing `hasOwnProperty`), and the two no-host targets don't agree with each other.
4. **"You ship `-O` but never execute the optimized binary in any test."**

## Remediation plan

### P0 — stop laundering wrong answers + add validation (do first)
- **P0.1 (C1)** `stack-balance.fixBranchType`: replace drop-and-default with **real coercion** (`__box_number`/`__unbox_number`, mirroring `coerceArgType` at `stack-balance.ts:1235-1304`) for f64↔externref / i32↔externref; **`throw`** for genuinely impossible mismatches (ref→f64). **Risk: a blind `throw` will turn today's silent-wrong "passes" into compile errors and may trip the catastrophic gate — must be CI-measured; back off to coercion-where-possible + throw-only-on-impossible.** Senior-dev.
- **P0.2 (C9)** `resolveImport` default → `throw` with the unhandled intent type. Measure.
- **P0.3 (C5)** Add `WebAssembly.validate()` to dev/test compiles (fail the compile on invalid output); add operand ValType checking to `ir/verify.ts` (`operandIrType` is already computed). Surface, don't gate-prod, until measured.
- **P0.4 (C4)** Emit a concise per-fallback diagnostic when the IR path falls back (the report channel the code comment already says was deferred).
- **P0.5 (C6)** `exceptions.ts:55` `elseBody` → `else` (+ route through `walkChildren`); add a value-asserting regression test (`try/finally` with an else-branch `break outer`).
- **P0.6** `emit/encoder.ts` `u32`: `throw` on `< 0` or `> 0xffffffff`.

### P1 — make CI actually gate correctness
- Make the **zero-tolerance regression gate required** (infra exists; `docs/ci-policy.md:47`); use the merge-base baseline to kill drift false-positives.
- Add **property-based differential testing** (`fast-check`: random expr/args → compile→run vs Node→assert equal). Highest-leverage missing safety net.
- Add an **IR-on vs legacy** differential lane and a **WasmGC vs linear** lane; un-stale + auto-refresh the V8 differential baseline; run a test262 slice with `optimize:true` and diff.
- Ratchet `as any` / `as unknown as Instr` counts like the IR-fallback budget; add the 6 genuinely-missing ops to the `Instr` union and delete the cargo-cult casts; add a typed `instrChildren` accessor.

### P2 — close known correctness holes
- Ship #1815 (splice), #1816 (sort), #1817 (`>>>`), #1820 (ternary).
- Standalone key insertion-order (C7); standalone `isFrozen`/`isSealed` + descriptor updates (C9); shortest-round-trip dtoa for standalone numbers; correctly-rounded standalone `parseFloat`.
- Fix the `ref.func`/address-taken signature-divergence (HIGH) and exported-function-contract inference (HIGH).

### P3 — honesty / hardening
- Decide whether "dual-mode parity" is a real guarantee (then test both targets against the same corpus) or **downscope the claim**; align `wasi`/`standalone` object models.
- Implement standalone `hasOwnProperty`/`getOwnPropertyDescriptor`/`getPrototypeOf`; make `C.prototype.method` dispatch into the compiled method instead of throwing.
- Fix the stale CLAUDE.md QA section (dead `tests/equivalence.test.ts` reference); attach owners + decay targets to the 99 grandfathered failures.

## Acceptance criteria
- [ ] P0.1–P0.6 landed; no catastrophic test262 regression (net measured in CI); C1/C6 covered by value-asserting tests.
- [ ] `WebAssembly.validate()` runs in test compiles; at least one previously-silent invalid-Wasm case now fails loudly.
- [ ] A property-based differential test harness exists and runs in CI.
- [ ] The zero-tolerance regression gate is a required check (P1).
- [ ] This issue's findings are each either fixed, filed as a child issue, or explicitly accepted with rationale.

## Provenance
Six-reviewer hostile audit, 2026-06-04. Reviewer transcripts summarized above;
all line numbers verified against HEAD. Companion to #1561 (modular decomposition).

## P0 implementation notes (2026-06-04, senior-dev)

PR `issue-1858-p0-fixes` lands the **safe, proven** fail-loud quick wins
(P0.2 / P0.4 / P0.5 / P0.6). **C1 (P0.1) is split out** — see the dedicated
section below.

### Landed in this PR

- **P0.5 (C6) — try/finally else-branch break depth.** `src/codegen/statements/exceptions.ts`,
  `bumpOuterBranchDepths`. The proven field-name bug (`(instr as any).elseBody`
  vs the IR `if` op's `else`) turned out to be **necessary but not sufficient**.
  Two compounding defects together miscompiled a `break/continue outer` reached
  from a nested `if` inside a finally into an **infinite loop** (a far worse
  symptom than the audit's "wrong jump target"):
  1. The walk recursed via `.body`/`.elseBody`, so a branch nested in an `if`
     was never visited (the `then` arm was missed too — `if` has no `.body`).
  2. The membership test compared the branch's RAW depth against `outerBreakDepths`
     with **no local-nesting correction**. A nested `br 4` (one `if` deep,
     `outerBreakDepths = {3,1}`) failed `has(4)` and was left un-bumped at the
     `cloneFinallyAtDepth(+1)` site (the inner catch_all that wraps a catch
     body). It then landed on the `loop` label ("continue") instead of the
     outer `block` ("break") → endless loop. Verified: `test(0)` on the repro
     hangs on buggy code, returns `11000` (matching Node) with the fix.

  Fix: route descent through `walkChildren` (canonical `then`/`else`/`catches`/
  `catchAll` traversal) AND carry a `localDepth` counter incremented when
  descending into a label-creating op (`block`/`loop`/`if`/`try`); the
  membership test becomes `outerDepths.has(d - localDepth)`. This preserves the
  existing "internal labels untouched" invariant (internal branches have
  `d < localDepth` → `d - localDepth` below any outer depth). Value-asserting
  regression test: `tests/issue-1858-finally-else-break.test.ts` (the CRITICAL
  cases force the catch body to re-throw so the inner catch_all clone runs;
  proven red — hang/timeout — without the fix).

- **P0.2 (C9a) — `resolveImport` default no-op → throw.** `src/runtime.ts`
  (~L9266) `default: return () => {};` → `throw new Error("Unhandled
  ImportIntent type: …")`. **Regression-safety verified statically:** all 33
  `ImportIntent` union members in `src/index.ts` are handled by an explicit
  switch case (diff of union-types vs switch-cases is empty), so the default is
  unreachable for any valid intent today — the throw only fires on a genuine
  unhandled type (a bug). Expected CI impact: none. (If CI flips a test red, it
  was relying on a no-op import = a latent bug; report, don't paper over.)

- **P0.6 (u32 LEB128 garbage).** `src/emit/encoder.ts` `u32()` — added
  `if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new
  RangeError(...)` at the top. Pure additive guard; only fires on
  already-broken input (negative/truncating/non-integer). Unit test:
  `tests/issue-1858-u32-guard.test.ts` (round-trips the full valid range,
  throws on `-1`, `>=2^32`, non-integer).

- **P0.4 (C4) — IR fallback visibility.** `src/codegen/index.ts` (~L1254) —
  appended a greppable ` [IR-FALLBACK]` tag to the per-fallback diagnostic
  message. Kept the leading `"IR path failed for …"` text intact because many
  bridge tests filter on `e.message.startsWith("IR path failed")` (issue-1182,
  -1183, -1169*, etc.). Message-only; does NOT change codegen or promote the
  fallback to an error (that ratchet stays owned by `STRICT_IR_BUILD_ERRORS` /
  #1530).

### C1 implementation notes (split out — follow-up)

C1 (P0.1, `stack-balance.ts` `fixBranchType`, the drop-and-default keystone) is
**deliberately NOT in this PR.** Reasons:

1. **Cannot be landed without a measured test262 delta**, which only CI
   produces. Per the issue's own risk-management guidance, C1 must be measured;
   a blind change can trip the catastrophic-regression gate (≥200 pass→fail) by
   converting today's silent-wrong "passing" entries into compile errors.
2. **The correct fix (coerce-where-possible) needs non-trivial plumbing.** The
   real box/unbox coercion logic lives in `coerceArgType` (`stack-balance.ts:1182`,
   body at `:1235-1304`) and requires `boxNumberIdx` / `unboxNumberIdx` (the
   `__box_number` / `__unbox_number` import indices). `fixBranchType`
   (`stack-balance.ts:678`) and `fixBranch` (`:773`) currently have **no access
   to those indices** — they receive only `(body, blockType, types, sigs)`. So
   C1 requires threading the two indices from the whole-function fixup call site
   down through `fixBranch` → `fixBranchType`, then replacing the lossy arms:
   - `f64 → externref` (`:709-715`): `drop` + `ref.null.extern` → `call boxNumberIdx`
   - `i32 → externref` (`:717-722`): `drop` + `ref.null.extern` → `f64.convert_i32_s` + `call boxNumberIdx`
   - `externref → f64` (`:724-729`): `drop` + `f64.const 0` → `call unboxNumberIdx`
   - `externref/ref → i32` (`:750-755`): `drop` + `i32.const 0` → `call unboxNumberIdx` + `i32.trunc_sat_f64_s`
   - genuinely-impossible mismatches (e.g. struct `ref` → f64 with no box import,
     `:737-742`): keep a fallback but make it a **`throw`** carrying the
     function/op context instead of silent drop-and-zero.
3. **Recommended rollout:** implement coerce-where-possible first (indices
   non-null path), measure the CI test262 delta; only convert the
   genuinely-impossible arms to `throw` once the coercion paths are confirmed
   net-positive/neutral. If the throw causes a large pass→compile_error
   regression, gate it behind a dev/test flag and surface (don't gate-prod)
   until measured — mirror P0.3's "surface, don't gate-prod" approach.

## Closed as audit-complete (2026-06-12)

The audit is done and its residuals are filed: C1 → #2140 (fixBranchType coerce-or-throw), C5 → #2143 (validate unoptimized output); quick wins landed via PR #1145 and the 1815-1852 sub-issue series. Remaining audit rows C7 (standalone key-enumeration order) and C9b (isFrozen/isSealed) are tracked in #2148's reconciliation scope for individual filing.
