---
id: 2928
title: "Bytecode interpreter core + standalone new Function / indirect eval"
status: in-progress
assignee: ttraenkler/s78-sendev-eval
created: 2026-07-02
updated: 2026-08-11
priority: medium
horizon: xl
feasibility: hard
model: fable
reasoning_effort: max
task_type: feature
area: runtime
language_feature: eval
goal: runtime-eval
sprint: current
parent: 1584
depends_on: [2927] # 2853 done (sprint 71) — removed 2026-07-17, see plan/log/analysis-2026-07/02-interpreter-backend-audit-2026-07-17.md
related: [1715, 1713, 2864, 2865, 2960, 3017, 2929]
oracle-ratchet-allow:
  - src/codegen/expressions/eval-inline.ts
# See "Coercion-sites allowance" below for the justification. The
# `__is_truthy` sites read field 0 of the provider's `[ok, value]` ABI envelope,
# and the guarded `__unbox_number` sites copy a bridge carrier's already-proven
# numeric payload. These are protocol decoding operations, not ToBoolean or
# ToNumber on user values.
coercion-sites-allow:
  - src/codegen/expressions/eval-inline.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/expressions/runtime-eval-provider.ts
  - src/codegen/object-runtime.ts
  - src/codegen/runtime-eval-boundary.ts
loc-budget-allow:
  - src/codegen/index.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/object-runtime.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/context/types.ts
  - src/codegen/expressions/call-tail-dispatch.ts
  - src/codegen/closure-exports.ts
  - src/codegen/typeof-delete.ts
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/any-helpers.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/property-access.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/expressions.ts
  - src/codegen/declarations.ts
  - src/codegen/statements/variables.ts
  - src/codegen/string-ops.ts
  - scripts/runtime-eval-provider.mjs
  - scripts/test262-worker.mjs
  - tests/test262-shared.ts
  - src/interp/emitter.ts
  - src/codegen/expressions/eval-inline.ts
  - src/runtime.ts
func-budget-allow:
  - src/codegen/expressions/calls.ts::compileCallExpression
  - src/codegen/index.ts::planIrOverlay
  - src/codegen/index.ts::generateModule
  - src/codegen/expressions/assignment.ts::compilePropertyAssignment
  - src/codegen/expressions/new-builtin-globals.ts::tryCompileBuiltinGlobalNew
  - src/codegen/object-runtime.ts::fillApplyClosure
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
  - src/codegen/expressions/call-tail-dispatch.ts::compileTailDispatch
  - src/codegen/object-runtime.ts::ensureObjectRuntime
  - src/codegen/property-access-dispatch.ts::finalizeStructAndDynamicMemberGet
  - src/codegen/property-access.ts::compileElementAccessBody
  - src/codegen/closure-exports.ts::emitClosureMethodCallExportN
  - src/codegen/expressions.ts::compileExpressionInner
  - src/codegen/expressions/assignment.ts::compileAssignment
  - src/codegen/statements/variables.ts::compileVariableStatement
  - src/codegen/string-ops.ts::compileTaggedTemplateExpression
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/declarations.ts::compileDeclarations
  - src/codegen/declarations.ts::lowerParamType
  - src/codegen/context/create-context.ts::createCodegenContext
  - src/codegen/index.ts::generateMultiModule
  - scripts/runtime-eval-provider.mjs::selectCachedRuntimeEvalProvider
  - tests/test262-shared.ts::runTest262Chunk
  - src/interp/loop.ts::run
---

# #2928 — Bytecode interpreter core + standalone `new Function` / indirect eval

