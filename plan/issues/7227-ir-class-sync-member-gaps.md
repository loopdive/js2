---
id: 7227
title: "IR class members: private static methods, private-method calls, getters and shape-less classes stay on legacy"
status: in-progress
sprint: current
created: 2026-11-04
updated: 2026-11-04
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7223, 3522, 2949, 7106]
assignee: "ttraenkler/c-lead"
# 2026-11-04 (#7227): the private-static / static-`this` / JS concrete-return
# admissions live in the selector's private-call arm, `whyNotIrClaimable`'s
# return resolution and the lowerer's static-call arm; the shared predicates
# moved to the new src/ir/private-member-syntax.ts, the remainder is wiring.
loc-budget-allow:
  - src/ir/select.ts
  - src/ir/from-ast.ts
func-budget-allow:
  - src/ir/select.ts::isPhase1Expr
  - src/ir/select.ts::whyNotIrClaimable
  - src/ir/from-ast.ts::lowerMethodCall
---

# #7227 — the synchronous class-member gaps left after #7223

## Problem

Measured on the #7223 head (PR #7049, `43832916c9`), IR claim ledger, stride
40, standalone: class-member units are 20 IR / 288 legacy. A per-reason count
at the `select-identity.ts` descriptor miss (no single projected descriptor for
the member) splits the ~150 misses like this:

