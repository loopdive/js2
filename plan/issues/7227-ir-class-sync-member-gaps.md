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
  # 2026-11-05: bounded SOURCE getter receiver/call/name ownership joins.
  # Exact measured growth and retained semantic/runtime limits are below.
  - src/codegen/class-bodies.ts
  - src/codegen/closure-exports.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/closures/method-trampolines.ts
  # 2026-11-05: remaining current-main SOURCE receiver/protocol owner joins.
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/array-methods.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/statements/variables.ts
  - src/codegen/property-access.ts
  - src/codegen/binary-ops.ts
  - src/codegen/expressions/call-builtin-static.ts
  # 2026-11-05 Source24: exact function-marker provider/commit handles for both descriptor appliers.
  - src/codegen/object-runtime-descriptors.ts
  # 2026-11-05 Source05: exact native timer value, canonical mint and real export-intent owners.
  - src/runtime.ts
  - src/codegen/registry/imports.ts
  - src/codegen/declarations.ts
# 2026-11-05: exact native-owner reuse; per-path token deltas recorded below.
standalone-arms-allow:
  # 2026-11-05 Source26: canonical predicate/native accessor/rejection owners; exact token counts below.
  - src/codegen/context/types.ts
  - src/codegen/object-ops.ts
  - src/codegen/object-model/define-rejection-channel.ts
  # 2026-11-05: existing callable metadata reserve/fill/descriptor-seed owner in WASI.
  - src/codegen/function-instance-props.ts
  - src/codegen/object-runtime.ts
  - src/codegen/fn-intrinsic-seed.ts
  - src/codegen/array-methods.ts
  - src/codegen/class-proto-lookup.ts
  - src/codegen/class-proto-object.ts
  - src/codegen/closed-struct-extern-set.ts
  - src/codegen/declarations/ir-dynamic-parameter-abi.ts
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/inherited-set-gate.ts
  - src/codegen/standalone-class-prototype-read.ts
  - src/ir/prepared-dynamic-support.ts
import-cycles-allow:
  - largestSccSize: 730 # 2026-11-05 (#7227): the separate SOURCE getter family owner joins actual metadata/type/undefined/wrapper allocation; pure predicate and shared identity dependencies remove incidental cycles.
func-budget-allow:
  - src/ir/select.ts::isPhase1Expr
  - src/ir/select.ts::whyNotIrClaimable
  - src/ir/from-ast.ts::lowerMethodCall
  # 2026-11-05: exact existing call/receiver/alias owner joins measured below.
  - src/codegen/closure-exports.ts::emitClosureCallExportN
  - src/codegen/closure-exports.ts::emitClosureMethodCallExportN
  - src/codegen/expressions/calls.ts::compileCallExpression
  - src/codegen/property-access-dispatch.ts::tryLengthAndNameReads
  - src/codegen/class-bodies.ts::collectClassDeclaration
  - src/codegen/statements/variables.ts::compileVariableStatement
  - src/codegen/binary-ops.ts::compileBinaryExpression
  - src/codegen/class-bodies.ts::compileClassBodiesInner
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
  - src/codegen/expressions/call-builtin-static.ts::compileBuiltinStaticCall
  # 2026-11-05 Source24: bind the existing canonical deletion transaction into both descriptor appliers.
  - src/codegen/object-runtime-descriptors.ts::buildObjectDescriptorHelpers
  # 2026-11-05 Source05: exact native timer and authenticated numeric-boundary publication owners.
  - src/runtime.ts::resolveImport
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  # 2026-11-05 Source05: unchanged 309-line extern-method callback renumbered #94 -> #95.
  - src/runtime.ts::<anonymous>#95
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

## Round 2 (review of #7054, 2026-11-04)