Slice **E** of the runtime-eval roadmap
([docs/architecture/runtime-eval-interpreter.md](../../docs/architecture/runtime-eval-interpreter.md), §6-E).
The WasmGC-native bytecode interpreter — #1584 Phase 1 core. Delivers the first
**standalone** dynamic-code execution: `new Function(dynamicBody)` and indirect
`(0, eval)(s)`, both **global-scope only** (no lexical capture — that is #2929).

## Scope

Global-scope evaluation only, deliberately excluding direct-eval scope capture
(§4.1 / #2929) so this slice needs no environment reification.

1. **Opcode-set ADR** under `docs/adr/` — register+accumulator design (after
   V8 Ignition; rationale: fewer opcodes/op than stack-based, Wasm-locals map to
   virtual registers). ~30 opcodes for Phase 1: arithmetic (with ToPrimitive),
   property `Get`/`Set`, `Call`/`Construct`/`CallMethod`, variable access
   (`LdLocal`/`StLocal`/`LdGlobal`/`StGlobal`), control flow
   (`Jump`/`JumpIfTrue`/`JumpIfFalse`/`Throw`/`TryStart`/`TryEnd`),
   `CallBuiltin <id>`. Document encoding, operand widths, exception-table format.
   Builds on the **#1715** IR→bytecode proof point (done) and the **#1713**
   backend trait seam.
2. **Bytecode emitter** as a second IR backend, gated by a per-function
   may-contain-dynamic flag; walks the same IR the WasmGC backend walks. Bytecode
   stored as a WasmGC array on a function-metadata struct (+ constant pool,
   exception table).
3. **Dispatch loop** authored in the js2wasm-compilable TS subset, compiled by
   js2wasm, with hot-path variables strictly typed (`number` PC, typed struct
   refs for frame/constant-pool) to avoid interpreter-level boxing. Inspect the
   generated WasmGC and note any hot-path boxing in the ADR.
4. **Bidirectional call protocol** — AOT function ↔ interpreted function, **zero
   marshalling**, boxed-value identity preserved (`ref.eq`, roadmap §4.2).
5. **Exception propagation** across the AOT↔interpreter boundary via Wasm EH
   tags (both paths already use EH).
6. Wire `new Function(dynamicBody)` and `(0, eval)(dynamicString)` (indirect) to
   parse via the #2927 Acorn artifact → emit bytecode → run the dispatch loop,
   in **standalone** mode.

## Value-rep (crux) & global access

- `JSValue` = the AOT `$Object` substrate (free bridge — see #2927 / roadmap
  §4.2). `CallBuiltin` targets the generic built-in siblings the #2927 audit
  guarantees.
- Global access: `var`/`function` hoist as properties on the module global
  environment record (globalThis `$Object`, #369), visible to AOT code and vice
  versa (roadmap §4.3). Indirect eval / `new Function` are **always** this
  global scope.

## Non-goals (this slice)

- Direct-eval scope capture → #2929.
- Generator/async opcodes → #2929 (align with #2864/#2865).
- Tier-up (re-AOT-compile hot interpreted functions) → deferred.
- V8/SpiderMonkey-grade throughput — this is the fallback path.

## Acceptance criteria

- [x] `new Function("a","b","return a+b")(1,2) === 3` in **standalone** mode via
      the interpreter (dynamic body, no host).
- [x] `(0, eval)("1 + 2") === 3` in standalone mode (indirect eval).
- [x] `eval("throw new Error('x')")` propagates through the AOT↔interpreter
      boundary into a catching `try/catch`.
- [x] An AOT function calls an interpreted function and vice versa with identical
      boxed-value identity (a `ref.eq` round-trip test).
- [x] ≥ 30 test262 eval-positive / Function-positive cases pass under the
      standalone target. A same-worktree refusal/full-provider A/B run on
      2026-08-03 measured **315 attributable fail→pass flips and zero
      pass→fail regressions** across all 816 official `eval-code` files; see
      "2026-08-03 MVP acceptance remeasurement" below.
- [x] A no-eval module stays within 5% of the current size floor; an
      eval-enabled module documents one measured parser+interpreter size figure.
- [x] Opcode-set ADR committed under `docs/adr/`.

## Notes

Depends on #2927 (parser + generic built-ins). Umbrella: #1584. Goal:
`runtime-eval`.

---

## Implementation Plan (architect, 2026-07-04)

Authoritative architecture: `docs/architecture/runtime-eval-interpreter.md`
**Part II (§12–§16)** — the 4-tier ladder + routing rules (§12), the
**bytecode-over-tree-walking ADR** (§13, decided: register+accumulator
bytecode; tree-walking rejected with rationale — do not relitigate without
new evidence), the unified name-resolution semantics (§14), the
compiled-acorn feasibility verdict (§15), and this slice sequence (§16).

### Root cause / why this exists

Standalone mode has **zero** dynamic-code execution: every dynamic
`eval`/`new Function` call site is Tier-3 today (#2960: compile warning +
catchable call-time throw — correct diagnostics, no capability). This issue
builds Tier 2 so standalone routes dynamic global-scope code to a real
executor. Direct-eval scope capture is explicitly NOT here (→ #2929).

### Two producers, one bytecode (design constraint — read before the ADR)

The original wording "bytecode emitter as a second IR backend" conflated two
producers (doc §12.1): **(a)** the _runtime_ emitter, ESTree→bytecode,
authored in TS, compiled into the module — that is THIS issue; **(b)** the
_build-time_ IR→bytecode backend (#1715 proof) as a future AOT deopt target
for `with`-class features — NOT built here, but the opcode ADR must not
preclude it (opcodes take boxed-any operands, carry no "parsed-at-runtime"
assumptions).

### Slices (each independently landable; sizes in doc §16)

**E0 (S) — in-Wasm AST consumer probe.** Small TS walker compiled alongside
Acorn (extend the #1710 harness, `tests/dogfood/`): call `parse` and walk the
resulting AST **inside Wasm** (dynamic `$Object` field reads), return
node-count / spot-field scalars. Purpose: arbitrate whether #2841/#2851/#2852
(params/quasis/sequence-children blank) are host-marshalling-only — if the
fields are intact in-Wasm, they leave this issue's critical path. Unblocked
now (post-#2937).

**P1/P2 (M each) — the #2853 parser blockers.** A: division after a numeric
literal mis-tokenized as regex start (`1 / 2` throws — likely a js2wasm
miscompile of acorn's token-context update, root-cause in the compiler); B:
any regex group `(…)` throws in `validateRegExpPattern` (suspected
#1690-family global-array typing). Both gate E2 wiring, neither gates E1.
(#2850's surviving half folds into P2.)

**E1 (L) — interpreter library, developed in Node.** New top-level source
dir (suggest `src/interp/`, kept import-clean of compiler internals so it
self-compiles): opcode definitions + encoder + ESTree→bytecode emitter +
dispatch loop + `$Frame`/env-record types + a disassembler. Authored in the
strictly-typed js2wasm-compilable TS subset (typed i32 PC, typed arrays for
registers; boxed-any only for JS values), but **unit-tested in Node against
node-acorn** over a fixture corpus of eval bodies — no Wasm involved. Write
the opcode ADR to `docs/adr/` (register+accumulator, ~30 Phase-1 opcodes per
the Scope list; i32-array bytecode + boxed-any constant pool + side exception
table of `[tryStart, tryEnd, handlerPC]`; `$Frame = {meta, pc, regs, envRec,
parent}`, hot fields cached in Wasm locals inside the loop). Runs fully in
parallel with E0/P1/P2 — it has **no compiled-acorn dependency**.

**E2 (L) — self-compile + standalone dynamic `new Function`.** Compile the
E1 library through js2wasm into the emitted module, gated per-module by a
may-contain-dynamic flag (the call-site classifier from
`eval-inline.ts`/`calls.ts` already distinguishes constant vs dynamic — reuse
it; a module with no dynamic sites must be byte-identical to today). Replace
the #2960 Tier-3 call-time-throwing stub for `new Function(<dynamic>)`
(`src/codegen/expressions/new-super.ts`) under standalone/wasi with: Acorn
parse → emit → a callable closing over the bytecode + module global env,
entering the dispatch loop. Global scope only (§20.2.1.1). Every gap where
js2wasm can't compile the E1 library is filed under #1058 (this is the
self-host stress test working as intended). Author E1/E2 to compile cleanly
through the **IR front-end** where possible (per the #2927 IR-alignment
note).

**E3 (M) — indirect eval + global hoisting.** `(0,eval)(<dynamic>)`
standalone via the same pipeline (`calls.ts` fall-through, replacing the
Tier-3 throw); `var`/`function` in evaluated code hoist as properties on the
globalThis `$Object` (#369), visible to AOT code and vice versa (doc §14 /
§4.3). `LdGlobal`/`StGlobal` are the root-only case of the §14 resolution
walk; a root miss throws `ReferenceError` (typed, catchable).

**E4 (M) — exception bridging.** `Throw`/`TryStart`/`TryEnd` + Wasm EH-tag
propagation across the AOT↔interpreter boundary in both directions
(interpreted `throw` caught by AOT `try/catch` and vice versa).

**E5 (M–L) — CallBuiltin.** Unified `CallBuiltin(name, recv, argsVec)`
targeting the #2927-audited surface (`__extern_method_call` open-`$Object`
path, `__get_builtin`, `__call_m_*` + brand arms, `__str_*`/`__vec_*`).
Prerequisite gap slices (from the #2927 audit — each landable alone, shared
with standalone AOT any-receiver work, NOT interpreter-only): **G1** Map/Set
`ref.test` brand arms in the closed-method dispatcher (turnkey — mirrors the
landed #2927 push/pop arm; route to `map-runtime.ts`/`set-runtime.ts`
helpers); **G2** args-passing on the standalone generic path
(`emitWrapperDynamicMethodCall` `wantArgs`) + `__apply_closure` arity>4 lift;
**G3** array callback methods host-free (in-Wasm callback bridge replacing
`env.__make_callback`); **G4** `string[]` carrier in `__vec_push`/`__vec_pop`
(#2784). G1/G2 are hard prerequisites; G3/G4 degrade gracefully (those calls
throw a clear "not supported" until landed).

**E6 (M) — packaging.** Interpreter+Acorn as a separately-compiled module
linked on demand via #2527 canonical rec-groups (zero-copy `$Object` share);
a no-eval module keeps the size floor (acceptance already lists 5%); record
one measured size figure for an eval-enabled module.

### Edge cases (Phase 1)

- `new Function` body with a `SyntaxError` → throw `SyntaxError` at
  construction time (runtime parse — unlike Tier 0's compile-time error).
- Param-string flatten (`"a", "b,c"`) per §20.2.1.1.1 — same rule #2924
  implements for Tier 0; share the splitter.
- Caller-local name in a `Function` body → resolves global / throws
  `ReferenceError`, NEVER the caller binding (§14 strictness note; #2924's
  no-capture invariant, now enforced by rooting the env chain at global).
- Interpreted code calling an AOT-exported function and vice versa: boxed
  values cross with `ref.eq` identity intact (acceptance test exists).
- Re-entrancy: eval'd code calling `eval` (nested parse/emit while a frame is
  live) — the emitter must be re-entrant; no module-level mutable scratch.
- `arguments`/`this` inside a dynamic `Function` body: sloppy-mode `this` at
  a bare call is `globalThis` (§10.4.3) — the interpreter CAN provide this
  (unlike the Tier-0 splice, which bails on `this` for exactly this reason).

### Milestone order within this issue

E0 → (P1 ∥ P2 ∥ E1) → E2 → (E3 ∥ E4 ∥ E5) → E6. Recommend landing E0+E1 in
one budget window (no substrate risk), E2 in its own (the self-compile is the
risk concentration), E3–E6 as follow-on M slices. #2929 (direct eval, `with`,
MOP, generators) starts only after E3/E4/E5.

### Risks / conflicts

- **Substrate races:** E2+ consume the boxed-any dynamic reader — land after,
  not racing, in-flight value-rep work (roadmap §8 discipline).
- **File conflicts:** `calls.ts`/`new-super.ts` are hot files (eval routing,
  #2960 landed there); rebase early and often. `closed-method-dispatch.ts`
  (G1/G2) is active #2151-family territory.
- **Late-import funcIdx shifts** when reserving interpreter entry helpers —
  follow the name-based repoint discipline (memory: `reference_2193`,
  `project_standalone_hostimport_gate_index_shift`); reserve helpers at the
  call site like the #2927 push/pop fix did.
- **Size:** compiled Acorn alone is 651 KB — E6 (#2527 linking) is what keeps
  the no-eval floor; do not inline the interpreter unconditionally even as an
  interim step for CI's standalone-floor gate.

## Implementation findings (E2 core canary, 2026-07-21)

The first E2 self-compile canary now passes in
`tests/issue-2928.test.ts`. It compiles the E1 types, opcode table, encoder,
runtime ops, ESTree emitter, and dispatch loop as one standalone runtime
artifact, validates the Wasm, asserts zero imports, then emits and executes an
open-`$Object` ESTree representation of `1 + 2` entirely inside Wasm. This is
the first host-free proof of the runtime emitter + interpreter loop; the prior
E1 tests executed those sources in Node only.

Three source-subset mismatches were exposed and removed:

1. `FunctionEmitter` used TypeScript constructor parameter properties. The
   self-compiler did not materialize those as WasmGC struct fields, so `emit()`
   read missing fields through the dynamic MOP. They are now explicit declared
   fields with constructor assignments, matching the existing ABI classes in
   `types.ts`.
2. Switching directly on dynamic ESTree `.type` strings did not share the
   native-string case representation in standalone. The three AST dispatch
   sites now use explicit equality chains; Node E1 behavior is unchanged.
3. The external-constructor seam no longer passes a runtime args vector to
   `Reflect.construct`, whose standalone lowering requires an array-literal
   args list (#3371). It uses positional arity dispatch through 8, aligned with
   the generic closure ABI ceiling from #3310, and throws a catchable
   `RangeError` above that explicit Phase-1 limit. This removes the E2 compile
   refusal and preserves the Node E1 seam; argument-preserving dispatch to an
   AOT constructor is still part of the unlanded #3098 classifier bridge and is
   not claimed by the arithmetic canary.

Packaging is deliberately not claimed by this canary. `compileMulti` currently
emits per-source module initializers rather than one ordered standalone runtime
initializer; non-entry opcode constants can therefore remain TDZ-uninitialized
when an export is invoked. That whole-program ownership is tracked by #3525,
while this issue's E6 still owns the on-demand #2527-linked runtime artifact.
The canary concatenates the import-clean sources to model that one artifact and
avoid making multi-source initialization an accidental dependency of E2 core.

The parser remains an independent hard gate. The existing Acorn dogfood parity
was a JS-host result, not proof of a zero-import standalone parser: a combined
standalone compile currently refuses dynamic RegExp construction (#1539) and
RegExp-based `String.prototype.match`/`replace` (#1474). #2927 must provide a
host-free parser acceptance gate before E2 can wire real runtime source text.

## Implementation findings (parser-injected Function factory, 2026-07-26)

The interpreter now exposes a host-free parser boundary matching the measured
Acorn artifact:

```text
parse(source: native string, options: $Object) -> ESTree $Object
```

`compileDynamicFunctionMeta` wraps the flattened parameter/body strings as a
synthetic `function anonymous`, parses with `ecmaVersion: 2025` and
`sourceType: "script"`, and emits the declaration through a new `emitFunction`
entry point. `createDynamicFunction` then roots the metadata at a global
`$EnvRec` and returns an ordinary interpreted callable. The E2 canary proves
that entire injected-parser → emitter → callable → `interpEnter` path in a
zero-import standalone module: `fn(1, 2) === 3`. Node fixtures also preserve
the observable `name === "anonymous"` and `length === 2`.

The callable materializer needs eight explicit formal slots, matching the
Phase-1 generic closure ceiling; a rest-only trampoline is classified as arity
zero and drops the call arguments. The function expression must also remain
anonymous: naming it `interpTrampoline` currently selects the standalone
fnctor-escape path and loses the returned closure carrier. WeakMap branding and
best-effort `name`/`length` definition are safe after materialization and remain
unchanged.

The synchronized Acorn slice now separately measures Acorn 8.16.0 at 23/23
exact AST parity, a 1,699,827-byte zero-import standalone artifact, and a
successful returned-closure gate. It preserves the boundary above without
introducing a callable or rec-group ABI. Its publication remains owned by
#2927.

## Implementation findings (public linked runtime, 2026-07-26)

Standalone dynamic `new Function`, `Function(...)`, and indirect eval now route
to the core-Wasm `js2wasm:runtime-eval` provider instead of the Tier-3 throwing
stub. The user module and provider share the canonical callable/value carrier;
provider exceptions cross the module boundary in a result envelope and are
re-thrown through the caller's Wasm EH tag. Tests cover AOT→interpreted and
interpreted→AOT calls, boxed object identity in both directions, native error
construction, numeric built-ins, and sloppy/strict dynamic-function `this`.

The real pinned Acorn source and the import-clean interpreter sources compile
as one ordered-initializer provider. At the published Acorn consumption head
(`1ea2f888fb7b12a9904c8f46734027dd6fe3b19b`), the provider is 2,389,936
bytes, has zero imports, and links to a separately compiled user module whose
only dynamic-code dependencies are
`__runtime_new_function` and `__runtime_indirect_eval`. The mandatory acceptance
executes stored and immediate `new Function` values, the `Function(...)` call
form, indirect eval, exception propagation, built-ins, and the reverse AOT call
through that real parser. A thirty-body synthetic, Test262-shaped
Phase-1-positive corpus additionally executes arithmetic, comparison, name
resolution, object access, interpreted calls, exceptions, and built-ins through
the same real pipeline. It is a provider-harness capability gate, not the
official Test262 acceptance criterion above.

The remaining E6 distribution work is to publish/build that provider on demand
through the #2527 linker instead of constructing it inside the test harness.
The no-eval control (`export function add(a,b) { return a + b; }`) is 46,023
bytes both before runtime routing (`542dbe5e9f529b`) and at this head: exactly
byte-identical, a 0% size-floor change.

## Official Test262 `eval-code` handoff (2026-07-26)

The ordinary standalone Test262 lane was measured at PR #3678 head
`d50379add2f0d7f46314a48612602baeffe04a4d` and compared file-for-file with a
fresh `origin/main` control at
`c17d14ed966eb63cbf315c2cc059390fab2caaec`. The authoritative command was:

```sh
TEST262_TARGET=standalone \
TEST262_PATH_FILTER='language/eval-code/' \
TEST262_REPORTER=dot \
COMPILER_POOL_SIZE=2 \
TEST262_WORKERS=2 \
TEST262_MAX_UNCLASSIFIED_ROOT_CAUSES=9999 \
pnpm run test:262 -- --official-scope-only
```

The path filter covers both `test/language/eval-code/` and
`test/annexB/language/eval-code/`.

| Scope                | Official files |            Pass |
| -------------------- | -------------: | --------------: |
| Standard `eval-code` |            347 |             105 |
| Annex B `eval-code`  |            469 |               1 |
| **Combined**         |        **816** | **106 (13.0%)** |

The remaining outcomes were 670 runtime failures and 40 compile errors, with no
skips. Passing cases split into 83 standard direct-eval files, 22 standard
indirect-eval files, and one Annex B direct-eval file
(`var-env-lower-lex-catch-non-strict.js`).

The branch and control had identical statuses for all 816 files: **zero files
flipped to pass on the interpreter branch**. Therefore none of the 106 existing
passes can be credited to the new runtime route. They are pre-existing
constant-string compile-away cases, expected negative/error paths, or tests
whose dynamic evaluation path is not reached.

### Measured blocker

PR #3678's dedicated linked-provider harness is green, but the ordinary
Test262 runner does not build and supply that provider. Genuine runtime
indirect-eval cases therefore fail while instantiating the user module:

```text
WebAssembly.instantiate(): Import #0 "js2wasm:runtime-eval":
module is not an object or function
```

Some are classified as `host_import_leak` for the same missing-provider
boundary. Dynamic direct eval still reaches the intentional
`TypeError: dynamic eval is not supported in standalone mode (#2928)` fallback;
lexical capture remains #2929 and is not part of this handoff.

### Next-agent sequence (E6 / official acceptance)

1. PR #3678 has landed on `main` (merge commit `d4ab6613e`, 2026-07-26 —
   including the coercion-sites allowance recorded below). Consume it without
   changing the published parser/callable seam:
   `parse(nativeString, optionsObject) -> ESTree $Object`, then
   `emitProgram`/`emitFunction -> FuncMeta -> interpEnter`.
2. Move the provider construction now proven by
   `tests/issue-2928-runtime-link.test.ts` into the normal standalone packaging
   path through #2527, with one ordered initializer. The Test262 runner must
   instantiate the user module with a real `js2wasm:runtime-eval` namespace,
   not `{}`.
3. Start with indirect eval and `Function` constructor cases. Do not broaden
   this slice into direct-eval lexical capture (#2929).
4. Re-run the exact command above against a same-run `origin/main` control and
   report exact per-file status flips. Do not count the synthetic thirty-body
   provider corpus as official Test262 passes.
5. Check the Test262 acceptance box only after at least 30 named official
   source files pass because of the linked interpreter route.

## Implementation findings (E6 Test262-runner provider link, 2026-07-27)

The ordinary standalone Test262 lane now links the runtime-eval provider.
The wiring is deliberately thin and lives at the distribution seam, not in
the compiler:

- `scripts/runtime-eval-provider.mjs` — ONE shared source assembly (pinned
  Acorn tarball via `tests/dogfood/setup-acorn.mjs` + import-clean
  `src/interp/*` + the export wrapper proven by
  `tests/issue-2928-runtime-link.test.ts`), the provider compile options,
  a disk cache keyed by (source, options, compiler-bundle hash), and
  fresh-per-test namespace instantiation.
  `tests/interp/runtime-acorn-package-probe.mjs` consumes the same assembly,
  so the artifact the harness proves and the artifact the runner links are
  byte-identical (re-verified: 14/14 canaries, 2,513,425 bytes).
- `scripts/build-runtime-eval-provider.mjs` — idempotent prebuild wired into
  `run-test262-vitest.sh` for `TEST262_TARGET=standalone`. It canary-verifies
  (eval/function/30-body corpus) BEFORE caching; a provider that cannot
  evaluate `1 + 2` can never be published. Build cost ~71–81 s; cache hit
  <1 s.
- `scripts/test262-worker.mjs` — the standalone path goes Module-first; when
  `WebAssembly.Module.imports()` names `js2wasm:runtime-eval`, the worker
  links a FRESH provider instance (per-test isolation; instance ≈ 0.4 s,
  Module compile ≈ 27 ms, once per worker). **Cache miss degrades to the
  exact status quo** (unresolved import → LinkError): workers never compile
  the provider, because Acorn compilation takes minutes and the pool kills
  jobs at 30 s. `TEST262_DISABLE_RUNTIME_EVAL_PROVIDER=1` is the attribution
  kill-switch — it byte-restores pre-wiring behavior for A/B runs.
- CI chunk shards see a cache miss and keep status-quo behavior; publishing
  the provider artifact for CI (through #2527 packaging) is follow-up work.

Two measurement traps found and fixed/recorded on the way:

1. **The authoritative command under-reports its own denominator on this
   branch.** The per-test vitest timeout was a hardcoded 90 s that also
   measures POOL-QUEUE wait. Once the provider made the annexB eval bodies
   actually execute (slow — see finding 2), queued tests blew the 90 s and
   vitest killed them WITHOUT a jsonl row: 202 of 816 files simply vanished
   from the results (a file that PASSES in isolation was among the missing).
   Fixed: `TEST262_IT_TIMEOUT_MS` env override (default unchanged at 90 s, CI
   byte-identical); measurement sweeps pass it explicitly.
2. **Newly-reachable interpreter executions are pathologically slow or hang**
   (interpreter-side, out of E6 scope, needs its own issue): an eval body of
   `if (false) ;` takes ~27 s before throwing through the linked route;
   `if (false) ; else function f() { ... }` (the annexB function-in-if
   family, ~100 files) never terminates and eats the 30 s pool timeout.
   Simple bodies (`1 + 2`, `var`, `function f(){} f()`) run in <1 s. The
   provider-side `__runtime_indirect_eval` returns instantly for the same
   bodies when called with JS carriers, so the pathology is in the
   native-carrier execution path.

## Official Test262 `eval-code` measurement (E6 wiring, 2026-07-27)

> **⚠ These are LOCAL, INTERPRETER-LINKED numbers. They are NOT CI numbers and
> must not be cited as a lane baseline.** CI never ran the prebuild, so the
> branch arm's 117 passes and 11 attributable flips were never reproducible in
> the standalone CI lane — see "Consequence: local eval numbers taken before
> this change are not CI numbers" in the E7 findings below. Post-E7 the
> equivalent run requires `TEST262_FULL_RUNTIME_EVAL=1`.

Three same-session arms on the same machine, same authoritative command
(TEST262_TARGET=standalone, TEST262_PATH_FILTER='language/eval-code/',
COMPILER_POOL_SIZE=2, TEST262_WORKERS=2, --official-scope-only), all with
`TEST262_IT_TIMEOUT_MS=600000` (see finding 1 above — without it the branch
arm silently loses 202 of its 816 rows):

| Arm                                            | Run ID          | pass | fail | CE  | compile_timeout |
| ---------------------------------------------- | --------------- | ---: | ---: | --: | --------------: |
| control — `main` @ `81dbcad3b`                 | 20260727-020133 |  106 |  670 |  40 |               0 |
| branch @ `4ac14aacb` + provider                | 20260727-013447 |  117 |  627 |  40 |              32 |
| branch + `TEST262_DISABLE_RUNTIME_EVAL_PROVIDER=1` | 20260727-021328 |  106 |  670 |  40 |               0 |

- The control **exactly reproduces the 2026-07-26 handoff baseline**
  (106/816 = 105 standard + 1 annexB) — instrument validated.
- The kill-switch arm is **status-identical to the control on all 816
  files** — removing the provider injection alone reverts every delta, so
  every delta is attributable to the linked interpreter route.
- **11 files flip fail→pass (11 of the ≥30 acceptance bar), 0 regressions:**
  - `test/annexB/language/eval-code/indirect/global-block-decl-eval-global-skip-early-err-block.js`
  - `test/annexB/language/eval-code/indirect/global-block-decl-eval-global-skip-early-err-for.js`
  - `test/annexB/language/eval-code/indirect/global-if-decl-no-else-eval-global-skip-early-err-block.js`
  - `test/annexB/language/eval-code/indirect/global-if-decl-no-else-eval-global-skip-early-err-for.js`
  - `test/language/eval-code/indirect/block-decl-strict.js`
  - `test/language/eval-code/indirect/export.js`
  - `test/language/eval-code/indirect/import.js`
  - `test/language/eval-code/indirect/non-string-object.js`
  - `test/language/eval-code/indirect/non-string-primitive.js`
  - `test/language/eval-code/indirect/parse-failure-6.js`
  - `test/language/eval-code/indirect/var-env-func-strict.js`

  These are exactly the cases the Phase-1 interpreter can already decide:
  correct SyntaxError refusal of invalid eval code (parse-failure, import/
  export declarations, skip-early-err), strict/block-scoping negatives, and
  §19.2.1's non-string pass-through.

**Why the remaining candidates are blocked (measured on the branch arm, not
estimated).** 595/816 are direct-eval files — out of scope by design
(#2929). Of the 221 indirect files: 33 pass (22 pre-existing + 11 new),
32 hang (→ `compile_timeout`; the annexB function-in-if emit hang recorded
in finding 2), and 156 still fail with this signature breakdown:

| count | blocking cause (verbatim signature class)                              |
| ----: | ---------------------------------------------------------------------- |
|    42 | `interp/emitter: unsupported in Phase 1: statement SwitchStatement`     |
|    34 | `ReferenceError: assert is not defined` (interp global env cannot see the AOT module's harness globals) |
|    18 | `ReferenceError: fnGlobalObject is not defined` (same bridging class)   |
|     8 | `interp/emitter: unsupported ... ForOfStatement`                        |
|     8 | `interp/emitter: unsupported ... ForInStatement`                        |
|     8 | `SyntaxError: NaN` (error-message rendering defect in the thrown path)  |
|    38 | assorted semantic gaps (SameValue mismatches, missing expected throws, null-property access) |

So the two biggest levers toward the ≥30 bar are interpreter-side, not
packaging-side: (a) AOT↔interp **global-binding bridging** (52 files fail
purely because eval'd code can't resolve `assert`/harness globals), and
(b) Phase-1 statement coverage (**SwitchStatement** alone gates 42, for-of/
for-in another 16) plus the **if-statement hang/slowness** family (32 hangs;
~27 s even for `if (false) ;`). The acceptance box stays unchecked; the E6
packaging seam itself is done and measured working.

Artifacts: `benchmarks/results/test262-standalone-results-20260727-{020133,013447,021328}.jsonl`
(local machine; copies retained in the session workspace `.tmp/e6-*.jsonl`).

## Implementation findings (E7 — the provider was never linked in CI, 2026-08-01)

### Root cause: E6's prebuild is unreachable from CI

E6 wired the prebuild into `scripts/run-test262-vitest.sh`. **CI never runs
that script.** Every `test262-sharded.yml` shard job (and every
`refresh-baseline.yml` heal shard) invokes `node
node_modules/vitest/dist/cli.js run tests/test262-chunkN.test.ts` directly, so
`scripts/build-runtime-eval-provider.mjs` is never executed and the provider
cache is always cold. The published standalone baseline — which is a **CI**
artifact, fetched from `loopdive/js2wasm-baselines` — therefore carries **361
files** failing at instantiate:

```text
WebAssembly.instantiate(): Import #0 "js2wasm:runtime-eval":
module is not an object or function
```

Measured against `.test262-cache/test262-standalone-current.jsonl` (baselines
run `20260801-010858`, 48,088 rows): 361 records, **all `status: fail`**, led
by `annexB/language/eval-code/indirect` (104), `annexB/.../direct` (32),
`built-ins/Function/prototype/apply` (22) and `/call` (22), plus the whole
`built-ins/Function/S15.3.2.1_*` / `length/*` Function-constructor family.

### Why that costs far more than the eval assertions

The import is **module-level**, not call-level. A file that merely *mentions*
dynamic `new Function` / indirect eval carries the import and cannot
instantiate, so it loses **every** assertion it has — not just the ones that
need eval. That matters here because the standalone `new Function` route
already does §20.2.1.1.1 argument ToString **AOT at the call site**
(`emitStandaloneDynamicFunctionRuntime` → `compileAndEmitToString`), so a
throwing `toString` throws *before* the provider is ever consulted. Verified
against a compiled probe: the only import such a module has is
`js2wasm:runtime-eval::__runtime_new_function`; everything else is internal.

### The fix: a second, refusal tier

The real Acorn+interpreter provider is **2,447,002 bytes and 151 s to
compile** (measured on this box) — not affordable in each of the 36 standalone
shards, and #2928's own E6 finding 2 records an interpreter hang family
(~100 annexB files) that would additionally burn the 30 s pool timeout each.
So CI does not get the interpreter; it gets a **refusal provider**:

- a js2wasm-compiled, **zero-import** core-Wasm module with the *same*
  `[ok, value]` envelope ABI and the same two exports, and **no capability**:
  both entry points return `[false, TypeError]`;
- **53,152 bytes, 2.5 s to compile** — affordable per shard;
- linked by `scripts/test262-worker.mjs` whenever the interpreter tier is
  absent, so eval-mentioning modules instantiate and only the dynamic-code
  call itself throws the typed, catchable #2960 Tier-3 TypeError that direct
  eval already reports.

It injects **no JS-host capability** — it is core Wasm from the compiler under
test, just an empty one. The build **canary-verifies before caching**, and the
canary is a *cross-module* positive control (a throwaway user module takes the
dynamic route and must report a catchable `TypeError`), with an explicit
assertion that the canary really does import the provider so it cannot pass
vacuously.

`TEST262_FULL_RUNTIME_EVAL=1` is now the **opt-in** for the interpreter tier,
in both the runner and the worker. Before, a local sweep silently used any
cached interpreter provider while CI could not — so the two lanes disagreed by
exactly the interpreter's yield. Opt-in makes local and CI report the same
standalone number by default.

### ⚠ Consequence: local eval numbers taken before this change are not CI numbers

This is a **measurement-validity** defect, not just an ergonomics one, and it is
retroactive. Read it before citing any pre-E7 local eval figure as a baseline.

**The mechanism.** Between E6 (2026-07-27) and E7 (2026-08-01), a local
standalone sweep run through `scripts/run-test262-vitest.sh` prebuilt the real
Acorn+interpreter provider and the worker linked it *unconditionally, with no
flag and no log line saying which tier it got*. CI could never do either — it
does not run that script, so its cache was always cold and the same files died
at instantiate. The two lanes therefore diverged **silently**, and by a specific
amount: **roughly the interpreter tier's yield**.

**The general form, which outlives this issue: a harness that SILENTLY selects a
capability the published lane does not have invalidates every cross-lane
comparison made against it — and the results carry no trace of the choice.** It
is a measurement-validity defect, not a convenience. The fix has two halves and
needs both: (1) the capability is **opt-in behind a named flag**, never
"whatever happens to be cached"; (2) the harness **announces which tier it
selected on every path, including the successful one** —
`announceRuntimeEvalTier` in `scripts/test262-worker.mjs` now does this, and the
interpreter arm says out loud that its results are not CI-comparable. Half (1)
alone still leaves a run whose report cannot be traced back to its
configuration. Carry both into the next harness.

**What that invalidates.** Any standalone eval-scope number measured *locally*
on this repo in that window is an **interpreter-linked** number, and is
**inflated relative to CI** — i.e. relative to the published baseline, the
`#1897`/`#2097` standalone floor gates, and anything else fed from
`loopdive/js2wasm-baselines`. Concretely this includes **the three-arm table in
"Official Test262 `eval-code` measurement (E6 wiring, 2026-07-27)" above**: its
117-pass branch arm and its 11 attributable flips are *local, interpreter-linked*
results. E6 did disclose the mechanism in prose ("CI chunk shards see a cache
miss and keep status-quo behavior"), but the disclosure never reached the
headline table, which is exactly how such a figure gets re-quoted as a lane
baseline later.

**To be explicit about the direction:** those E6 numbers are not wrong *as
measured* — the interpreter really did produce them, the kill-switch arm really
was status-identical, and the attribution really does hold. They are wrong to
use as a **CI/lane baseline**, because CI was never in that configuration.

**The rule from here.** State the tier with every standalone eval figure. A
number without `TEST262_FULL_RUNTIME_EVAL=1` is the refusal tier and is
CI-comparable; a number with it is the interpreter tier and is **not**
CI-comparable until the interpreter provider is actually published to CI (see
"What is still owed"). The order of magnitude of the gap is the arm C delta
above: ≥ +17 passes on a 262-file slice.

### Measurement (arms A/B, same machine, same HEAD, 2026-08-01)

Scope `built-ins/Function/` (the task's named lever), `--official-scope-only`,
`COMPILER_POOL_SIZE=2 TEST262_WORKERS=2 TEST262_IT_TIMEOUT_MS=600000`.
**Row count floored at 515 in both arms** (509 `test/built-ins/Function` + 6
`test/annexB/built-ins/Function`) — E6 finding 1's silent row loss did not
recur.

| Arm                                                   | pass    | fail    |  CE |
| ----------------------------------------------------- | ------: | ------: | --: |
| A — control, `TEST262_DISABLE_RUNTIME_EVAL_PROVIDER=1` |     174 |     308 |  33 |
| B — refusal provider linked                            | **179** |     303 |  33 |

**+5 flips, 0 regressions, 0 other status changes.** Attribution is by
removal: arm A is the kill-switch arm, so every delta is the refusal link.

**Of the 5, three are genuine and two are coincidental — read this before
quoting the number.**

| file                                              | why it flips                                                                              | honest? |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------- |
| `Function/S15.3.2.1_A1_T1.js`                     | body's `toString` throws `7`; §20.2.1.1.1 coercion is AOT, so the provider is never reached | genuine |
| `Function/S15.3.2.1_A3_T1.js`                     | param `toString` throws `1` before the body's does — pure coercion-order assertion          | genuine |
| `Function/prototype/toString/built-in-function-object.js` | walks the intrinsics and asserts `visited.length !== 0`; nothing eval-dependent     | genuine |
| `Function/prototype/apply/S15.3.4.3_A8_T5.js`     | wants a `TypeError` from `new (Function("…").apply)()` — gets the REFUSAL's `TypeError`      | **coincidental** |
| `Function/prototype/call/S15.3.4.4_A7_T5.js`      | same shape, via `.call`                                                                     | **coincidental** |

The two coincidental ones are confirmed as such by arm C below: with the real
interpreter linked, `Function("…")` succeeds and both files correctly **fail**
on the assertion they actually make. So the honest net for the refusal tier in
this scope is **+3 real, +2 right-answer-for-the-wrong-reason**.

The refusal error type is deliberately **not** tuned away from this. `TypeError`
is the already-shipped #2960 Tier-3 contract that direct eval throws today, so
the same exposure already exists on 26 direct-eval records; picking a
non-matching error class purely to avoid coincidental matches would be tuning
the instrument to the corpus, just in the self-flagellating direction.

The 103 in-scope link failures go to **0** and are replaced by *diagnostic*
failures that name the real blocker: 63 `TypeError: dynamic code evaluation is
not supported…`, 16 harness-wrapped variants of the same, 10
SyntaxError-detection cases (`Expected a SyntaxError but got a undefined`),
and a handful of `caller`/`arguments`/`with` semantics. That is the honest
shape of the remainder: **~90 of the 103 genuinely need the interpreter**, and
the refusal tier banks the 5 that never did.

**No regression vector.** Only files that were already failing carry the
import, so the tier cannot demote a pass — with one theorised exception worth
recording: the worker counts a `negative: {phase: runtime}` test as a pass when
*instantiate* throws a matching error, so a runtime-negative test expecting
`TypeError` could have been passing **vacuously** off the missing-import
`TypeError`. Making such a file instantiate would de-inflate it. The measured
arm shows **zero** such regressions in this scope; the possibility is flagged
for the full-lane run.

**No shard-budget risk.** Slowest `exec_ms` in arm B was 1,094 ms; the refusal
provider returns immediately, so no hang family is unlocked. Per-shard cost is
one ~2.5 s prebuild.

### Arm C — the interpreter tier, PARTIAL and load-confounded

A third arm with `TEST262_FULL_RUNTIME_EVAL=1` was started on the same scope
and **killed at chunk 8/16**, so it is not a complete arm. It produced rows for
262 of the 515 files. Restricting all three arms to exactly those 262:

| Arm (262-file restriction)     | pass   | fail | CE | compile_timeout |
| ------------------------------- | -----: | ---: | -: | --------------: |
| A — control                     |     83 |  163 | 16 |               0 |
| B — refusal                     |     84 |  162 | 16 |               0 |
| C — full interpreter (partial)  | **93** |  123 | 15 |          **31** |

**What this does and does not license.** Arm C ran while the box was at a 1-min
load average of 19–28, against 7–17 for arm B, so its 31 `compile_timeout` rows
are **confounded by machine contention and must not be attributed to the
interpreter** — several are in `prototype/toString/async-generator-*`, which has
no dynamic-code path at all. What contention *cannot* manufacture is a pass, so
the **17 files that flip to pass over arm B are a valid lower bound** on the
interpreter tier's yield here, and the single non-timeout regression
(`prototype/call/S15.3.4.4_A7_T5.js`) is real and is the coincidental-pass
unmasking described above.

**A second reason not to trust arm C's timeouts.** It was measured at
`608cd95e6`, which predates PR #3933 (`share one zero-length vec backing store
— 8,922 fewer allocations per acorn parse`) and PR #3940/#3951 (numeric keys all
hashing to bucket 0, O(n) → O(1)). Those are exactly the acorn/collection hot
paths the interpreter runs on, so any re-measurement must be taken at a head
that includes them.

So the interpreter tier is worth materially more than the refusal tier
(≥ +17 on a 262-file slice) — which is exactly why it is worth finishing, and
exactly why it must not be smuggled in on a confounded measurement.

### What is still owed

1. **A clean, uncontended arm C** on the full 515-file scope (and then on
   `language/eval-code/`), at a head that includes #3933/#3940/#3951, to
   separate genuine interpreter hangs from pool-queue contention and from
   already-fixed allocator/hash pathologies. Until that exists, the 30 s pool
   timeout is an unquantified risk against a 25-minute shard budget.
2. The **151 s / 2,447,002-byte interpreter provider compile** — not affordable
   per shard. Either #2527 on-demand packaging publishes it as a build artifact
   shared by the 36 standalone shards, or the compile gets materially cheaper.
3. The E6 finding-2 **hang family** (~100 annexB `function-in-if` files) is
   still unaddressed and is interpreter work, not packaging work.

The ≥30-file acceptance box therefore stays unchecked. What E7 delivers is the
floor beneath it: the standalone lane no longer loses whole files to an
unresolvable import, and the residual failures now name the interpreter as the
blocker instead of hiding behind a link error.

## Coercion-sites allowance (`src/codegen/expressions/eval-inline.ts`)

`pnpm run check:coercion-sites` fired on this change-set:

```
coercion-sites gate FAILED — this change-set ADDS hand-rolled coercion vocabulary on net (__is_truthy +2).
  codegen/expressions/eval-inline.ts: 0 → 2 (__is_truthy 0→2)
```

The gate fired **correctly** — `eval-inline.ts` is genuinely absent from
`scripts/coercion-sites-baseline.json`, so `0 → 2` is real net growth. The
allowance is granted deliberately, with this reasoning recorded so it can be
audited or reversed later.

**Why this is not what #2108 protects against.** The gate is a *net-growth
ratchet on a normal vocabulary token*, not a prohibition: the baseline carries
376 sites across 65 files, `__is_truthy` appears in a dozen-plus codegen files
**including `coercion-engine.ts` itself**, and `array-methods.ts` alone holds
19. What #1917/#2108 exist to stop is **JS-semantic coercion leaking outside
the engine** — a hand-rolled ToString/ToNumber/ToPrimitive/equality matrix
applied to user operands.

Both new sites are in `emitRuntimeEvalResultUnwrap`, which reads **field 0 of
the provider's `[ok, value]` ABI envelope**. That field is a *protocol
discriminator written by the runtime-eval provider itself*, never a JS value
flowing from user code. Reading it is a **representation** conversion
(externref-carrying-a-bool → i32), not a §7.1.2 ToBoolean on a JS operand.

Routing it through the coercion engine would therefore be **actively wrong**,
not merely heavier: it would assert JS ToBoolean semantics on a value that is
not a JS operand. So of the gate's two suggested remedies, "route through the
coercion engine" is the worse one here.

**Follow-up (not done here, deliberately).** That the envelope needs *any*
coercion to read `ok` is an ABI smell. If field 0 were carried as an `i32` — or
discriminated the way `__vec_len` does — the site would **disappear** rather
than be excepted, and the allowance could be dropped. That is a change to the
runtime-eval provider ABI, owned by this issue's author, and out of scope for
unblocking the gate.

Granted by the tech lead on 2026-07-26 (ruling recorded rather than parked on
the absent author, to stop #3678 stalling indefinitely; a one-line frontmatter
grant is cheap to reverse if the author disagrees).

## 2026-08-03 MVP acceptance remeasurement

The full interpreter tier was remeasured after the direct-eval environment,
statement-coverage, callable-boundary, and global-bridge work on
`codex/2929-direct-eval-capture`. Both arms used the same dirty worktree and
compiler bundle, the same two compiler workers and two execution workers, and
the complete 816-file official `language/eval-code/` scope. The only capability
difference was the provider tier:

```sh
TEST262_PATH_FILTER=language/eval-code/ \
TEST262_TARGET=standalone \
COMPILER_POOL_SIZE=2 \
TEST262_WORKERS=2 \
TEST262_REPORTER=dot \
TEST262_IT_TIMEOUT_MS=600000 \
pnpm run test:262 -- --official-scope-only

# Add only this for the full-interpreter arm:
TEST262_FULL_RUNTIME_EVAL=1
```

| Arm | Run ID | Standard | Annex B | Pass | Runtime fail | Compile error | Timeout / skip |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Refusal provider | `20260803-020039` | 101 / 347 | 57 / 469 | **158 / 816** | 614 | 44 | 0 / 0 |
| Full Acorn + interpreter provider | `20260803-015311` | 168 / 347 | 305 / 469 | **473 / 816** | 299 | 44 | 0 / 0 |

The file-for-file comparison contains exactly **315 `fail → pass` transitions**
(67 standard, 248 Annex B), **zero `pass → fail` transitions**, and no other
status changes. Route coverage in the full arm is 108/286 standard direct,
60/61 standard indirect, 185/309 Annex-B direct, and 120/160 Annex-B indirect.
All 473 passes are host-free. This is a local interpreter-tier capability
measurement, not the default refusal-tier CI baseline.

The focused implementation gate is also green: 128 tests across interpreter
fixtures, eval environments, real-Acorn linking, refusal/provider caching,
runtime-link identity, and `new Function` routing; `pnpm run typecheck` passes.
The linked-runtime test proves stored and immediate dynamic `new Function`, the
`Function(...)` call form, indirect eval, direct caller-cell mutation, AOT ↔
interpreted calls, boxed identity, and exception propagation through the real
zero-import Acorn provider.

The remaining 343 non-passes are follow-on conformance work, not an MVP routing
blocker: 299 runtime failures and 44 AOT compile errors. The largest standard
clusters are 89 missing EvalDeclarationInstantiation `SyntaxError`s in literal
direct-eval/default-parameter shapes and 36 pre-existing invalid-Wasm method/
generator compilations. Annex B is led by block-function initialization/update
semantics. Those residuals stay assigned to #2929 and the corresponding AOT
compiler issues; they do not invalidate the now-satisfied interpreter
acceptance gate.

## 2026-08-03 PR #4013 landing checkpoint

The provider is now a shared CI artifact instead of a per-shard compile. A
dedicated `runtime-eval-provider` job builds and canary-verifies the full
Acorn+interpreter Wasm once, uploads the matching hidden cache entry, and every
standalone Test262 shard downloads it and starts with
`--require-full-cache`. Host-only merge groups retain a successful no-op job,
so the new dependency cannot skip their shard matrix. The refusal provider
remains available only as the explicitly non-comparable fast local diagnostic
tier.

The content-current provider cache entry is `ecbc2188bdc98bed`, 4,105,914
bytes. It is zero-import and passes the parse/eval/new-Function canaries. This
resolves the earlier per-shard provider-build blocker without changing the
runtime-eval import namespace, result envelope, callable rec-group ABI, or
ordered-initializer contract.

PR #4013's merge-group failure yielded an exact 101-path
predecessor-pass/candidate-fail collision set. Replaying that set through the
authoritative full-provider fork-worker path now gives **101 pass / 0 fail / 0
compile error / 0 skip**. The final two rows were line-terminator eval bodies
using signed `<<` and `>>`; append-only `Shl`/`Shr` opcodes delegate their
boxed operands to the same self-compiled runtime-op layer as arithmetic. The
Node interpreter fixtures and the zero-import E2 self-compile canary are green.

This is a landing/collision measurement, not a replacement for the 816-file
MVP table above. Generated Test262 JSONL and cache artifacts are deliberately
excluded from the source checkpoint.

## Phase-2 emitter scope — deferred here from #4137 (2026-08-08)

#4137 arm 3 triaged the published `Error: interp/emitter: unsupported in
Phase 1: …` bucket (22 standalone records). Two of the five constructs were
implementable inside that issue and landed there; the remaining three each need
a **runtime protocol** the Phase-1 emitter does not have, so per #4137's
implementation plan §(b)/C3 they are recorded here with their measured record
counts instead. Source: `plan/issues/4137-interpreter-residuals-post-4013.md`,
"Implementation Plan (arch, 2026-08-08)" → "C3 — defer to #2928 Phase 2 with
counts".

| construct | emitter site | records | what Phase 2 must add |
| --- | --- | ---: | --- |
| class method key `PrivateIdentifier` | `src/interp/emitter.ts` (`emitClass` key path) | **4** | private state slots + the brand check, i.e. a per-instance private-name environment that is not a property key |
| class element `PropertyDefinition` (class fields) | `src/interp/emitter.ts` (`emitClass` element loop) | **3** | field-initializer evaluation in constructor context (each initializer is its own function-ish scope with `this` bound to the instance under construction) |
| `TaggedTemplateExpression` | `src/interp/emitter.ts` (`emitExpr`) | **1** | the tagged-template call convention: a frozen, per-site-cached strings array carrying `raw`, passed ahead of the substitution values |

Landed in #4137 instead of deferring (listed so this table is not read as the
whole bucket): binary/compound **bitwise** operators `\|` `&` `^` `>>>` (1
published record, opcodes 45-48, append-only) and **regex literals** (13
records, `BUILTIN_REGEXP_CREATE = 28`).

**Also for Phase 2, and NOT in the published 22 — catch destructuring
`ObjectPattern`** (`src/interp/emitter.ts:1054`). It is invisible in today's
records only because #4194's parse-level raise masks it (compiled-acorn raises
before the emitter ever sees the pattern); it is #4194's declared "layer 2" and
becomes the next blocker the day #4194 lands. Its implementer must also wire the
B.3.3 **cancellation** half — a destructuring CatchParameter *cancels* the Annex B
synthetic var binding, the `cancelsAnnexBVarBinding` counterpart to the
`SIMPLE_CATCH_SCOPE_LABEL` B.3.5 exemption that landed in PR #4139. That
cancellation path is currently unreached and untested.

## 2026-08-11 runtime-eval state checkpoint

The bytecode-interpreter route now carries persistent direct-eval activation
state coherently across the separately compiled provider boundary without
changing the 12-argument provider import, callable carrier, or rec-group ABI.
The same route continues to execute indirect eval and both `Function(...)` and
`new Function(...)`; `tests/issue-2928.test.ts` passes against a freshly
self-compiled, zero-import provider.

This checkpoint adds the missing direct-eval state transitions:

- eval-created `var` and function bindings have exact, out-of-line
  deletability metadata, can be tombstoned, and can reuse their slot;
- deleting a binding severs the matching persistent state cell, including a
  returned interpreted closure, while ordinary caller bindings still refuse
  deletion;
- AOT reads, `typeof`, simple writes, and capture-only nested closures share a
  compact 256-cell activation carrier representing 64 visible bindings; and
- the QuickJS compatibility provider understands the same carrier, while the
  interpreter remains the default and a permanent selectable option.

The authoritative A/B scope contains all 1,351 eval-dependent Test262 files:

| Engine | Run | Pass | Fail | Compile error | Timeout / skip |
| --- | --- | ---: | ---: | ---: | ---: |
| Acorn + bytecode interpreter | `20260811-222840` | **1,099** | 226 | 26 | 0 / 0 |
| QuickJS compatibility engine | `20260811-221743` | 1,081 | 244 | 26 | 0 / 0 |

The interpreter has exactly three new promoted-baseline passes:
`var-env-var-init-local-new-delete`, `var-env-func-init-local-new-delete`, and
`var-env-func-non-strict`. The #4242 parity gate is deliberately blocked
because QuickJS is net -18, so no default flip is included here.

The remaining state-carrier follow-ups are bounded and recorded under #2929:
compound/logical/update assignments must join the simple-assignment lookup,
and a nested closure that owns direct eval needs a two-pool inner/outer chain.
These do not undo the working direct-eval, indirect-eval, or dynamic-function
routing surface, but they remain conformance work rather than being silently
claimed as complete.
