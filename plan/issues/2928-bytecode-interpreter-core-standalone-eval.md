---
id: 2928
title: "Bytecode interpreter core + standalone new Function / indirect eval"
status: in-progress
created: 2026-07-02
updated: 2026-07-21
priority: medium
horizon: xl
feasibility: hard
model: fable
reasoning_effort: max
task_type: feature
area: runtime
language_feature: eval
goal: runtime-eval
sprint: Backlog
parent: 1584
depends_on: [2927] # 2853 done (sprint 71) — removed 2026-07-17, see plan/log/analysis-2026-07/02-interpreter-backend-audit-2026-07-17.md
related: [1715, 1713, 2864, 2865, 2960, 3017, 2929]
oracle-ratchet-allow:
  - src/codegen/expressions/eval-inline.ts
# See "Coercion-sites allowance" below for the justification. In short: the two
# `__is_truthy` sites read field 0 of the provider's `[ok, value]` ABI envelope
# — a protocol discriminator the runtime-eval provider writes itself — not a
# §7.1.2 ToBoolean on a JS value flowing from user code.
coercion-sites-allow:
  - src/codegen/expressions/eval-inline.ts
loc-budget-allow:
  - src/codegen/index.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/object-runtime.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/context/types.ts
func-budget-allow:
  - src/codegen/expressions/calls.ts::compileCallExpression
  - src/codegen/index.ts::planIrOverlay
  - src/codegen/index.ts::generateModule
  - src/codegen/expressions/assignment.ts::compilePropertyAssignment
  - src/codegen/expressions/new-builtin-globals.ts::tryCompileBuiltinGlobalNew
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
      standalone target.
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
through that real parser. A thirty-body Phase-1-positive corpus additionally
executes arithmetic, comparison, name resolution, object access, interpreted
calls, exceptions, and built-ins through the same real pipeline.

The remaining E6 distribution work is to publish/build that provider on demand
through the #2527 linker instead of constructing it inside the test harness.
The no-eval control (`export function add(a,b) { return a + b; }`) is 46,023
bytes both before runtime routing (`542dbe5e9f529b`) and at this head: exactly
byte-identical, a 0% size-floor change.

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