- **Blocker fixed — option (b).** The concrete-return fallback now applies to
  JS **static methods only**. An IR instance body (getter AND method — the
  method variants `d.value.call({})`, `Reflect.apply(m, {}, [])` trap the same
  way) dereferences the `ref.null` that `__obj_meth_tramp_*_cached` passes for a
  foreign receiver, where the legacy body raises a catchable TypeError. Option
  (a) (a receiver check in the IR instance entry or the trampoline) was not
  taken: the trampoline's foreign-receiver `ref.null` passthrough is deliberate
  (#2025 — throwing there regressed PR #1571), and an IR-entry check would
  change every IR instance body in the typed corpus. The pre-existing trap for
  TS-annotated IR getters/methods on a foreign receiver (`get v(): number`,
  reproduced on base) stays open for a follow-up.
- **Same-named classes**: a private static call (`this.#m()` / `C.#m()`) whose
  class name is declared more than once in the file is refused
  (`classNameIsAmbiguous`), since the static-call arm keys shapes by name.
- Tests: the 6 foreign-receiver getter variants (public/private field,
  number/string, `{}`/`{x: 9}`) on 3 lanes assert a caught TypeError and the
  legacy route; the instance getter/method case now pins the legacy route; the
  shadowed-class-name case pins `C_access` legacy.
- The reviewer's 94 probes (merge-base `3b6f1729ef` vs head, gc/standalone/
  wasi): 0 value differences from base.
- Round-2 measurements (base = `origin/main` `110bb3d819`, head = round-2
  merge):
  - ledger stride 40 standalone: class-member IR 20 → 20;
    `select:class-member-unsupported` 239 → 216; invariants 0; compileOk 1081
    → 1081; body routes identical;
  - 1524-file class sample (standalone): IR units 485 → 628 (+143 in 33
    files; round 1's +284 included the instance getters/methods now kept
    legacy), 0 lost, 0 compile-success changes;
  - test262 runner A/B (same 536 files, standalone): 427 / 104 / 5 on both,
    identical non-pass lists;
  - typed-corpus bytes: 6780 compiles × (gc, standalone, wasi), 0 diffs.

## 2026-11-05 bounded SOURCE getter receiver ownership continuation

The current reconciliation preserves the nominal getter entry and separately
registers the receiver-capable getter body as SOURCE, not as an AST-free helper
or IR body. Its exact callable capability carries raw strict `this`, source
name/length metadata and canonical argument state; unknown ownership fails
explicitly. Public foreign getters use actual Get/Call semantics, while private
brands and nullish property access retain their canonical error owners. The old
foreign-getter TypeError/legacy measurements above remain historical, not the
current JavaScript contract. Ordinary instance methods are not claimed fixed.

The normal checkpoint LOC gate measured the following bounded ownership joins:
class-bodies 4389 → 4520 (+131), closure-exports 2149 → 2205 (+56),
property-access-dispatch 5419 → 5426 (+7), identifiers 3367 → 3368 (+1),
and method-trampolines 1500 threshold → 1566 (+66). These exact existing
producer/consumer paths receive this change-set's allowance; the standalone
capability representation lives in its separately inventoried subsystem leaf.
No main-only baseline or global policy is changed. Function budgets, normal
hooks, current-main qualification and protected CI floors still apply.

The latest focused population remains 163 with three retained failures in the
unchanged arguments/name program. Source fixes now preserve original HOF array
identity and read forwarded callable names at runtime; they are not yet
runtime-qualified. The authored core 259 and every retained assertion remain
unchanged. No whole-suite PASS or getter IR-only credit is claimed here.

### Normal checkpoint function-budget measurement

With the five LOC grants applied, the normal LOC gate passes. Its actual
method-trampolines baseline is 1447 → 1566 (+119); the previous record states
the separate newly-crossed threshold (1500 → 1566, +66), not that baseline.
The subsequent function gate measures these exact existing owner joins:

- closure free-call dispatcher 414 → 442 (+28) and method-call dispatcher
  506 → 527 (+21): recognize and route the distinct SOURCE capability before
  ordinary closure dispatch, preserving canonical argument state/raw receiver.
- compileCallExpression 2348 → 2361 (+13): preserve actual callable provenance
  instead of misusing a checker signature for mutable/foreign call/apply values.
- tryLengthAndNameReads 678 → 685 (+7): aliased callable values read their own
  runtime name rather than inventing an empty binding-derived name.