| Shape of the missed member | Units | Owner |
|---|---|---|
| async, generator or async-generator method (any placement) | ~64 | async IR lanes (#1373b, #3527) — **out of scope** |
| ordinary method, class has **no projected shape** at all | ~20 | this issue |
| private static method, sync, plain params | ~16 | this issue |
| getter, shape exists, no getter descriptor | ~14 | this issue |
| default / rest / destructured parameters | rest | out of scope (separate issue) |

Beside the descriptor miss, the same run shows:

- `expr-private-method-member` on `this.#x(N)` / `this.#y(N)` — 12 units;
- `return-type-unresolved(lattice=absent)` on `return this.#m` and friends — 6.

Counts and the instrumented probe are in the C scratchpad
(`ir-ledger/ledger-7223.json`, field `cmu`).

## Implementation Plan (C lead, 2026-11-04; implement on Opus)

Work stacked on #7223 (branch `issue-7223-ir-class-shape-any`); merge
`origin/main` once #7223 lands.

1. **Measure and attribute first.** Rebuild the per-reason probe (instrument
   the descriptor-miss branch in `select-identity.ts` the way the scratchpad
   copy does, in a throwaway copy — never commit it) and confirm the four
   buckets above on your base. For the "no shape" bucket, find WHY
   `buildIrClassShapes` (`src/codegen/index.ts`) drops the whole class: log the
   first refusing member/field/constructor per class. Fix what is common; list
   the rest.
2. **Private static methods.** The static-method projection in
   `buildIrClassShapes` and the selector must admit `PrivateIdentifier` names
   with the same mangling instance private methods already use (#3522 W1-A:
   `privateMemberMangledName` / `resolveClassMemberName`). Check the selector's
   static path for `ts.isIdentifier`-only tests.
3. **Getters.** Find why a projected class gets no getter descriptor (return
   type unprojectable — e.g. function-valued, or `any` paths #7223 did not
   cover; accessor placement evidence). Admit the cases whose legacy slot ABI
   is already representable; keep the rest on legacy and list them.
4. **`this.#m(...)` calls and `return this.#m` reads.** Find the
   `expr-private-method-member` refusal in `select.ts` and the
   `return-type-unresolved(lattice=absent)` path; admit private method calls
   and private field reads on `this` where the descriptor exists, reusing the
   public-member lowering.
5. **Do not touch** the async/generator bucket (other lanes) or the move-only
   scan `dynamicUsesAreMoveOnly` (coordinate on #6583 first if a fix needs it).
6. **Never worse than legacy.** Every newly IR-claimed unit must produce the
   legacy-observable result. Probe each bucket with untyped and typed classes
   against node on 3 lanes, including `+`, comparisons, exceptions, `this`
   identity, subclasses with mixed IR/legacy bodies.

## Acceptance criteria

- Ledger A/B (stride 40, standalone) in the PR body: class-member IR units
  rise; `class-member-unsupported` falls; 0 invariants; `compileOk` not lower.
- Typed playground/benchmark/equivalence corpus byte-identical on gc,
  standalone, wasi (or every changed binary explained and correct).
- A test262 sample of class files (incl. private static / private methods /
  getters): no test that passes on base fails on head (standalone).
- Test: `tests/equivalence/issue-7227-ir-class-sync-member-gaps.test.ts` —
  per bucket, assert the IR route (`trackIrOutcomes`) and the node result.

## Implementation (2026-11-04, Opus)

Test: `tests/equivalence/issue-7227-ir-class-sync-member-gaps.test.ts` — per
bucket, the IR route (`trackIrOutcomes`) and the node result on standalone,
WASI and gc, including string results (compared in-module on every lane, raw on
gc) and the stays-legacy cases.

What changed:

1. **Private static methods** (`buildIrClassShapes`): the static projection
   admits `PrivateIdentifier` names under the instance-private mangling
   (`__priv_m`, legacy key `C___priv_m`). `C.#m()` call sites now project.
2. **`this.#m()` in a static method** (`src/ir/private-member-syntax.ts`,
   `staticPrivateThisCallClassName`, shared by the selector's private-call arm
   and the lowerer's static-call arm): lowered as the static call to the
   owner's own `static #m`. Narrow: the nearest function-like ancestor must be
   the static method of a named `ClassDeclaration` that declares `static #m`.
   Legacy performs no brand check on `this` either (`D.access()` /
   `C.access.call({})` return `C.#m()`'s value on base, where node throws a
   TypeError), so head matches base there — a pre-existing legacy gap, not
   introduced or fixed here.
3. **`return-type-unresolved(lattice=absent)` on JS members**
   (`dynamicDescriptorAbiEvidence` → `fallbackReturnType`): an unannotated JS
   method/getter whose descriptor return is `number` or `string` takes that
   descriptor type, only when ordinary resolution fails and only on host-free
   lanes. JS sources only (`NodeFlags.JavaScriptFile`), so unannotated TS
   members keep their verdict. A boolean descriptor is NOT admitted: it failed
   `class-method typeIdx parity` (an error-severity diagnostic) in probing.
4. **Private method/accessor read as a value** (`this.#m` where `#m` is a
   method or accessor): refused at selection (`expr-private-nonfield-read`)
   instead of claiming and demoting in from-ast (`class C has no field`).

### Measurements (base = #7223 head `43832916c9`)

- **Ledger, stride 40, standalone**: class-member IR 20 → 20 (unchanged);
  `select:class-member-unsupported` 239 → 221; `param-type-not-resolvable`
  31 → 43, `return-type-not-resolvable` 9 → 14 (units moved to later, more
  specific refusals); `build:property-access-unsupported` 1 → 0; invariants
  0; compileOk 1081 → 1081; body routes identical. **The AC "class-member IR
  units rise" is not met on the stride** — see the remaining gaps below; every
  stride unit of this issue's buckets is blocked by something out of scope.
- **Targeted class sample** (1524 test262 files under `language/*/class`
  matching private/static/getter/accessor, async/generator/dstr excluded,
  compiled raw, standalone): IR units 485 → 769 (+284, 80 files), 0 units lost
  IR, 0 compile-success changes; `class-member-unsupported` 1295 → 1147,
  `return-type-not-resolvable` 537 → 172. Same sample on gc and WASI: +284
  IR units each, 0 lost, 0 compile-success changes, no `IR path failed`
  diagnostics on either side.
- **test262 runner A/B, standalone** (536 files: the 199 route-changed files
  plus every 4th of the sample): base and head both 427 pass / 104 fail /
  5 compile_error, identical non-pass lists.
- **Typed corpus bytes** (playground examples, benchmark suites, every
  equivalence snippet; gc/standalone/wasi; 6759 compiles): identical except
  `iterator-protocol-custom.test.ts#2` (all lanes), whose routes are unchanged
  and which hashes identically on base and head when compiled in isolation —
  an in-process ordering artifact (the new test file shifted the shard
  assignment), not a codegen change.

### Remaining gaps (stay on legacy, listed)

| Gap | Stride units | Why it stays |
|---|---|---|
| `static #x(v) { this.#xVal = v; return this.#xVal; }` | 12 | static private FIELDS have no IR representation (`C.a` / `this.a` in a static body is refused today); also `move-only[concrete]:this` |
| `static x() { return this.#x(42); }` with an untyped `#x` | 12 | dynamic return → `move-only[stmt]` (#6583 scope); on files that pass it, the literal arg is `f64` vs the `dynamic` param and the static-call arm demotes. Boxing it there was tried and reverted: the class component then needs `__box_number`/`dyn.to_number` without a Program-ABI symbolic ref and withdraws as `late-preparation-unsupported`, dragging two previously-IR statics with it |
| getters returning a private method (`get method() { return this.#method; }`) | ~14 | function-valued return has no class-position IR type; reading a private method as a value is unsupported |
| private accessors (`get #m()`, `this.#m` reads, `this.#field \|= 1`) | ~10 | private accessor descriptors are out of scope (`class-method`) |
| shape-less classes | ~20 | the instance-method loop in `buildIrClassShapes` drops the WHOLE class when one instance method is unprojectable — measured causes: an `async` method (Promise return), destructured/default params, or `extends` of a builtin (`Iterator`). Making that loop best-effort would change which TS classes get shapes (typed-corpus bytes), so it is left for its own change |
| boolean-returning unannotated JS members | — | IR/legacy slot typeIdx parity mismatch |
| async / generator members, default/rest/destructured params | — | out of scope (other lanes / separate issue) |