- collectClassDeclaration 1152 → 1158 (+6): preallocate the separate exact
  SOURCE callable owner while retaining the nominal getter entry.
- compileVariableStatement 1383 → 1389 (+6) and compileIdentifierCore
  1371 → 1372 (+1): retain the actual generic receiver's dynamic alias carrier.
- compileBinaryExpression 1822 → 1825 (+3): use the canonical dynamic plus
  owner for the generic receiver context, including real string/valueOf behavior.
- compileClassBodiesInner 1431 → 1433 (+2): schedule the source getter variant
  independently of skipping an already-IR nominal entry.

Only these named functions receive this issue-local allowance. The existing
subsystem capability/body owners retain their classification and implementation;
no global function baseline, semantic assertion or required gate is relaxed.
This gate failure occurred before changed-root tests; it adds no runtime credit.

### Current-main SOURCE getter owner LOC measurement

The final current b412 qualification passed normal format and lint, then stopped
at the LOC gate before typing or any tests. Compared with that receiving main,
the gate measured these already-reviewed producer/consumer changes:

- call-receiver-method 4819 → 4892 (+73): route the separate SOURCE callable
  through canonical call/apply/bind while retaining actual raw receiver and
  argument state; ordinary certified call paths retain their own ABI.
- array-methods 10874 → 10938 (+64): preserve canonical callback argument state,
  rest packing and the original callback array for the SOURCE family.
- calls 10893 → 10924 (+31): classify actual callable provenance and join the
  receiver-capable SOURCE entry without trusting a mutable checker signature.
- variables 2583 → 2589 (+6): retain the generic receiver's dynamic alias carrier.
- property-access 6965 → 6970 (+5): reuse the canonical nullish receiver guard
  without treating a generic receiver's declaring checker type as a proof.
- binary-ops 3399 → 3402 (+3): use canonical dynamic addition for generic getter
  values, preserving string concatenation and once-only coercion.
- call-builtin-static 4728 → 4729 (+1): reuse the native inline-literal prototype
  owner in WASI while keeping the compiled-class bridge standalone-only.

Only these existing subsystem paths receive this issue-local LOC allowance.
No main-only baseline, global policy, executable source or assertion changes.
The complete current 1,455-case population remains unrun at this checkpoint;
function, import-cycle, inventory, typing, normal hooks and protected floors
still apply. Previous failures and their exact historical measurements remain.

The subsequent current-main function gate passed every prior named allowance
and measured compileBuiltinStaticCall 3865 → 3866 (+1). Its one added line keeps
the compiled-class prototype bridge standalone-only while the canonical native
inline-literal prototype writer serves WASI too. This exact existing owner gets
an issue-local function allowance; source, assertions and global baselines are
unchanged. Typing and all 1,455 current cases remain unrun at this checkpoint.

### Native-owner reuse and exact standalone-arm one-off

The current qualification passed format, lint, LOC, function, oracle and
coercion gates, then stopped before typing/tests at the standalone-arm ratchet.
The shared native implementation now serves WASI as well as the existing native
regime; these are not separate per-target lowerers. Repeated positive-union and
dual-negative checks reuse the existing canonical noJsHost owner, whose actual
body is exactly wasi-or-standalone. The latter standalone field is the native
semantic regime and can be true for GC, so replacing it by environment-only
hostFreeEnvironment would incorrectly drop existing GC behavior.

The per-path token deltas against receiving b412 below are explicit reviewed
one-offs in this issue, not an exemption for unrelated future code:

- src/codegen/array-methods.ts: ctx.standalone -1, noJsHost( +1; canonical opaque native callback recovery; WASI must not request a JS callback import.

- src/codegen/class-proto-lookup.ts: ctx.standalone -1, !ctx.standalone -1, noJsHost( +1; the same nominal-tag/prototype lookup owner now serves the native WASI provider.

- src/codegen/class-proto-object.ts: ctx.standalone -3, !ctx.standalone -3, noJsHost( +3; the same real class-prototype object producer and expression readers serve WASI.

- src/codegen/closed-struct-extern-set.ts: ctx.standalone -3, !ctx.standalone -1, noJsHost( +1; the same native writable-field/descriptor owner, retaining all storage and dirty-key checks.

- src/codegen/declarations/ir-dynamic-parameter-abi.ts: noJsHost( +1; one physical dynamic-externref carrier authority; fast and actual host-free conditions retained.

- src/codegen/expressions/call-builtin-static.ts: ctx.standalone +1, noJsHost( +1; native inline prototype writer reuse while the distinct compiled-class bridge stays standalone-only.

- src/codegen/expressions/call-receiver-method.ts: noJsHost( +2; canonical captured foreign method call uses native argument vectors or the existing host import owner.

- src/codegen/expressions/calls.ts: ctx.standalone -1, noJsHost( +1; the existing inline-literal prototype writer shared by native providers; other expressions unchanged.

- src/codegen/inherited-set-gate.ts: noJsHost( +1; one native descriptor-demand gate reused by all actual inherited-Set consumers.

- src/codegen/standalone-class-prototype-read.ts: ctx.standalone -2, !ctx.standalone -2, noJsHost( +2; the same nominal-tag and singleton identity reads for native class prototypes.

- src/ir/prepared-dynamic-support.ts: ctx.standalone +1, ctx.wasi +1; exact prepared provider/carrier bindings; standalone Number conversion remains with its actual owner.

The prepared IR sidecar keeps its existing explicit carrier/provider checks
instead of adding a new IR-to-codegen import edge merely for spelling. Actual
standalone-only Number conversion and compiled-class prototype bridges remain
unchanged. No new predicate facade, field rename, duplicate semantic lowering,
main-only baseline, global ratchet policy or test assertion is introduced.
The full current 1,455-case acceptance remains pending, with every prior RED
preserved; these grants confer no runtime, byte-identity or IR-only credit.

### Exact SOURCE family import-cycle ownership

The current gate first measured largest SCC 729 → 734 and a codegen-to-IR
edge 301 → 302. Moving the unchanged pure noJsHost predicate to the existing
context layer (with its old re-export intact) and importing the exact shared
identity implementation removed the incidental growth: the actual subsequent
gate reports largest SCC 730 and codegen-to-IR exactly 301. There is no new
cross-directory allowance.

Only closures/source-getter-receiver.ts among this change-set's seven new
source modules belongs to that measured SCC. It is the real SOURCE capability
family owner: it registers physical callable metadata/types, canonical undefined
and the existing safe closure header, and is consumed by the exact source
producer and both guarded dispatchers. Its accounting remains SOURCE; this is
not an AST-free helper exclusion or new semantic implementation. The existing
registry/metadata/undefined/wrapper owners remain authoritative.

This change-set grants only the measured largestSccSize 730, with the receiving
main's 729 and inherited historical 725 retained here. No committed import-cycle
baseline, cross-directory threshold, global policy or assertion is changed.
The normal typing and whole current 1,455-case qualification are still pending;
all previous gate failures and their complete output remain preserved.

### WASI SOURCE callable metadata: actual producer/reader join

The complete current population actually ran 1,455 cases: 1,452 passed and
three failed. Authentic unmodified b412 whole #4440 has the same 12 passed /
two failed rows as the candidate; those original programs/assertions remain
unchanged. A separately instrumented original WASI getter-protocol observation
retains its expected failure: free/call/apply/bind/HOF = 5/6/6/6/10, length 0 and
callability all match Node; only the name comparison is 0 rather than 1. Its
binary validates and imports only WASI fd_write/proc_exit. Getter and outer
function remain legacy; its generic body retains actual derived SOURCE records.

Actual retained WAT contains the metadata struct/global and registered SOURCE
closure family, but no __fninst_meta, __fninst_bag_owns or builtin metadata read,
descriptor/delete/own-name helper. The SOURCE producer already materializes the
canonical fnMetaSlotOfMeta payload; object-runtime reservation/reader handles and
function-instance-props reserve/fill stop at standalone-only guards. This repair
reuses their existing native owners in WASI and includes the same descriptor
seed owner, so define/delete/redefine cannot disagree with a name read. No
constant name fold, builtin identity, SOURCE/IR exclusion or second metadata
implementation is introduced. The existing builtin-fill precedence remains.

Exact source-line arm deltas for this bounded native-owner reuse are:

- src/codegen/function-instance-props.ts: ctx.standalone -2, !ctx.standalone -2, noJsHost( +2.

- src/codegen/object-runtime.ts: ctx.standalone -6, noJsHost( +5.

- src/codegen/fn-intrinsic-seed.ts: ctx.standalone -1, !ctx.standalone -1, noJsHost( +1.

Only these three existing owners receive the documented per-change-set arm
one-off. Main baselines/global policy and all original 1,455 assertions remain
unchanged. One genuine Node-comparable descriptor/read/define/delete/redefine
program adds three lane registrations, making the prospective complete current
population 1,458. It checks metadata flags and final raw-receiver invocation,
not a mocked ABI. The new shared owner/control bytes remain UNRUN here; all
previous results, failures and original #4440 historical expectations are kept.

The control reads function names through an actual value-parameter helper, so
checker literal narrowing across defineProperty cannot substitute an old name
for the current function object; descriptor/flags and actual call remain checked.


## 2026-11-05 — function metadata deletion and descriptor transaction binding

The actual Source24 normal gates measured object-runtime-descriptors.ts at
2,948 → 2,956 source lines (+8), and its existing buildObjectDescriptorHelpers
at 2,744 → 2,751 counted function lines (+7). The import and concrete handle
bundle wire the actual reserved function-identity marker query plus canonical
OrdinaryDelete into both existing data/accessor descriptor appliers. These exact
owner bindings receive the issue-local LOC/function grants above; no global
baseline, policy, attribute, assertion or gate changes.

The same attempt measured fillFunctionInstanceProps at 416 counted lines,
crossing 300. Its two concrete marker instruction-array factories are extracted
within the same module instead of granting that growth. Source inversion proves
their complete instruction recipes and fill order unchanged; runtime/typing and
the new measured function sizes remain pending. The hidden marker survives a
rejected definition, while successful new definitions retain the canonical
attribute defaults, configurability checks, sequence and insertion owners.

All prior gate failures, the actual first metadata phase and both historical
#4440 baseline failures remain retained. No new test PASS is inferred here.
The three existing new metadata controls are strengthened without changing
names/counts; all old 1,455 assertions remain unchanged. Focused qualification
is 42 active checks (three metadata lanes plus 39 whole unchanged descriptor/name
neighbors), with the other 98 getter rows explicitly unselected and receiving
no credit. Complete current 1,458-case qualification remains pending.


### Source24 extraction follow-up: measured 311-line installer

The next normal run passed LOC with the exact driver binding allowance but
measured fillFunctionInstanceProps at 311 counted lines after the first two
complete factories (down from 416, still above 300). No typing or test child
ran. Preserve that RED. The complete existing marker-inclusive bag-ownership
LOOKUP body is now the third same-module factory, with explicit primitive
handles and the same params/local index, allocation-free behavior and native
registration order. Whole-file inverse/source recipe equality is retained;
no installer allowance, global baseline or test/expectation change is added.
New actual gate sizes and focused/full runtime results remain pending.


## 2026-11-05 — exact native-owner standalone-arm one-off

Source26's real normal run passed format, lint, LOC, function, oracle and
coercion checks, then the standalone-arm ratchet reported net `noJsHost(` +4.
The actual three ungranted path measurements against the pinned b412 base are:

- src/codegen/context/types.ts: ctx.standalone 4 → 5, noJsHost( 0 → 1,
  ctx.wasi 0 → 1. This is the already-reviewed pure canonical noJsHost helper
  moved verbatim from js-errors with its compatibility re-export retained.
  Publishing that same predicate is not a second mode policy.
- src/codegen/object-ops.ts: noJsHost( 2 → 4. The two reviewed operation owners
  reuse it for native literal-prototype construction and native descriptor
  accessor closure construction. The separate standalone-only class bridge and
  all host/capability/carrier guards remain intact. Actual WASI emission showed
  a live env.__make_getter_callback feeding __defineProperty_accessor; the fix
  selects that applier's existing native closure operand instead of a JS bridge.
- src/codegen/object-model/define-rejection-channel.ts: noJsHost( 0 → 2. The
  already-native WASI descriptor applier must use the existing parked-TypeError
  identity channel and existing boolean consumer. All validation, same-payload
  catch and unrelated-error propagation stay in the canonical owner. This
  rejection obligation is source-proven and was not reached in the prior
  instantiate failure; it is not claimed as a second measured runtime failure.

Only these exact three paths receive the documented per-change-set one-off.
No global arm baseline, policy, helper spelling, descriptor decision tree,
assertion, test name or mode is changed. All measured REDs remain retained.
The original same-guest WASI artifact is valid, has positive Node result 1, and
imports fd_write plus the erroneous getter callback; no fake env bridge is
supplied. The original focused 42 must still run on the corrected source, then
complete current qualification with the two authentic #4440 baseline failures
kept distinct. No PASS is inferred from this issue-local disposition.


## 2026-11-05 — module-initializer chunk coverage successor

The original mixed string/number initializer is now admitted by the shared
primitive-concatenation rule. On unchanged canonical main `2ecc07d5`, the whole
11-test fixture measured 10 passes and one failure at its old refusal-code
assertion. The same eleven statuses and full failure payload matched the
committed receiving source `8857f0e4`. This is historical attribution, not a
passing qualification of that fixture.

Three separate controls then passed on that receiving source: the exact
original guest with its original helper/options; an active error branch with
real Node and native Wasm error-text comparison; and the same original guest
with only the existing numeric-formatter capability withdrawn through a
restored-in-finally test spy. The active error diagnostic alone explicitly
requests the canonical `hostBridge: "always"` rendering exports. It is not an
exact-option baseline. No production capability or test-only rejection was
added. The withdrawal made 37 real capability queries and reached the ordinary
`operand-coercion-unsupported` selection refusal before any IR chunk body was
published; the real legacy chunks still executed.

Installed-function receipts, complete final WAT bodies/numeric call slots and
source/parent/terminal derived-unit records were joined. The normal and active
overlays retain both direct and IR body-emission flags and the physical
`derived-legacy-owner` census. This is not AST-free or IR-only qualification.
The maintained successor keeps the original guest, all original refusal
assertions under a genuine missing-capability boundary, and the ten other
original tests. It adds the normal current-admission and active-error tests:
13 tests prospectively. Their maintained whole-file qualification is pending.
The historical 1,581-test run remains 1,578 passed/three failed, with all three
paired to authentic unchanged baselines; no full 1,583-test pass is inferred.
The two unchanged #4440 failures remain recorded and outside this PR's changed
fixture set.

### Historical original default-capability case (verbatim)

The following complete original case preserves the former default-capability
assertion contract and its guest. It is historical evidence; current progress
is checked by the stronger normal-admission and active-error cases, while the
original refusal assertions remain live under real capability withdrawal.

```typescript
  it("emits legacy chunks, and no IR chunk, when selection refuses the initializer", async () => {
    // This original mixed string/number `+` guest now refuses during selection,
    // before IR chunk names are reserved. The legacy initializer must still
    // retain its bounded helpers; a collision suffix is not an ownership proof.
    const result = await compileHarnessBody(
      [
        "var tick = 0;",
        ...FILLER,
        "if (-1 << 0 !== -1) { throw new Test262Error('#1: -1 << 0 === -1. Actual: ' + (-1 << 0)); }",
      ].join("\n"),
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(moduleInit(result)?.code).toBe("operand-coercion-unsupported");
    expect(moduleInit(result)).toMatchObject({
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
      irBodyEmissions: 0,
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    // Both lanes share the preferred prefix; only real name collisions add a
    // numeric suffix. Join declared helpers to the dispatcher's actual calls.
    const chunks = watFunctionNames(result.wat).filter((name) => /^__module_init_chunk_\d+(?:_\d+)?$/.test(name));
    expect(chunks.length).toBeGreaterThan(1);
    expect(watCallTargets(result.wat, watFunction(result.wat, "__module_init"))).toEqual(
      expect.arrayContaining(chunks),
    );
    const dispatchedChunks = watCallTargets(result.wat, watFunction(result.wat, "__module_init")).filter((name) =>
      chunks.includes(name),
    );
    expect(dispatchedChunks).toEqual(chunks);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const mod = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(mod)).toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    (instance.exports.__module_init as () => void)();
  });
```


### Fresh quality review — remove one dead callback-builder argument

The independent review found `vecTypeIdx` unread by
`buildBridgeCallInstrs`. Remove only that parameter and the three plain local
identifier arguments threaded into it. The complete instruction-builder body
is byte-exact before normal formatting; receiver, argument-state, conversion,
provider and callback dispatch recipes are unchanged. No binary byte-identity
claim is inferred. This is the only additional production delta beyond the
qualified `8857f0e4` source. Qualify the whole 13-test chunk successor plus the
unchanged whole 101-test getter/callback neighbor and normal typing/gates;
those new checks are pending. All prior failures and source epochs remain
recorded, with no full 1,583-test pass inferred.


## Published-head CI owner and callable-demand repair — 2026-11-05

The first published receiving head exposed two genuine integration regressions.
The exact compiler timer shim has a specialized dynamic-support producer; the
expanded ordinary producer could now claim the same instruction objects too.
The canonical exact timer inventory predicate moves to the existing injected
shim seam. Only the general producer excludes those terminal owners; complete
dependency/sealing inputs and duplicate-claim rejection remain unchanged.

Separately, preparing the SOURCE getter recognition family reserved an ordinary
zero-argument signature and incorrectly counted it as callable allocation demand,
even in modules with no local getter. Signature and IR closure caches now retain
the exact metadata for support-only reservations. Actual ordinary/host allocations
promote the cached base/captured records; a real SOURCE getter singleton promotes
its canonical zero-argument bare entry. Source-accounting enrichment is preserved.
Physical SOURCE capability recognition in modules without local getters remains
available, with the same explicit unowned-family refusal.

Original export censuses, telemetry parity assertions and all getter programs
remain intact. Added controls exercise exact timer/general producer separation,
real ordinary boxing evidence plus duplicate rejection, and cached closure
reservation/promotion. The earlier qualification and CI failures stay historical;
this source repair has no new runtime, CI or retirement credit until measured.


### 2026-11-05 — Exact timer isolation includes the no-work census

The unchanged Async guest's injected late-seal and late-lower controls both
compiled successfully with valid binaries. Complete retained outcomes show the
same five exact source-function owners (`delay`, `fetchUser`,
`fetchAllSequential`, `fetchAllParallel`, `main`) emitted through IR with no
legacy body, while the exact timer owner reported its injected unsupported
resolve result with a legacy body. A separate `<module-init>` non-executable
census row has no terminal unit ID and emits neither body. The original broad
non-timer filter counted that census as a sixth patch, so its five-patch assertion
failed before checking the body flags.

The successor retains the five-patch assertion and every guest/option/injection
and runtime assertion, verifies all five exact source identities, and separately
requires exactly the canonical no-work census. It does not grant another
executable owner or remove outcome evidence. The original 176/180 result and two
unchanged-assertion diagnostic failures remain historical failures. This source
change is not runtime qualification or attribution of the two separate host timer
failures, which remain unresolved.

### 2026-11-05 — Native timer value and Promise boundary owner growth

The unchanged JavaScript-host timer observations fail on both authentic main
and the receiving source: a real Node Timeout becomes a non-finite exported
handle, and an exported dynamic Promise does not settle within the original
one-second assertion. The paired observations retain the same failure payloads;
they do not establish identical generated binaries or exempt the changed timer
fixture from required CI.

The reviewed repair keeps the protocol in its existing owners. The native
numeric functions are authenticated at their actual allocator, their public
exports are checked against those exact objects, and real source export intents
cannot be silently hidden by an earlier boundary descriptor. Erased type exports
remain erased. Numeric timer references publish both readers and the boxer;
the existing ToPrimitive walker accepts function inputs through the normal
object protocol and rejects function-valued exotic results without coercing
them again. The real dynamic export-result owner reserves the existing Promise
subscription bridge; parameter-only and no-host policy gates remain unchanged.

The first actual formatted-source qualification passed format and lint, then
stopped naturally at these three measured LOC limits before typing, collection
or guest execution:

- `src/runtime.ts`: 20,232 to 20,258 (+26). This is the existing private
  carrier/ToPrimitive/exception-tag owner wiring for the timer value boundary and
  its real function-valued primitive-result checks. It adds no AST fallback,
  substitute host exception or global coercion policy switch.
- `src/codegen/registry/imports.ts`: 2,173 to 2,187 (+14). The existing canonical
  native union allocator retains the exact three numeric function objects.
  Names, shapes, signatures or a later locator alone do not certify ownership;
  moving this record away from the allocator would lose that provenance.
- `src/codegen/declarations.ts`: 6,668 to 6,680 (+12). This is existing public
  export ownership: the same numeric publication authority serves dynamic
  values, actual ESM/CJS value intents reject collisions before suppression, and
  the real dynamic result requests the existing early Promise subscription.
  No type-only export becomes a runtime export.

These are issue-local dispositions for that measured existing-owner growth.
Global LOC baselines, architecture policies, original guest/assertion values,
deadlines, skips and acceptance floors are unchanged. Preserve the actual LOC
failure and earlier host failures. The exact whole four-file 69-test population,
including all original 23 timer tests and the 30 genuine boundary controls,
remains unrun; format/lint success is not runtime or CI qualification.

## 2026-11-05 Source05: measured function-owner wiring

The first Source05 diagnostics passed the file-size, oracle, coercion,
native-arm, import-cycle and inventory gates, but stopped at the function
ratchet before source typing, collection or any of the 69 guests. The exact
existing owners below grew against the same immutable `d468fa1a` gate base:

- `src/runtime.ts::resolveImport`: 7,859 -> 7,884 lines (+25). The existing
  timer import branches decode the delay/clear carrier and encode the raw host
  timer result through the canonical numeric boundary. Coercion still uses
  the existing tagged-throw owner; no independent timer implementation or
  global host-value policy is added.
- `src/codegen/declarations.ts::collectDeclarations`: 2,115 -> 2,122 (+7).
  Actual runtime source-export intent is checked at the six existing ESM/CJS
  publication branches before existing-name suppression; erased type-only
  specifiers are excluded. These seven lines retain the declaration owner's
  publication order. The separate dynamic-result Promise preparation is
  outside this function and is not part of its measured growth.
- `src/codegen/index.ts::generateModule`: 1,930 -> 1,932 (+2), and
  `src/codegen/index.ts::generateMultiModule`: 1,322 -> 1,324 (+2). Each existing
  finalizer authenticates the numeric helper's actual canonical callable and
  public export target before dead elimination. These two exact calls close
  the same single- and multi-source publication contract; the emitted helper
  recipes and ordinary export selection remain with their existing owners.

These are per-change-set allowances for the four measured existing owners,
not edits to the shared function baseline or test assertions. Function-gate
success, the original timer controls and the 30 new genuine controls remain
unmeasured on this disposition until their actual checks run.

The same measured failure also reported `src/runtime.ts::<anonymous>#95`
as newly over 300 lines. Canonical TypeScript AST measurement against the
immutable gate-base runtime proves this is the existing `__extern_method_call`
callback, not a newly oversized body: before key `#94` and current key `#95`
are both exactly 309 lines. Their entire function-node text and body are
byte-identical (full-node SHA-256
`05df7361fabc517cd6df4c475e7e8eb682a273e55465287d097b28c407226ace`).
All 215 existing anonymous function nodes remain in the same order with
identical texts; only the new six-line canonical timer-coercion callback at
ordinal `#10` was inserted. It shifts the following anonymous ordinals by
one. The exact current `#95` per-change-set key therefore preserves the
existing 309-line owner; it grants no actual callback growth and does not
change the global baseline, scanner naming or 300-line threshold. The
one-off AST capture is source metadata evidence, not compiler or test credit.
