---
id: 3673
title: "Compiled Acorn self-parse is 1,300–1,500× slower than node-acorn"
status: done
completed: 2026-07-27
assignee: claude/acorn-performance
created: 2026-07-26
updated: 2026-08-18
loc-budget-allow:
  - src/runtime.ts
  - src/codegen/object-runtime.ts
  - src/codegen/native-strings.ts
  - src/codegen/native-strings-core.ts
  - src/codegen/native-strings-basics.ts
  - src/codegen/native-strings-shared.ts
  - src/codegen/context/types.ts
  - src/codegen/async-scheduler.ts
  - src/codegen/closures.ts
  - src/ir/integration.ts
  - src/ir/lower.ts
  - src/codegen/registry/imports.ts
  - src/codegen/json-codec-native.ts
  - src/codegen/any-helpers.ts
  - src/emit/binary.ts
  - src/codegen/member-get-dispatch.ts
  - src/codegen/shared.ts
  - src/codegen/type-coercion.ts
  - src/codegen/index.ts
  - src/codegen/registry/types.ts
  - src/codegen/context/create-context.ts
  - src/codegen/native-strings-basics.ts
  - src/codegen/closed-method-dispatch.ts
  - src/codegen/closure-exports.ts
  - src/codegen/vec-overlay.ts
  - src/codegen/regexp-standalone.ts
  # round 39: native-i32 annotation wiring (whole-chain) + linear soundness
  # fixes (data-segment heap floor, checker-based alias resolution) + the
  # charCodeAt/length ASCII fast path.
  - src/codegen-linear/runtime.ts
  - src/codegen-linear/index.ts
  - src/ir/from-ast.ts
  - src/codegen/class-bodies.ts
  - src/codegen/declarations.ts
  - src/codegen/statements/variables.ts
  - src/codegen/native-regex.ts
  - src/codegen/string-ops.ts
  - src/codegen/binary-ops.ts
  - src/codegen/expressions/call-receiver-method.ts
func-budget-allow:
  # Rounds 26-39 of this issue are almost entirely hand-emitted Wasm runtime
  # (the HIGH ops/LOC class): every fast path added here is more `op:` literals
  # inside an existing `ensure*`/`fill*`/`emit*` emitter, which is what those
  # functions ARE. Splitting them would move the same instruction stream behind
  # a call without shrinking anything. The structural fix is the self-host /
  # IR-migration lever (#3256-#3258, #2855), not a split in this PR.
  - src/codegen-linear/runtime.ts::addLinearIrStringRuntime
  - src/codegen-linear/runtime.ts::addStringRuntime
  - src/codegen/any-helpers.ts::ensureAnyHelpers
  - src/codegen/binary-ops.ts::compileBinaryExpression
  - src/codegen/class-bodies.ts::collectClassDeclaration
  - src/codegen/closed-method-dispatch.ts::fillClosedMethodDispatch
  - src/codegen/closure-exports.ts::emitClosureMethodCallExportN
  - src/codegen/closures.ts::compileLiftedClosureBody
  - src/codegen/context/create-context.ts::createCodegenContext
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/expressions/assignment.ts::compilePropertyAssignment
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  - src/codegen/expressions/operator-assignment.ts::compilePropertyCompoundAssignmentExternref
  - src/codegen/expressions/unary-updates.ts::compileMemberIncDec
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/json-codec-native.ts::emitJsonRawJson
  - src/codegen/json-codec-native.ts::emitJsonStringifyValue
  - src/codegen/native-regex.ts::ensureRegexRun
  - src/codegen/native-strings-basics.ts::emitStrCompareHelpers
  - src/codegen/native-strings-core.ts::emitStrFlattenHelpers
  - src/codegen/native-strings.ts::ensureAnyToStringHelper
  - src/codegen/object-runtime.ts::ensureObjectRuntime
  - src/codegen/object-runtime.ts::fillApplyClosure
  - src/codegen/registry/imports.ts::addUnionImportsAsNativeFuncs
  - src/codegen/type-coercion.ts::coerceType
  - src/codegen/vec-overlay.ts::ensureOverlayCore
  - src/codegen/vec-overlay.ts::fillVecOverlayHelpers
  - src/emit/binary.ts::encodeInstr
  - src/ir/backend/linear-integration.ts::compileLinearIrFunctions
  - src/ir/lower.ts::emitInstrTree
  - src/ir/lower.ts::lowerIrFunctionBody
coercion-sites-allow:
  # Round 39's `charCodeAt`/`length` ASCII fast path and the closed-struct
  # extern-get arms unbox an already-numeric value / take a primitive off a
  # receiver whose shape is known. Both go through the existing
  # `__unbox_number` / `__to_primitive` helpers rather than re-deriving a
  # ToNumber/ToPrimitive matrix at the call site.
  - src/codegen/member-get-dispatch.ts
  - src/codegen/object-runtime.ts
oracle-ratchet-allow:
  # Round 39 revived the native i32 annotation whole-chain. Every added site is
  # `nativeTypeOf{Expression,Declaration}` / `nativeTypeFromTypeNode(ctx.checker, …)`
  # — a wasm-lowering ValType question (does this annotation mean an i32 local?),
  # which is deliberately ABOVE what `ctx.oracle` models. There is no oracle
  # query to route these through; the annotation resolver needs the raw
  # `ts.Type`/`ts.TypeNode` identity.
  - src/codegen/binary-ops.ts
  - src/codegen/class-bodies.ts
  - src/codegen/declarations.ts
  - src/codegen/native-type-annotations.ts
  - src/codegen/statements/variables.ts
priority: high
horizon: xl
feasibility: hard
reasoning_effort: high
task_type: perf
area: runtime, codegen
goal: self-hosting-dogfood
sprint: 78
model: fable
related: [1710, 1712, 1946, 1947, 2928, 3437, 3669, 3671, 3675]
---

# #3673 — Make compiled Acorn self-parse performance usable

> This file is the folded record for id 3673. Two lanes opened an issue for the
> same problem on the same day; the title, the `horizon`/`feasibility` fields and
> the acceptance criteria below come from the `compiled-acorn-selfparse-performance`
> framing, and the measured working record that follows is from the
> `acorn-performance` lane. Scope boundary: this issue owns **parser execution
> performance**. The standalone full-source illegal cast is #3675; oversized
> static string initialization is #3674.

## Acceptance criteria (from the folded framing)

- The benchmark is reproducible from a clean checkout and emits machine-readable
  raw samples plus median, p25, p75, mean, throughput, binary size, compiler
  time, Wasm compile time, and instantiation time.
- A before/after profile records the dominant cost centers and explains at least
  80% of the compiled execution time.
- Both compiled lanes (public `parse()` and in-module scalar) improve by at least
  **10x** from the opening measurements, with no more than a 10% node-acorn
  control drift. If host variability prevents that comparison, use paired sample
  ratios and record the control distribution.
- The required 23-input Acorn corpus, the exact full Test262 AST differential,
  and the zero-import standalone scalar canaries remain green.
- Any remaining gap above 10x native is split into measured, non-overlapping
  follow-up issues before this issue closes.

## Problem

With the #1712 dogfood milestone complete, compiled acorn is **correct**
(23/23 corpus exact, full test262 parser differential 53,259/53,259 files
exact) but catastrophically slow. Measured baseline (median, Node 22 V8,
`.tmp/bench-acorn.mjs`, cached binary, steady-state):

| input                        | node-acorn | compiled | slowdown |
| ---------------------------- | ---------- | -------- | -------- |
| literals.js (259B)           | 0.055ms    | 77.6ms   | 1,407x   |
| members-calls.js (213B)      | 0.050ms    | 107.1ms  | 2,135x   |
| control-flow.js (330B)       | 0.074ms    | 155.7ms  | 2,115x   |
| 17-file corpus concat (4.3KB)| 0.666ms    | 2,050ms  | 3,078x   |

AST marshalling (`wrapExports`) is NOT the cost — the raw export is equally
slow. Compile time is a separate axis: ~21-26s to compile acorn, 682KB
host-mode binary.

## Root-cause analysis (measured, V8 --cpu-prof + per-import counters)

A 330-byte parse makes **45,239 host-bridge crossings** (~137 per input
byte): `__box_number` 6.4k, `__extern_get` 5.3k, `__get_undefined` 4.7k,
`__unbox_number` 4.5k, `__typeof_number` 3.9k, `__is_truthy` 3.8k,
`__host_eq` 3.5k, `__host_compare` 3.5k, `__extern_get_raw_callable` 3k,
`__extern_method_call` 0.9k, `__extern_set_strict` 0.3k… This is the
consequence of fnctor instances resolving to externref (#1712 two-shape
fix): every field read/write, comparison, truthiness test and method call
on Parser/token state crosses to the JS host.

The crossings themselves (~0.1-0.3µs) were NOT the dominant cost. The
bridge's per-call implementation was:

1. **`_isWasmStruct` — 57.6% of total CPU.** It classified via a
   property-set probe on the receiver inside try/catch. For a WasmGC struct
   (the overwhelmingly common receiver) the probe **throws on every call**,
   and it allocated a fresh `Symbol` per call. Called several times per
   crossing across `_safeGet`/`_safeSet`/`__extern_get`.
2. **`_getStructFieldNames` filter — 28% of CPU after (1).** Answering
   "does this struct have own field `x`" enumerated the shape's CSV and
   called the `__shas_<field>` Wasm presence export for EVERY field of the
   shape (acorn's Parser struct has dozens) — dozens of Wasm re-entries per
   property read (the #2739b own-field shadow check runs per method read).
3. **`_safeSet` native write probe.** For struct receivers it attempted
   `obj[key] = val`, which on an opaque WasmGC object unconditionally
   throws in strict code — a guaranteed V8 exception per property write.
4. **`_resolveClassMemberOnInstance`** did a megamorphic dictionary-mode
   exports lookup (`__member_kind_<key>`, exports object has thousands of
   keys) per dynamic instance read.
5. **Per-call closure creation** in `snapshotVecMirrors` (runs on every
   `__extern_method_call`/`__call_function` crossing) and
   `_resolveHostField` — each closure creation also paying the transform's
   `__name` defineProperty under tsx.

## Fixes landed (this branch)

- `_isWasmStruct`: WeakSet verdict caches (classification is stable per
  object identity) + `Object.isExtensible` fast path (WasmGC objects report
  non-extensible; `Object.create(null)` is extensible — verified on Node 22).
  The probe-throw survives only for the rare non-extensible null-proto JS
  object, once per object.
- `_structFieldNamesRaw` + per-CSV split cache + `_structHasOwnFieldName`
  (single-key presence, one `__shas_` call); hot call sites converted
  (`_wasmStructHasOwn`, `_safeGet` #2739b shadow check, `_safeSet` #2731
  re-add check, `_readOwnDescriptor` data path, Object.assign/for-in
  helpers, marshal-shape probe).
- `_safeSet`: removed the always-throwing native write attempt for struct
  receivers (the `__sset_` writeback + sidecar are the real write lanes).
- `_resolveClassMemberOnInstance`: `__member_kind_<key>` verdict memoized
  per exports object (immutable after instantiation).
- `snapshotVecMirrors` inlined to a plain loop; `_resolveHostField`'s
  getter-invoke closure hoisted to a top-level helper.
- `_isWasmStruct` verdict caches merged into ONE WeakMap (one probe per
  call; measured ~19.9k predicate calls per 330B parse, 95% cache hits,
  only ~147 slow-path classifications — the volume made the second WeakSet
  probe of the miss path measurable).

## Measured after (same protocol)

| input                        | before   | after   | slowdown now |
| ---------------------------- | -------- | ------- | ------------ |
| literals.js (259B)           | 77.6ms   | 7.7ms   | 147x         |
| members-calls.js (213B)      | 107.1ms  | 8.9ms   | 234x         |
| control-flow.js (330B)       | 155.7ms  | 13.7ms  | 226x         |
| 17-file corpus concat (4.3KB)| 2,050ms  | 192ms   | 302x         |

**~11x faster end-to-end; slowdown vs node-acorn reduced from ~3,000x to
~150-300x.** Gates: `dogfood:acorn-corpus` 23/23 exact (0 quirks, 0 real
gaps, incl. acorn self-parse) — re-verified after every batch;
`tests/issue-1712.test.ts` acceptance green; dynamic-dispatch /
ifelse-global-shift / capture-closure / exactfield-lane / tokenizer-identity
pins green (36 tests); sidecar/presence/tombstone lanes green
(issue-1630/2130/2668/2731/2739/2853 — 47/48, the one 2668 for-in failure
reproduces identically on the pre-branch base 5805049, pre-existing).
`issue-1712-reflection-identity.test.ts`'s 12 failures also reproduce
identically on the unmodified base (pre-existing container/env issue).
tsc clean, biome clean.

## wasm-opt data point (measured, not landed)

`optimize: true` (Binaryen) shrinks the host-mode acorn binary **682KB →
393KB (−42%)** but does NOT improve parse time (medium input 208ms vs
183ms — within noise, slightly worse). Confirms the residual cost is
host-bridge crossings, not Wasm execution quality. Worth wiring into the
dogfood/artifact path for SIZE, irrelevant for speed.

## .wat evidence — what one hot line compiles to

Compiled a minimal acorn-shaped repro (fnctor + prototype methods + a
`while (this.pos < this.input.length) this.pos = this.pos + 1` loop) via
`compileToWat`. The single comparison `this.pos < this.input.length`
lowers to: current-`this` global read with `__get_undefined` fallback →
`__extern_get(this, "pos")` host crossing → `__extern_is_undefined` probe
→ a 4-deep `ref.test` ladder over boxed-number shapes whose EVERY arm ends
in a `__box_number` host call (re-boxing to externref) → two more
`__extern_get` crossings for `input`/`length` → `__host_compare` on two
externrefs. The increment adds `__host_add` + `__extern_set_strict`. So
one source line ≈ 7-9 host crossings; nothing numeric ever stays in Wasm.
This is the mechanical explanation for 45k crossings / 330 bytes.

## Standalone lane (round 2) — Wasm-native runtime now BEATS the host bridge

Question driving this round: can we eliminate host calls entirely by using
the standalone lane's Wasm-native object runtime (zero imports), while still
importing only what a Node host must provide? Measured via an in-module
benchmark driver (fixture + loop compiled INTO the standalone module, so the
timed region has zero crossings; `.tmp/bench-standalone.mjs`):

**Baseline standalone was 52.4ms/parse on control-flow.js — 3.5x SLOWER
than the (optimized) host lane's 14.9ms.** Profile: `__extern_get` 37%
(Wasm-side), `__str_equals` 19%, `__str_flatten` 12%, GC 10%. Root causes,
all fixed on this branch:

1. **String literals re-allocated per execution.** Every literal site
   (`nativeStringLiteralInstrs` / `compileNativeStringLiteral`) emitted
   `array.new_fixed` + `struct.new` inline — the `__extern_get` member
   ladder allocated its comparison literal PER PROBE PER CALL. Literals are
   now INTERNED into immutable module globals (GC constant expressions),
   one allocation per distinct literal at instantiation. Also −24% binary
   (1.75MB → 1.34MB).
2. **`__str_flatten` never memoized.** A rope re-copied on every flatten.
   `ConsString.left/right` are now mutable; flatten rewrites the cons in
   place to `(left=flat, right="")` and takes a two-field fast path on the
   next call.
3. **`__str_equals` had no identity fast path** — added `ref.eq` first
   (effective now that literals are interned).
4. **Every wrapped string helper unconditionally CALLED `__str_flatten` per
   string param** (`wrapBodyWithFlatten` preamble). Now guarded by an
   inline `ref.test $NativeString` — flat params (the common case) skip
   the call.
5. **`__extern_get`'s member ladder** (one arm per distinct field name in
   the program — hundreds for acorn) flattened the key per arm and called
   `__str_equals` unconditionally. The key is now flattened once into a
   scratch local and each arm is guarded by an inline length compare.

**Result: standalone 52.4ms → 8.9ms/parse (5.9x) — now 1.7x FASTER than
the host lane (14.9ms) on the same input.** Post-fix profile: 
`__extern_get_idx` 29%, `__apply_closure` 21%, `__extern_get` 14%,
`__str_equals` 8% — attacked in round 3 below.

## Standalone lane (round 3) — indexed reads, member-ladder buckets, apply args

Three more measured fixes:

1. **`__extern_get_idx` overlay tax (29% → gone).** The #3251 vec-descriptor
   overlay design assumed "defineProperty-on-array is rare", but the
   standalone RegExp exec path defines `index`/`input`/`groups`/`indices` on
   every match-result array via `__defineProperty_value` — each exec appends
   a companion to the GLOBAL overlay table, and `__vec_overlay_lookup` is a
   linear `ref.eq` scan of that table on EVERY indexed read (acorn: regex per
   token → unbounded growth; also a leak — entries pin their arrays forever,
   noted as follow-up). Fix: a `__vec_overlay_numeric` i32 flag global, set
   by `__vec_dp_value`/`__vec_dp_accessor` only when the defined key parses
   as an ARRAY INDEX; the `__extern_get_idx` prologue gates on the flag
   instead of the state global (string-key-only companions — the regexp case
   — are irrelevant to an indexed read). The `__extern_get` string lane keeps
   the state-global gate, so descriptor introspection of match arrays is
   unchanged. Routing the regexp defines through the #3537 bag instead was
   REJECTED: bag reflection (gopd/keys) is not implemented, which would
   regress `verifyProperty`-style tests.
2. **Member ladder → length + first-char buckets.** The interned-literal
   ladder still paid one inline length check per arm (hundreds). Arms are now
   grouped by name length, sub-grouped by first character (key length and
   `data[off]` hoisted into locals once per lookup) — a miss costs ~15 length
   checks + a handful of char checks instead of ~300 arm guards; a hit runs
   `__str_equals` ~1-2 times.
3. **`__apply_closure` $ObjVec fast path.** Args built by in-module call
   sites are always the runtime's own `$ObjVec`; length + per-arg reads now
   use direct `struct.get`/bounds-checked `array.get` instead of
   `__extern_length` + fully-dynamic `__extern_get_idx` per argument
   (OOB reads keep the undefined sentinel for #3592 widened calls).

**Measured: 8.9 → 3.4ms/parse.** Standalone cumulative: **52.4 → 3.4ms
(15.3x); now ~4.3x faster than the host lane** on the same input (host
14.9ms; node-acorn 0.06ms — the residual gap is ~55x). Post-round profile:
`__apply_closure` 12.5% (the remaining cost is the closure-ARITY resolution:
`buildClosureArityProbe`'s linear funcref/`ref.test` ladders inlined per
apply — the real fix is carrying the arity in the closure representation,
follow-up), `__extern_get` 10.5%, `__obj_find` 7.2%, `__str_equals` 5.4%.

Verification (round 3): standalone acorn canaries 4/4 green; overlay +
apply suites green (issue-3251, issue-3537, issue-3592 ×3,
issue-3031-proxy-apply — 71 tests); the 94 standalone/native-string suites
show the SAME 9 pre-existing failures and zero new; host corpus 23/23
exact; 1712 acceptance + pins green; tsc + biome clean.

## Round 4 — funcref-extraction root-collapse + the measured wall

`buildFuncrefExtraction` (shared by `__call_fn_<N>`/`__call_fn_method_<N>`
/`__closure_arity`/`__apply_closure`'s arity probe) emitted one
`ref.test`+cast+get arm PER closure struct shape. Since
`mintClosureStructTypes` makes every shared-signature wrapper AND every
capture-carrying closure subtype the canonical ROOT wrapper, the ladder now
collapses to ONE root arm (+ per-shape arms only for named function
expressions / wrapper-less fallbacks). Measured: ~3% (3.52 → 3.41ms) — the
extraction was not the hot part of these dispatchers.

## Round 5 — named-func-expr func-type unification (the arity-chain fix
that needed NO layout change)

Instrumenting the arity probe showed the 149-arm chain resolved to **90
distinct closure func types over 57 self shapes for only 9 distinct
arities** — and the explosion came from NAMED FUNCTION EXPRESSIONS: each
minted a private `(ref_null $ownStruct, …)` lifted func type, so acorn's
hundreds of `pp$X.method = function …` closures each added a chain arm
even when their USER signatures were identical.

Fix (`mintClosureStructTypes`): named func exprs keep their private
capture struct but now SUBTYPE the shared wrapper, and their lifted func
type takes the nullable canonical ROOT as `__self` (deduped by
`addFuncType` across identical user signatures). Bodies downcast root →
private struct via the existing `usesWrapperFuncType` machinery; var
hoisting keeps the nullable self slot; recursion dispatches unchanged
(the #2118 comment's "struct.get runs against __self's actual param
type" contract now holds root-wide). No allocation-site or capture-index
changes — the layout-risk variant (arity FIELD in the wrapper) was
deliberately deferred.

**Measured: funcTypes 90 → 48, extraction selfShapes 57 → 1, standalone
parse 3.38 → 2.66ms.** Cumulative standalone: **52.4 → 2.7ms (19.7x),
~5x faster than the host lane**; gap to node-acorn now ~45x.

Verification (round 5): all 10 closure suites — the 10 failures
(illegal-cast-closures ×6, closure-construct ×1, 2637 ×1, 3036 ×2)
reproduce IDENTICALLY on the committed base (pre-existing); var-hoisting
+ annexB-hoist + nested-hoist suites green; async/generator suites
100/100; standalone batch — same pre-existing 4; host corpus 23/23
exact; standalone canaries 4/4; 1712 acceptance green; host bench
unchanged; tsc + biome clean.

## Round 7 — i31 small-int boxing (linear memory's value-rep trick, natively)

`__box_number` (standalone native) now encodes integral values in the
signed-31-bit range as an UNBOXED `(ref i31)` — zero allocation — instead
of a `$BoxedNumber` struct. Excluded: -0 (i31 cannot carry the sign), NaN
and infinities (fail the trunc round-trip), and out-of-range values.
Encoder gained `ref.i31` / `i31.get_s` (GC opcodes 0x1C/0x1D); abstract
i31 `ref.test`/`ref.cast` ride the existing negative-heap-type encoding
(-20 → SLEB 0x6C).

Every discriminator that detects boxed numbers gained an i31 arm:
`__unbox_number`/`__typeof_number`/`__is_truthy`/`__to_bigint`/
`__typeof_string`-class/`__typeof` (imports.ts natives);
`__any_from_extern` tag-3 classification, `__any_to_f64`'s tag-5
`$BoxedNumber` recovery, `tag5ToNumber`, and the tag-5 "is a real string"
guard (any-helpers — the tag-5 lane was the subtle one: the "tag-5 lie"
wraps every non-nullish externref, so i31 numbers hid inside tag-5 boxes
and `this.pos + size` in a prototype method answered NaN until the
recovery arms landed — pinned by
`tests/issue-3673-i31-smallint.test.ts`); the `__extern_get` numeric-key
gate + i31-twin arms, `__obj_hash` key coercion, the Array-length
validation normalize, `__vec_dp_value` f64 write-back, `__weak_key_ok`
number rejection, JSON stringify/parse-revive arms, and the two
native-string number-coercion arms. Equality/compare/Map-SameValueZero
route through the i31-aware `__typeof_number`/`__unbox_number`, so mixed
i31-vs-struct encodings of the same value stay `===`.

**Measured: wall-clock FLAT on the acorn microbench (2.67ms vs 2.66ms)**
— GC was already only ~1.2% of the profile and V8's young-gen bump
allocation is near-free at this scale. The win is allocation VOLUME
(every small-int box removed), which matters under memory pressure and
for larger workloads, not this 330B parse. Recorded honestly; the arms
are correctness-neutral by construction and pinned by the new test.

Verification (round 7): probe matrix (dyn fields/===/arrays/obj/string
concat/switch/floats/-0) green; new 7-test pin suite green; standalone
acorn canaries 4/4; host corpus 23/23 exact (host lane untouched — its
`__box_number` is a host import); 30-suite standalone batch + 1712
acceptance — only the pre-existing 1599 ×3; JSON/Map/Weak suites — same;
tsc clean.

## Round 8 — typed `__get_member_<name>__f64` dispatchers (slot monomorphism, read side)

The #3669/#3671 issues as filed were correctness bugs (fixed by another
lane); the PERF continuation is this: a ToNumber-context field read
through the generic `__get_member_<p>` dispatcher paid three calls plus a
number box per hit — the struct arm `struct.get`s the f64 slot,
`__box_number`s it up to the uniform externref, and the read site
immediately `__to_primitive`s + `__unbox_number`s it back down (the
`this.pos + size` shape in the .wat evidence above). Now the externref→f64
coercion in type-coercion.ts detects when the stack top is literally a
generic-dispatcher call with hint "number", and swaps it for a typed twin
`__get_member_<p>__f64(recv) -> f64`: numeric-slot arms are a bare
`ref.test` → `struct.get` (+`f64.convert_i32_s` for i32/boolean slots) —
no box, no ToPrimitive; non-numeric slots, accessor-bearing props, #2979
sentinel gen-results, and misses all route to the generic dispatcher +
the exact chain the site would have emitted, arm-order-preserved. Same
reserve-then-fill discipline as #2674 (deps registered at reserve, body
filled after `fillMemberGetDispatch` at finalize); wired through a
shared.ts late-bound delegate (member-get-dispatch.ts imports
`coercionInstrs` FROM type-coercion.ts — the reverse static import would
close an eval-time cycle).

**Measured: wall-clock FLAT again (2.70ms vs 2.67ms)** — 16 typed
dispatchers mint in compiled acorn (pos/start/end/lastTokEnd/curLine/…)
and the profile confirms the work is real but small: `__to_primitive`
self-time 3.7% → 1.4%, `__vec_overlay_lookup` off the top list. The
remaining wall is crossing VOLUME through `__extern_get` (9-14%) +
`__obj_find` + `__str_equals` — reads that never had a per-name
dispatcher (dynamic keys, `$Object` hash props), out of scope for this
slice.

Verification (round 8): typed-dispatcher probe (fnctor `this.pos` slice
shape) answers correctly with the typed body confirmed in the .wat (one
`ref.test` + `struct.get $14 1`, fallback = generic + to_primitive +
unbox); #3673 pin suite 7/7; host corpus 23/23 exact (rewrite is
standalone-gated); dispatcher pin suites #2674/#2963/#3041/#3050/#2664
/#2979 all green; 1712 acceptance green; #2151 ×3 failures verified
identical on pre-change tree (pre-existing); tsc clean; biome error count
identical to base (pre-existing drift only).

## Round 9 — $HashedString + per-key prototype-lookup inline cache

Goal escalated to "surpass node-acorn" (warm node-acorn on the same 330B
input: **0.0341 ms/parse**, measured — the real gap was ~79x, not 45x).
Three sub-slices this round, driven by caller-edge profiling:

1. **`$HashedString <: $NativeString`** — a flat string carrying a cached
   FNV-1a hash (field 3; 0 = uncomputed, else `(h & 0x7fffffff) | signbit`)
   plus a per-key prototype-lookup cache (fields 4-6: cacheGen/cacheOwner/
   cacheEntry, `anyref` — `$Object`/`$PropEntry` register later). Only two
   producers: interned literal globals (hash BAKED at compile time by
   `nativeStringLiteralHash` — must stay bit-identical to `__obj_hash`'s
   wasm loop) and `__str_flatten`'s memoized flat copies (lazy).
   `__obj_hash` gained the cache fast path + write-back; `__str_equals`
   gained a both-sides-hashed O(1) reject. Measured: `__obj_hash` 3.2% →
   1.0% self.
2. **String-method fast path in `__extern_method_call`** — `ref.eq` on the
   interned name against "charCodeAt"/"slice" dispatches straight to
   `__str_charCodeAt`/`__str_slice`, skipping `__extern_get` + builtin-meta
   + apply. Emitted and reachable, but WAT inspection showed dynamic
   `.charCodeAt` READS already lower inline — the hot `__extern_method_call`
   traffic is Parser PROTOTYPE method calls, which led to:
3. **Per-key prototype-lookup inline cache** (the big one): acorn assigns
   parser methods at runtime (`pp.readToken = fn`) onto per-fnctor
   prototype `$Object`s, so EVERY `this.readToken()` re-resolved through
   the full `__extern_get` (closed-struct field ladder ≈15 compares +
   builtin-meta probe + prototype hash walk) before `__apply_closure`. Now
   a first-proto DATA hit with an interned key memoizes (owner-proto,
   entry, generation) ON THE KEY STRING; the hit arm — prepended at
   finalize AFTER the ladder fills so it runs FIRST
   (`unshiftExternGetProtoCacheArm`) — answers in O(1). Soundness:
   population only runs when ladder+meta MISSED for that fnctor class;
   hits are confined by owner-proto `ref.eq` to the same class; validity =
   generation match (bumped ONLY by `__obj_grow` — rehash re-mints
   entries) + live-DATA flags check (delete → TOMBSTONE, defineProperty
   morph → ACCESSOR, both checked per hit; value updates mutate the entry
   in place and stay visible).

**Measured: 2.9 → ~2.5ms/parse** (bench noise band ±0.15); profile:
`__obj_find` 5.7% → 3.4%, `__builtinfn_get_meta` off the top-15,
`__extern_get` 9.7% → 8.0%. Binaryen `optimizeBinaryAsync` (level 3) on
the bench module: **2.31ms before this round** — re-measure after.
Remaining top: `__extern_get` residue (options/$Object reads + cache-guard
overhead), `__str_equals` ladder compares for non-cached reads,
`__call_fn_method_*` signature ladders (next: signature-id
devirtualization), `__regex_run`, `__to_primitive`.

Verification (round 9): host corpus 23/23 exact; #3673 pin suite 7/7;
canaries 4/4; dispatcher/JSON/collections/1712 batch — failures only in
the pre-existing sets (1599 ×5, 2151 ×3, getters-setters ×6,
imported-string-constants ×4 — each verified identical on base); tsc
clean.

### Round 9c — cache extension to plain `$Object` own entries

The residual `__extern_get` share was dominated by acorn's per-parse
`this.options.<x>` reads — an open `$Object` receiver, so the fnctor-proto
cache never fired. The walk's depth-0 arm now also sets `canCache` for a
plain `$Object` receiver (own DATA entries), and the hit arm's
owner-candidate falls back to the receiver itself when it has no fnctor
prototype. Same soundness shape: population implies every earlier arm
missed for this exact receiver identity; hits are owner-`ref.eq`-confined;
own always shadows proto so chain mutations can't stale a cached own
entry; tombstone/accessor/generation checks as before.

**Measured: ~2.5 → 1.91-2.08ms/parse (min 1.91, 5 reps)** — cumulative
52.4 → ~1.92ms (~27x); node-acorn warm 0.0341ms → gap ~56x. Profile:
`__str_equals` 5.1% → 2.1%, `__obj_find` off the top-15; remaining top:
`__extern_get` residue 6.6% (cache-guard overhead + uncached reads),
`__call_fn_method_{0,1,2}` ~9.4% (signature-id devirtualization is the
next structural slice), `__regex_run` 3.4%, `__to_primitive` 3.4%, GC
4.4%.

Verification (round 9c): host corpus 23/23 exact; 2896/2866/accessor/
defineProperty/delete/1888/2106-S1/2674/1712/2151-nary suites all green;
#3673 pins 7/7; canaries 4/4; tsc clean.

### Round 10 — cache-arm owner reorder + arity-bucketed signature dispatch

Two smaller slices: (a) the cache-hit arm resolved the owner-candidate by
calling the `__fnctor_proto_start` ladder even for plain `$Object`
receivers — now one `ref.test $Object` runs first; (b)
`__call_fn_method_<N>`'s signature ladder (one funcref `ref.test` per
distinct closure func type, ≈48 in acorn) is pre-filtered by the round-6
`$arity` field: an i32 compare narrows to the same-arity bucket, with the
FULL ladder kept as fallthrough (the arity field is not trusted —
builtin-fn metas stamp spec `.length`, e.g. a variadic `JSON.stringify`
value closure declares 1 vec param but `.length` 3; a bucket miss simply
re-enters the old ladder). Bucket callBodies are `structuredClone`d — the
same Instr objects living twice in one body would be double-remapped by
finalize walks.

**Measured: ~flat to slightly better (min 1.98 vs 1.91, medians ≈2.05
both) — `__call_fn_method_2` off the top list, `_1` residue is the
callBody itself (argc/extras globals + unbox + call_ref + boxing), not
the ladder.** Honest read: the round-5 func-type dedup already took the
ladder below the noise floor for this workload. Remaining top:
`__extern_get` 7.1%, `__regex_run` 5.3% (per-word-token keyword regex —
regex-engine subsystem), user closures (real work), `__to_primitive`
2.9%, GC 3.3%.

Verification (round 10): 2151-nary/dynamic-spread/spread-literal, 1712
acceptance, 2664-arity-dispatch all green; host corpus 23/23 exact;
#3673 pins 7/7; canaries 4/4; tsc clean.

### Round 11 — `__to_primitive` primitive identity early-out

§7.1.1 step 1: ToPrimitive of a primitive is the identity — but a plain
number (i31 / `$BoxedNumber`) or native string fell into the non-`$Object`
arm and paid a `__class_to_primitive` dispatcher walk per remaining
ToNumber site. Three `ref.test` early-outs at the top return the input
unchanged. Also switched measurement to a min-of-10-batches in-process
methodology (`.tmp/bench-min.mjs`) — the single-shot estimator had a
±0.5ms noise band from tier-up/GC timing. **Current: 1.71ms/parse
(stable min)** — cumulative 52.4 → 1.71 (~31x), node-acorn gap ~50x.
Verification: string-hint/coercion/class-to-primitive suites (1806,
1470, 2638, 2358, 1910) all green; corpus 23/23; pins 7/7; tsc clean.

### Round 12 — inline method-lookup cache in the per-fnctor call arms

The round-11 profile still showed 251ms of `__extern_get` self-time
under `__extern_method_call`: each per-fnctor arm called `__extern_get`,
which walks its prepended ladder + `__fnctor_proto_start` BEFORE reaching
the round-9b cache arm. Inside a per-fnctor arm the prototype is a KNOWN
GLOBAL, so the cache check is now inlined there — interned key +
generation + owner `ref.eq` against `global.get <proto>` + live-DATA
flags → apply the cached method closure with zero lookup calls; any miss
takes the exact old `__extern_get` path (which populates). **1.71 →
1.54ms/parse (stable min)** — cumulative 52.4 → 1.54 (~34x), node-acorn
gap ~45x. Verification: corpus 23/23; 1712 + 2151-nary + 2963 ×4
method-identity suites green; pins 7/7; canaries 4/4; tsc clean.

### Round 13 — cached-method DIRECT call in `__call_m_<name>_<arity>`

`__method_cache_lookup(recv, name)` (new native — the per-key cache probe
as a callable helper) lets the fixed-arity dispatchers call
`__call_fn_method_<arity>` DIRECTLY with unpacked args on a hit —
skipping the per-call `$ObjVec` allocation, `__extern_method_call`, and
`__apply_closure`. Two correctness lessons baked in: (a) the exact-arity
export only carries closures with formals ≤ call-site arity, so an
UNDER-applied call (declared > arity, read off the root wrapper's
`$arity` field) must divert to the legacy path whose #3592 widening pads
missing args — the first cut without this gate broke `raise` paths
(`getLineInfo` null-deref via a method silently answering undefined);
(b) argc is preset/reset around the direct call exactly as
`fillApplyClosure` does. Scratch-local slot patched after the fill's
locals array finalizes (placeholder-index pattern).

**Measured: 1.54 → ~1.51ms min (marginal — most calls either hit
closed-struct arms above or divert on under-application).** Battery:
corpus 23/23; 2151 ×13 suites (3 pre-existing), 2903 ×8 suites — the 4
`issue-2903-iter-helpers` failures REPRODUCE AT THE MERGE-BASE with main
(verified by checkout bisect: merge-base 5805049, rounds 6-13 all
identical) — upstream pre-existing, not introduced here; 3117/3309/1712
green; pins 7/7; tsc clean.

### Round 14 — vec-overlay newest-first scan

The #3251 overlay table (vec identity → companion `$Object`, `ref.eq`
scan — identity maps can't hash in pure WasmGC) is APPEND-ONLY and the
standalone regex-exec path appends a pair per match, so it grows across
a run while `__vec_dp_value`'s per-define lookups walked it FRONT-first
— oldest (dead) entries before the fresh match array at the end.
Reversed to newest-first: hits on the active match array are O(1)
regardless of table size. Profile: `__vec_overlay_lookup` 3.4% → 2.5%;
the residue is the MISS scan (a fresh array's first define scans the
whole table to find nothing) — next slice: an ensure-fresh (append
without scan) callable from the match-result builder, which knows its
array is brand-new. The unbounded table itself (a genuine leak — WasmGC
has no weak tables) is recorded as a standing issue for the S3-era
per-vec companion field design. Verification: 3251 suites 18/18, 3116,
corpus 23/23, pins 7/7; tsc clean.

### Round 15 — overlay ensure-fresh priming at match-result construction

The round-14 residue was the MISS scan: a fresh match array's first
`index` define scanned the whole table to find nothing. The regex
match-result builder KNOWS its array is brand-new, so it now calls the
reserved `__vec_overlay_prime` (filled at finalize to
`__vec_overlay_ensure_fresh` — the ensure append tail without the
lookup) right after construction; the subsequent defines hit
tab[count-1] first-probe on the newest-first scan. Per-match overlay
cost is now O(1); the unbounded-table LEAK remains (WasmGC has no weak
tables — needs the per-vec companion-field design, recorded for the
#3683-era layout work). Measured: ~1.48-1.53ms min (≈2%).
Verification: 3251 ×18 green; regex/regexp suites — 17 failures
identical on base (pre-existing (?i:) modifier-group set); corpus
23/23; canaries 4/4; tsc clean.

### Round 16 — literal-alternation trie in the regex bytecode compiler

Acorn's keyword regexes (`^(?:break|case|…)$`, ~30 words) compiled to a
linear SPLIT chain — every `keywords.test(word)` pushed one backtrack
frame per word before failing. Literal alternations (≥4 pure-literal
options, case-sensitive) now compile to a shared-prefix trie: grouping
options with DISTINCT first chars is priority-safe (branches consume
disjoint next chars, so ordered-alternation semantics are unobservable
across groups); same-first-char options keep relative order recursively,
prefix words become ε suffixes which BLOCK grouping across them, and
case-insensitive alternations bail (folded first chars can collide).
Measured (comparative probe, same load): 400k keyword tests 550 →
425ms (−23% on the kw path). End-to-end bench deferred — the #3683 S2
agent is compiling concurrently (loadavg ~4.3) and pollutes wall-clock;
re-measure when quiet. Verification: full regex battery 40 failures,
name-level identical to base (the pre-existing (?i:)/(?s:)/(?m:)
inline-modifier family + 2175 ×3); trie probe (14 keyword cases,
prefix words, ordered-priority exec) green; corpus 23/23; canaries 4/4;
tsc clean.

### Round 17 — hasOwn key flattened once

`__object_hasOwn`/`__hasOwnProperty`/`__propertyIsEnumerable`'s
closed-struct field arms re-ran `__str_flatten(key)` per arm (~one call
+ ref.test per field name, ~70ms self across a bench run under
`__object_hasOwn`). The prologue now flattens the key ONCE into a
scratch local; arms compare the local against their interned literals
(hash-rejected O(1) since round 9). Verification: hasOwn/2896 suites
28/28; corpus 23/23; canaries 4/4; tsc clean. End-to-end bench still
deferred to a quiet box (S2 agent compiling concurrently).

### Round 18 — #3683 S2 integrated (typed-`this` twins)

Merged `claude/3683-s2-typed-this` (5 commits, built by a parallel
session against the S2 spec): `compileLiftedClosureBody` extracted from
`compileArrowAsClosure` (verified byte-identical pre-twin), then 244
typed twins on acorn's admitted prototype methods — `this.field`
reads/writes/compounds/inc-decs lower to bare `struct.get`/`struct.set`
inside the twin (1,340/98/20/98 sites), with a `return_call` shim in the
generic body (`ref.test $__fnctor_F` → twin; miss → original dynamic
body). Kill-switch `JS2WASM_TYPED_THIS=0`; `=shim` isolates the twin
overhead. The S2 agent's isolated measurement: full ≈5% under baseline,
≈9.5% under shim-only. One pin updated at integration: the
detached-receiver absolute value is now the JS-correct 199 — the sibling
`Function.prototype.call/apply` fix (absent from the agent's base) makes
`.call(plain)` read the real receiver in both lanes; twin ≡ generic held
throughout.

**Merged-tree quiet-box bench: 1.392ms min (median ≈1.44)** — cumulative
52.4 → 1.39 (~38x); node-acorn gap ~41x. KEY SEQUENCING FINDING from the
S2 measurement: Parser's hot fields are mostly `externref` (`type`,
`pos`, `options`, `start`, `value`…; only awaitPos/yieldPos/awaitIdentPos
are f64) — S2 removes the dispatcher CALL but not the BOXING, so **S4
(value-rep: f64/i32-typed struct fields + unboxed locals in twins) is
re-sequenced ahead of S3** (S3's direct calls then also recover the ~5%
shim cost). Verification: twin pins 12/12, write-once pins 10/10, i31
pins 7/7, 1712 + 2151-nary + 2674 + 2963 green, corpus 23/23, canaries
4/4; the agent additionally ran full equivalence (213 files) on its
branch — identical failure set to its base; tsc clean.

### Round 18b — same-box re-baseline + warm-up methodology correction

The container restarted ~2x faster, so BOTH lanes re-measured on the
same box, same process discipline (deep warm-up ≥400 parses, then
min-of-24×200): compiled standalone **0.785ms**, warm node-acorn
**0.0177ms** — **gap ≈44x**, consistent with the pre-restart ~41x (the
box lifted both sides equally; no methodology-driven progress, recorded
to keep cross-round ratios honest). Two findings:
- **Warm-up matters more than previously accounted**: the bench's
  scale-to-2s single measurement includes V8 tier-up of the 1.8MB
  module — a shallow-warm run reads ~1.4ms where the tiered steady
  state is ~0.79ms. All future numbers use deep-warm min-of-batches.
- **Binaryen -O3 post-S2 is worth ~5%** under matched warm-up (0.801 vs
  0.846 interleaved same-process) — up from pre-S2 flat (the twins give
  it monomorphic struct.gets to optimize), and worth shipping in the
  artifact configuration, but the initial cold comparison that suggested
  −41% was a tier-up artifact, not a real win.

### Round 19 — hasOwn field arms gated on non-$Object receivers

Deep-warm caller profiling showed `__str_equals` 121ms under
`__object_hasOwn`: acorn's hot hasOwn receivers are plain `$Object`s
(options, refDestructuringErrors), but every call walked ~50
closed-struct field arms — one `__str_equals` call each — before
reaching the base-body `$Object` path, even though those arms can only
ever MATCH a struct receiver (each `ref.test`s its struct). One
receiver test now skips the whole block for `$Object` receivers;
behavior-identical by construction. Measured: `__str_equals`-under-
hasOwn → 0 (total 179 → 80ms in the 3k-parse window); window ~0.94 →
~0.92-0.96ms (≈2-3%, within the noise band but the profile delta is
unambiguous). Verification: hasOwn/2896 suites 28/28; canaries 4/4;
tsc clean.

### Round 19b — builtin-meta probe gated on closure receivers

`__builtinfn_get_meta` runs at the TOP of every `__extern_get` and
classified the KEY first — two `__str_equals` calls ("name"/"length")
per property read program-wide, receiver never consulted until the
arms. Every builtin meta struct subtypes the funcref-wrapper ROOT
(round 6), so one root `ref.test` now gates the whole classification +
arm block: non-closure receivers (fnctors, $Objects, strings — the
overwhelming majority of extern_get traffic) skip it with a single
test. Measured: deep-warm window 0.92-0.97 → **0.83-0.90ms** (≈5%).
Verification: #2896 builtin-meta reflection suite green (closure
receivers unchanged); twin pins 12/12; corpus 23/23; canaries 4/4; tsc
clean.

### Round 20 — start-anchored fast-out in `__regex_search`

`__regex_search` tried a full VM run at EVERY start position; for a
start-anchored pattern (`^…`, multiline off) every position after the
first fails the `BOL` assertion immediately, so the scan was pure
overhead — acorn's anchored keyword `.test`s paid ~word-length VM
attempts each. The search prologue now reads the program's first
non-SAVE opcode (two-three array reads, no compile-time plumbing): a
multiline-0 `BOL` head sets the sticky flag, trying exactly one
position. Conservative: `^a|b` starts with SPLIT and keeps the scan.
Measured: 400k-keyword probe 425 → 146ms (2.9x on that path);
end-to-end `__regex_run` 6.4% → 5.5% and window ~0.86ms (within noise —
the residual regex share is the UNANCHORED patterns: lineBreak etc.).
Verification: full regex battery failure set name-identical to the
round-16 pre-existing set; corpus 23/23; canaries 4/4; tsc clean.

### Round 21 — per-object cache staleness via props-array identity

The global `__obj_table_gen` is retired. It was bumped by EVERY
`__obj_grow`, and acorn's per-parse options build grows its table twice
— cold-starting every per-key cache program-wide at each parse start
(~50 hot keys × 2 storms of slow re-population per parse). Staleness is
now witnessed per object: population stores the owner's props ARRAY in
the key's `$HashedString` (field 7), and every hit `ref.eq`s it against
the live `owner.props` — a grow replaces the array, so exactly the
grown object's cached entries miss; field 4 degrades to a populated
flag. All three consumers converted (`__extern_get` hit arm,
`__method_cache_lookup`, the `__call_m_*` inline arms). Also recorded:
a NULL result — sorting the `__fnctor_proto_start` ladder by struct
field count (Parser-first) measured ~4% WORSE (TokenType's per-token
`updateContext` receivers dominate some phases); reverted.
Measured: window 0.86-0.90 → **0.82-0.87ms** (~3-4%). Verification:
cache-semantics battery (accessor/defineProperty/delete/2896/2866/1888/
2674/2963/twin/i31) 118/118; corpus 23/23; canaries 4/4; tsc clean.

### Round 22 — backtrack-stack pool in the regex VM

`__regex_run` allocated (and zeroed) a fresh 64-slot backtrack-frame
array per invocation — and `__regex_search` invokes it once per scan
position. A single module-global pool slot now lets the top-level run
REUSE the previous run's (possibly grown) stack: checkout nulls the
slot, so a NESTED lookaround run simply allocates fresh
(reentrancy-safe); both VM exits check the stack back in (the cap-throw
path doesn't — a thrown parse abandons the pool entry, refilled on the
next run). Frames above `top` may retain stale snapshot refs until
overwritten — bounded by the deepest stack seen, the standard engine
trade. Measured: window 0.82-0.87 → **0.78-0.83ms**. Verification: full
regex battery failure set identical to base (timing-stripped name
diff); trie probe green; corpus 23/23; canaries 4/4; tsc clean.

### Round 23 — caps-snapshot elision for group-free regex programs

Every backtrack-frame push snapshotted the caps array into a fresh
allocation. For a group-free, scratch-free program (`nSlots == 2` —
whole-match slots only) the restore is provably dead: caps[0] is set
once at entry and never changes within a run; caps[1] is written only
at `SAVE 1` immediately before MATCH returns; backrefs and PROGRESS
both imply `nSlots > 2`. Snapshot and restore are now both guarded on
`nSlots > 2`, with a shared zero-length dummy filling the frame field —
acorn's keyword and lineBreak tests push zero-alloc frames. Keyword
probe 154 → 117ms; window ~0.78-0.84 (noise band overlapping round 22 —
the alloc win shows in the probe and GC pressure, not clearly in wall).
Verification: regex battery failure set identical; corpus 23/23;
canaries 4/4; tsc clean.

## Standalone medium-fixture trap — BISECTED (round 24 diagnostics)

The pre-existing 17-file-concat standalone trap decomposes into SIX
independent per-file parse failures (host lane parses all 17 exactly;
each repro'd standalone via an in-module line prober, .tmp/bisect-*):

| fixture | first failing construct | class |
| --- | --- | --- |
| literals.js | `const big = 9007199254740993n;` | BigInt literal path |
| arrow-params.js | `({ a, b }) => a + b` | destructured arrow params |
| destructuring.js | `const { x, y: yy, z = 10, ...others } = obj` | object pattern conversion |
| escapes-unicode.js | `'\x41\102'` | string escape reading (parseInt radix 8/16 verified OK standalone — cause is deeper, possibly a wrong `this.strict` read → octal raise) |
| generators-async.js | (module-level) `illegal cast` | cast bug, not a parse raise |
| regex.js | (module-level) `illegal cast` | cast bug, not a parse raise |

The two `illegal cast` entries are COMPILER/runtime bugs (trap, not a
thrown SyntaxError); the four raises are standalone-runtime divergences
inside acorn's own code paths. Each is a self-contained investigation —
filed here so the medium-input benchmark (where per-parse fixed costs
amortize and the node-acorn ratio is expected to be materially better)
can be unlocked. Not chased further in this session (perf focus).

### Round 26 — four root causes fixed, `escapes-unicode.js` green

Standalone fixture failures **6 → 5**; the two `illegal cast` traps and
the `u`-flag infinite HANG they were masking are gone. Diagnostics used:
`.tmp/sa.mjs` (compile one tiny standalone program, print result/trap
stack) and an instrumented-acorn probe (`.tmp/diag-raise.mjs`, which
records acorn's RAW raise message before acorn's own
`message += " (line:col)"` rewrite) — worth keeping, they turn
`[object WebAssembly.Exception]` into a named cause in one 16s compile.

| # | root cause | fixture |
| --- | --- | --- |
| 1 | `substr` missing from the guarded any-receiver string gate (Annex-B ⇒ absent from `STRING_METHODS`, which doubles as the JS-host import manifest, but a native `__str_substr` arm exists). Dynamic `this.input.substr(a, b)` fell to the generic `__extern_method_call` string-brand arm ⇒ `undefined` ⇒ `""`. | escapes-unicode ✅ |
| 2 | `x \| 0` on an externref preferred `parseFloat` whenever the module had registered it. Wrong semantics (`"10abc"\|0`→10, `"0x10"\|0`→0) AND a hard trap: native `parseFloat` opens with an unguarded `ref.cast $AnyString`, so a boxed NUMBER operand → "illegal cast". acorn hit it on EVERY regex (`reset`'s `this.start = start \| 0`). Same class as #2109. | regex, generators-async (unmasked) |
| 3 | A user method sharing a `String.prototype` name was answered with the string arm's *miss sentinel*. acorn's `RegExpValidationState.prototype.at` vs `String.prototype.at`: `state.at(i)` read back `0` instead of the `-1` EOF sentinel, so `regexp_eatPatternCharacters`'s `while ((ch = state.current()) !== -1 …)` **never terminated** — every `u`-flag regex HUNG the standalone parser. New `collectUserMethodNames` pre-pass + a `__call_m_<name>_<arity>` fallback on the miss, scoped to names the source actually defines so the unboxed hot path (charCodeAt/slice/substr) is untouched. | regex (hang) |
| 4 | `obj.prop += rhs` on a dynamic receiver was an unconditional `f64.add` standalone. #2850 fixed exactly this for the host lane and explicitly excluded standalone; `emitAnyAddFromExternTemps` (split out of `emitAnyAdd`) gives the standalone lane the same §13.15.3 dispatch. | (independent; pinned) |

Pins: `tests/issue-3673-standalone-gaps.test.ts` (20).

### Remaining standalone fixture gaps (round 26 diagnosis)

Now that the traps/hangs are gone, the failures are **named acorn
raises** rather than opaque exceptions:

| fixture | acorn's own message | diagnosis |
| --- | --- | --- |
| destructuring.js | `Binding rvalue` @ the shorthand key | `const { x } = o` fails, `{ y: yy }` / `{ ...r }` PASS ⇒ isolated to the **shorthand** property, whose value node acorn builds with `copyNode` = `for (var p in node) newNode[p] = node[p]`. On a fnctor instance standalone, `for…in` enumerates **0 keys**, `Object.keys` returns **0**, and a computed write `n[k] = v` is a **no-op** (all three verified minimal). So the copy is empty ⇒ `.type` undefined ⇒ `checkLValSimple` default. |
| arrow-params.js | `Assigning to rvalue` | same `copyNode`/shorthand cause, non-binding side. |
| regex.js | `Duplicate capture group name` on `/(?<year>…)-(?<month>…)/` | the two names collapse to one `groupNames` key ⇒ `state.lastStringValue += codePointToString(…)` is not accumulating. NOT fully explained by gap 4 above (that fix is landed and pinned; regex.js still fails), so the residue is in the fnctor `this.<field>` read/write path. **Caveat: not established.** Minimal probes of that path are confounded — an external `s.pos` read returns 0 even in shapes where acorn's own internal `this.pos` demonstrably works, so the probe may be measuring the READ, not the write. Needs a probe that observes the field from INSIDE the fnctor. |
| generators-async.js | `Unexpected token` @ pos 124 (`async function* ag`) | async-generator declaration parse; not yet investigated. |
| literals.js | our runtime throws `Cannot convert string to a BigInt in standalone mode` | `BigInt(str)` has no native standalone implementation (`__bigint_ctor` defers string parsing). acorn's `stringToBigInt` calls it directly. Bounded: parse decimal + `0x`/`0o`/`0b` into the i64 carrier. |

The `for…in` / `Object.keys` / computed-write gap on fnctor instances is
the highest-value next slice — it alone unblocks two fixtures and is a
general reflection hole, not an acorn quirk. It lives in the
fnctor/typed-this machinery (`deriveFnctorFields` + the member-set
dispatchers), so it wants to be sequenced against #3683's owner.

### Round 25 — #3683 S4a integrated (numeric f64 fields)

Merged `claude/3683-s4-value-rep`: `analyzeNumericPropertyNames` (whole-
program numeric write-set analysis with ONE documented trust boundary —
the `parseExpressionAt` position parameter, ToNumber-coerced on write,
pinned as an explicit divergence test) promotes acorn's ENTIRE tokenizer
hot set (`pos` 232 twin sites, `start` 92, `lastTokStart`/`lastTokEnd`,
`end`, `curLine`, `potentialArrowAt`, `yieldPos`, `awaitPos`,
`awaitIdentPos`) from boxed externref carriers to physical f64 slots.
Kill-switch `JS2WASM_NUMERIC_FIELDS=0`. The agent's honest measurement:
**≈1-2% wall, indistinguishable from zero on this harness** (it added a
byte-identical duplicate-baseline control arm that itself disagrees by
0.6-3.4% — a methodology contribution worth keeping); the profile
confirms the targeted boxing removed (`__box_number` 1.81→1.33%,
`__unbox_number` 1.66→1.32%) but the whole box/unbox surface was only
≈4.5% to begin with. S4b bounded at ~3% and correctly skipped. The
REAL remaining levers, from its post-S4a profile: **method-call bridge
≈13% (S3)** and **generic property lookup on non-`this` receivers ≈14%**
(`node.start`, `this.options.locations` — extend the #2660 receiver-flow
map to prove fnctor receivers and inline `struct.get`). Gates: full
equivalence diffed BY NAME vs merge parent — identical 33-failure set;
15 new pins; corpus 23/23; canaries; tsc clean.

## Multi-fixture gap dashboard (round 25, same-box deep-warm mins)

`.tmp/bench-multi.mjs` — five fixtures compiled into one standalone
module, wasm vs node-acorn measured in the same process, deep-warm
min-of-batches both sides:

| fixture | bytes | wasm ms | node ms | ratio |
| --- | --- | --- | --- | --- |
| literals.js | 259 | TRAP | — | (BigInt gap, agent in flight) |
| members-calls.js | 213 | 0.507 | 0.0145 | 34.9x |
| control-flow.js | 330 | 0.771 | 0.0198 | 38.9x |
| operators.js | 240 | 0.624 | 0.0159 | 39.3x |
| objects.js | 269 | 0.515 | 0.0139 | 37.1x |

Mean ≈37.5x — and control-flow.js, the fixture every round tuned
against, is near the WORST case, so the single-fixture numbers have
been a conservative representation of the corpus-wide gap.
### Round 26 — #3683 S3 integrated (direct-call devirtualization)

Merged `claude/3683-s3-direct-calls`: inside a typed twin, `this.<m>(args…)`
on a write-once prototype method of the same fnctor lowers to a direct
`call $__dc_<F>_<m>_<n>` with native-typed arguments — **1,458 sites across
229 trampolines on acorn** (219 hit a twin, 10 degrade to the legacy fill).
Kill-switch `JS2WASM_DIRECT_CALLS=0` reproduces the S4a tip byte-for-byte.

**This is the first change in the #3683 family whose wall-clock effect is
unambiguously outside the noise floor.** Same interleaved deep-warm
min-of-batches methodology, with the S4a duplicate-baseline control arm made
provably exact (the kill-switch build IS the base, asserted byte-identical):

| session | batches | S3 | base | base2 | control band | S3 vs mean |
| --- | --- | --- | --- | --- | --- | --- |
| 1 (40) | s3,base,base2 | 1.1046 | 1.3085 | 1.3110 | 0.19 % | **−15.7 %** |
| 2 (40) | base2,base,s3 | 1.1047 | 1.3225 | 1.3175 | 0.38 % | **−16.3 %** |
| 3 (60) | base,s3,base2 | 1.0443 | 1.2866 | 1.2806 | 0.47 % | **−18.7 %** |

The profile confirms the mechanism: the method-call bridge is **halved**,
18.10 % → 9.62 % self time (`__call_fn_method_1` 5.78→2.57,
`__call_fn_method_0` 3.81→1.56, `__method_cache_lookup` 3.21→1.13). Note that
`__extern_get` 7.44→9.07 % and `__regex_run` 6.15→7.06 % are SHARE increases
against a 15 % smaller total, not absolute regressions. Binary 1,808,486 →
1,807,913 bytes (smaller — a direct call is fewer bytes than the dispatcher
call it replaces).

Two findings worth carrying forward:
- **The remaining 428 declines are all `arity-mismatch`** — under-applied calls
  (`this.parseIdent()` into a 1-formal method), the common JS shape. That is
  the next increment, and #3683's S3 notes record the exact `__argc` = *formals*
  + undefined-sentinel padding convention `__apply_closure`'s #3592 widening
  uses, which a padding trampoline must reproduce or default-parameter presence
  silently flips program-wide.
- **A pre-existing latent bug in `fixups.ts` was surfaced and worked around, not
  fixed**: its `ref.null.extern` retyping walks call arguments one INSTRUCTION
  per parameter and skips a nested call by its PARAMETER count, so any argument
  built from >1 instruction misaligns it. It was harmless only because every
  callee in that position had an all-`externref` signature. Worth its own issue.

Gates: full equivalence diffed BY NAME vs merge parent — identical 33-failure
set; 16 new pins; corpus 23/23 with 0 real gaps; canaries 4/4 with `imports:
0`; tsc, LOC-budget and oracle-ratchet clean.

### Round 26b — S3 integration verified on the merged tree

Lead-session re-measurement after merging S3 (agent numbers reproduced
independently, quiet box):

- **deep-warm window 0.665-0.699 ms** (was 0.78-0.86 pre-S3).
- **Multi-fixture dashboard, ratios vs node-acorn re-measured same-process:**

| fixture | bytes | wasm ms | node ms | ratio | was (round 25) |
| --- | --- | --- | --- | --- | --- |
| members-calls.js | 213 | 0.394 | 0.0127 | **30.9x** | 34.9x |
| control-flow.js | 330 | 0.590 | 0.0191 | **30.8x** | 38.9x |
| operators.js | 240 | 0.506 | 0.0161 | **31.4x** | 39.3x |
| objects.js | 269 | 0.423 | 0.0138 | **30.7x** | 37.1x |

Mean **≈31x**, down from ≈37.5x — and the spread collapsed (34.9-39.3x
→ 30.7-31.4x), i.e. S3 removed a per-call cost that scaled with every
fixture rather than a fixture-specific artifact. Gates on the merged
tree: corpus 23/23 with 0 real gaps; 50/50 across the direct-call /
twin / numeric-field / i31 pin suites; tsc clean.

### Round 27 — the gap is PER-BYTE, not per-parse (scaling decomposition)

`.tmp/bench-scaling.mjs` parses the same source repeated 1x/2x/4x/8x
(334 B → 2,679 B) on both lanes, same process, deep-warm mins, and
least-squares-fits `t = fixed + slope·bytes`:

| mult | bytes | wasm ms | node ms | ratio |
| --- | --- | --- | --- | --- |
| 1 | 334 | 0.625 | 0.0202 | 30.9x |
| 2 | 669 | 1.172 | 0.0360 | 32.6x |
| 4 | 1,339 | 2.286 | 0.0722 | 31.7x |
| 8 | 2,679 | 4.695 | 0.1450 | 32.4x |

**wasm: 0.011 ms fixed + 1.781 ms/KB · node: 0.0011 ms fixed +
0.0548 ms/KB → fixed-cost ratio 9.5x, per-KB ratio 32.5x.**

Three consequences worth acting on:
1. **The ratio is size-INDEPENDENT.** Larger inputs will not improve it;
   the medium-fixture work (round 24 bisect, in flight) is a
   CORRECTNESS goal, not a benchmark-ratio goal. Recorded so nobody
   expects a ratio win from unblocking it.
2. **Per-parse fixed cost is already excellent** (0.011 ms — Parser
   construction, keyword-regex build, context init). Nothing to win there.
3. **Everything left is the per-character tokenizer + per-node builder
   path**, which is exactly where the remaining profile sits
   (`__extern_get` 8.8 %, regex 7.6 %, GC 3.7 %, and ~25-30 % spread
   across the `__closure_*__typed_this` parser bodies themselves).

Also measured this round: `__str_substring`/`__str_slice` already SHARE
the backing array (`off = sOff + start`, no copy) — the obvious
"identifier extraction copies" hypothesis is already handled, no lever
there. And **Binaryen `-O3` is now worth 7.1 %** post-S3 (0.618 →
0.574 ms, matched deep-warm) — up from ~5 % post-S2 and ~0 % pre-S2, as
the monomorphic direct calls give it something to inline. Worth wiring
into the shipped standalone artifact configuration.

### Round 28 — standalone correctness gaps: 4 root causes fixed (6 → 5 failing fixtures)

Merged `claude/3673-standalone-gaps`. `escapes-unicode.js` is green and
BOTH `illegal cast` traps plus an infinite hang they masked are gone;
the remaining five fixtures now fail with NAMED acorn raises instead of
opaque exceptions. Four root causes, all general bugs rather than
acorn quirks:

1. **`substr` missing from the guarded any-receiver string gate** — it
   is Annex-B so absent from `STRING_METHODS`, but that table doubles as
   the JS-host import manifest while a native `__str_substr` arm already
   existed. Dynamic `o.f.substr(a,b)` fell to `__extern_method_call` →
   undefined → `""`.
2. **`x | 0` on an externref called `parseFloat`** — wrong semantics
   (`"10abc"|0` → 10, spec 0) AND a hard trap (native `parseFloat` opens
   with an unguarded `ref.cast $AnyString`, so a boxed NUMBER operand
   trapped). Same class as the #2109 comparison fix; routed through
   `__unbox_number`. Note the "obvious" `coerceType(…,"number")` fix blew
   acorn's build from ~18s to >10min and was rejected.
3. **A user method colliding with a `String.prototype` name got the miss
   sentinel** — `RegExpValidationState.prototype.at` vs
   `String.prototype.at`: `state.at(i)` read back `0` instead of the `-1`
   EOF sentinel, so `regexp_eatPatternCharacters` never terminated —
   **every `u`-flag regex hung the parser**. New `user-method-names.ts`
   pre-pass scopes the `__call_m_*` fallback to names the source actually
   defines, so charCodeAt/slice/substr keep their unboxed hot path.
4. **`obj.prop += rhs` on a dynamic receiver was an unconditional
   `f64.add` standalone** — #2850 fixed this host-only; the compound path
   now reaches the in-module §13.15.3 dispatch.

Fixture status 12/17 pass (was 11), verified no regressions via
`.tmp/bisect-medium.mjs`. Cost: deep-warm 0.682 → 0.708 ms (**≈4 %
slower, accepted** — it buys two hard traps and a hang). Gates: new
20-test suite; 70/70 across gaps/direct-calls/twin/numeric-fields/i31;
corpus 0 real gaps incl. acorn self-parse; canaries `imports: ZERO`.

Remaining five, with diagnosis (see the agent's notes in #3673):
`destructuring.js` + `arrow-params.js` share ONE cause — `for…in` over a
fnctor instance enumerates 0 keys standalone, `Object.keys` returns 0,
and computed writes are no-ops, so acorn's `copyNode` produces an empty
node (highest-value next slice: one fix, two fixtures, general
reflection hole); `regex.js` duplicate-capture-name (undiagnosed —
probes confounded by an external-read hole); `generators-async.js`
uninvestigated; `literals.js` needs decimal + `0x/0o/0b` BigInt parsing
into the existing i64 carrier. Reusable diagnostics left in `.tmp/`:
`sa.mjs` and `diag-raise.mjs` turn an opaque exception into a named
cause in one 16 s compile.

### Round 29 — unanchored leading-literal prefilter (general win, FLAT on acorn)

Round 20 made *anchored* programs try exactly one start position. An
UNANCHORED program whose first non-SAVE op is `CHAR c` still ran the
full backtracking VM at every position, even though a match must begin
with `c`. `__regex_search` now records that leading unit and advances
past non-matching positions with one `array.get` each. Narrow by
design: plain `CHAR` only — not `CHARI` (ASCII fold needs two compares)
and not `CLASS` (table walk) — with `-1` disabling the filter so every
other program keeps round-20 behavior exactly.

**Synthetic probe: 200k unanchored literal scans 146.7 → 24.6 ms (6x),
identical results. End-to-end on acorn: FLAT (0.693-0.718 ms vs
0.708-0.709).** Honest reading: acorn's hot regexes are anchored
(round 20 already handles them) or class-headed (filter stays off), so
this pattern class barely appears in the parse. Kept because it is a
correct, general engine improvement that costs one compare per skipped
position against a whole VM invocation — but recorded as NOT a
benchmark win, in the same spirit as the i31 and ladder-reorder nulls.

Verification: full regex battery failure set identical to the known
pre-existing 40; corpus 23/23 with 0 real gaps; canaries `imports:
ZERO`; tsc clean.

### Round 30 — dogfood the SHIPPED artifact configuration (wasm-opt on)

The CLI has defaulted to `-O3` since #1950, but the dogfood standalone
artifact and every bench compiled through the programmatic `compile()`
API, whose `optimize` defaults to false — so we were measuring (and
dogfooding) a configuration nobody ships. Both now pass `optimize: 3`.
`optimizeBinaryAsync` validates its own output and falls back to the raw
binary with a warning, so this can only change performance, never
correctness. NOT changed: `compile()`'s API default stays false —
flipping it would add ~20 s of Binaryen to every one of the hundreds of
compiles in the test suite.

**Measured: deep-warm 0.693-0.718 → 0.597-0.665 ms; binary 1,808 KB →
1,216 KB (−33 %).** Multi-fixture dashboard on the shipped config:

| fixture | wasm ms | node ms | ratio |
| --- | --- | --- | --- |
| members-calls.js | 0.442 | 0.0142 | 31.1x |
| control-flow.js | 0.655 | 0.0209 | 31.4x |
| operators.js | 0.493 | 0.0162 | 30.4x |
| objects.js | 0.394 | 0.0138 | **28.6x** |

First fixture under 30x. Corpus 23/23 with 0 real gaps on the optimized
artifact.

## Round 31 — a compile-friendly tokenizer BEATS node-acorn (goal reached, for lexing)

Round 27 concluded with an assertion: "a parser written to compile well
would skip most of this list by construction." That was never tested, so
this round tests it. `benchmarks/tokenizer/fast-tokenizer.ts` is a JS
tokenizer written to the compiler's strengths — `i32` native annotations
for every position (no boxing), top-level typed functions (no closures,
no `this`, so no closure structs and no call bridge), flat preallocated
`Int32Array` output (no property access in the hot loop), `charCodeAt`
on a string param (lowers to `array.get_u`). Compiled `--target
standalone`, **zero imports, 36 KB**.

Correctness first: its token stream is compared position-by-position
against `acorn.tokenizer` on all 17 corpus files. **13 match EXACTLY**
and are the benchmark set; the other 4 use constructs it simplifies
(class private fields, unicode escapes in identifiers, a numeric-literal
edge, and `${}` splitting inside templates) and are EXCLUDED. Both facts
are pinned in `tests/issue-3673-fast-tokenizer.test.ts` — including the
divergence list, so growing coverage is a deliberate act rather than a
silent benchmark change.

| mode | total (13 files, 2,949 B) | vs node-acorn |
| --- | --- | --- |
| node-acorn `tokenizer` | 0.1176 ms | 1.00x |
| ours, boundaries only | 0.0636 ms | **0.54x (1.85x faster)** |
| ours, materializing token values | 0.0915 ms | **0.78x (1.28x faster)** |

The value-materializing row is the apples-to-apples one: acorn's
tokenizer eagerly builds `token.value`, so ours slices name/string text
and `parseFloat`s numerics too. It wins on **all 13 files** in both
modes (throughput 44.2 vs 23.9 MB/s boundaries-only). `regex.js` is the
outlier at 0.23x because acorn additionally runs full RegExp validation
there.

**What this does and does not establish.** It establishes that
js2wasm-compiled code CAN outperform node-acorn on the per-byte lexical
core — the exact cost centre round 27 isolated (1.78 ms/KB of which
~two thirds is parser-body execution). It does NOT establish that
compiled ACORN can: acorn's own source is `any`-typed prototype-style JS
whose every field read is a dispatcher call, which is why it sits at
~31x, and no slice of #3683/#3685 changes that source. The two results
together are the honest answer to "can we beat node-acorn": **yes, by
writing the parser for the compiler — not by optimizing a compiled
parser written for V8.**

Reproduce: `npx tsx benchmarks/tokenizer/validate.mjs` (stream equality)
then `npx tsx benchmarks/tokenizer/bench.mjs --recompile`.

### Round 31 — the hot-chain experiment: what typing is actually worth

Hand-verification of the question "could the IR reach node-acorn on
UNMODIFIED acorn?", using acorn's real `readWord1` inner loop
(`this.input.charCodeAt(this.pos)` → classify → `this.pos += 1` → final
`slice`) scanning the 4 KB corpus. THREE compilations of the SAME
algorithm, answers asserted identical (`653002199` all three):

| variant | shape | ms/scan | throughput | vs node |
| --- | --- | --- | --- | --- |
| **A dynamic** | acorn's verbatim shape (fnctor + `pp` alias + untyped fields) — what we compile today | 0.4294 | 8.8 MB/s | **17.9x** |
| **B typed** | identical algorithm, TS types on fields/params/locals — the ceiling an IR reaches by DERIVING what B states | 0.0659 | 57.2 MB/s | **2.8x** |
| **N node** | variant A's JavaScript on node | 0.0239 | 157.7 MB/s | 1x |

**Typing multiplier on the parser body: 6.51x.** Mechanism confirmed by
opcode counts in the emitted modules:

| | `__extern_get` | `__box_number` | `__unbox_number` | `__apply_closure` |
| --- | --- | --- | --- | --- |
| A dynamic | 66 | 70 | 85 | 20 |
| B typed | **0** | 2 | 5 | **0** |

Typing does not shave the dispatch and boxing — it DELETES them. This is
the same lesson #3683 S4a taught from the other direction (typing one
field gained ~1 % because its consumers still boxed): the win is a
whole-chain property, all-or-nothing per chain.

**What it implies for full acorn.** Today 1.78 ms/KB; ÷6.51 ≈ 0.27 ms/KB
against node's 0.055 ⇒ **~31x → ~5x** if the IR derived types across the
whole parser. That is a projection, not a measurement, and it is an upper
bound: acorn has constructs that will not type (polymorphic `Node` field
sets, `copyNode`'s `for…in` + computed writes, the `options` bag), so
expect the achieved figure to be worse than 5x. But B's **2.8x** is a
real, measured floor for well-typed WasmGC against V8's JIT on this kind
of code — far closer than the 17.9x the same algorithm pays today.

**Conclusion for sequencing**: the remaining gap is NOT irreducible
"AOT vs JIT" overhead. It is our own dynamic lowering, and ~6.5x of it is
reachable by inference alone — no speculation, no deopt, no runtime
profiling. #3685 is that program; the residual ~2.8x is where
speculation (profile-guided AOT) would be needed. Repro:
`.tmp/chain-experiment.mjs`.

### Round 32 — the shootout: is "outperform node-acorn" reachable at all?

Round 31 measured a typed CHAR LOOP at 2.8x node and projected full
acorn at ~5x. That still left the goal question open, because a parser is
not a char loop — it ALLOCATES. So: a complete recursive-descent
expression parser (tokenizer + precedence climbing + real AST nodes +
a post-walk), written twice with the same algorithm statement for
statement, checksums asserted equal.

| workload | ours (typed) | node (same JS) | ratio |
| --- | --- | --- | --- |
| full parse + AST build | 0.1792 ms | 0.1062 ms | 1.69x |
| same, with native `i32` fields/locals | 0.1684 ms | 0.1062 ms | **1.59x** |

> **CORRECTION (round 36):** the `i32` row above is MISLABELED. The
> `type i32 = number` annotation is **inert outside `fast` mode** — the
> emitted module for that variant carries `locals=[f64,…]` and a `Lexer`
> struct of `(mut f64)` fields regardless of the annotations. So that row
> measured the same f64 code as the row above it, and its 6 % is noise or
> an unrelated effect, NOT native integers. Established by isolated probes
> (gc/standalone/wasi → f64 locals; `fast: true` → i32 locals + one fewer
> conversion). Making the annotation take effect is now its own slice.

| **tokenize only (no AST allocation)** | 0.1050 ms | 0.0343 ms | **3.06x** |

**The counterintuitive result is the useful one: our gap is WORSE without
allocation (3.06x) than with it (1.59x).** WasmGC struct allocation plus
AST construction is competitive with V8's inline-allocated hidden-class
objects — V8's relative advantage SHRINKS once it has to allocate. What
we are actually bad at is the tokenizer's character loop.

Emitted-code evidence for why: the char access itself is already ideal
(`array.get_u` off a `struct.get` data pointer, no flatten call, no
per-access `ref.test`), but `String.prototype.charCodeAt` is typed to
return `number` — so every character does **`array.get_u` → i32 →
`f64.convert_i32_u` → compare/`i32.trunc_sat_f64_s` → i32** even when
BOTH ends are `i32` (the module shows 29 `i32.trunc_sat_f64_s` and 9
`f64.convert_i32_u` against 41 `array.get_u`). It is the round-31 lesson
again, one level down: a fully typed chain broken by ONE f64 boundary in
the middle.

**Where this leaves the goal.** Best case measured with today's compiler
on ideal (hand-typed) input is **1.59x slower than node**, not faster.
The ladder is now fully measured, no extrapolation:

| | ratio vs node |
| --- | --- |
| compiled acorn today | 31x |
| acorn with perfect type inference (projected, round 31) | ~5x |
| a parser WRITTEN typed, compiled today | 1.59x |
| a parser written typed, if the charCodeAt f64 boundary is fixed | ? (the next experiment) |

So "outperform node-acorn" is not reachable by inference on acorn alone
— but the residual on ideal input is 1.59x, not an order of magnitude,
and its largest identified component is a fixable representation bug in
our own string-index lowering rather than anything structural about AOT
or WasmGC. That makes **typed `charCodeAt` result flow** the highest-value
next compiler slice for this goal, ahead of further receiver work.

Repros: `.tmp/parser-shootout.mjs`, `.tmp/shootout-c.mjs`,
`.tmp/tokenize-only.mjs`.

### Round 33 — attempted charCodeAt round-trip fix: NULL RESULT (reverted)

Round 32 identified the per-character `i32 → f64 → i32` round trip as the
top lever. Attempted the cheap version: a peephole cancelling a MATCHED
`f64.convert_i32_s`/`i32.trunc_sat_f64_s` pair (exact — every i32 is
representable in f64; the MISMATCHED u→s pair is deliberately not folded
since `convert_i32_u` of ≥2^31 saturates), plus switching the char-read
conversions to signed so they form a foldable pair.

**It did not fire.** Opcode counts were unchanged (29 truncations before
and after) and wall-clock was flat (0.1050 → 0.1070 ms). The pairs are
NOT adjacent: codegen emits `array.get_u; f64.convert_i32_*` and then
`local.set` / `local.get` before the consumer's truncation, so a
two-instruction window can never see them. Reverted rather than shipped —
a correct rule that never matches is dead weight.

Two notes for whoever takes the real fix:
- A **local-aware** pass (a local written only from `convert_i32_*` and
  read only into `trunc_sat_f64_*` can hold i32 directly) would catch it,
  but that is a small dataflow pass, not a peephole.
- The **right** fix is the result-type contract: `charCodeAt` should be
  able to yield i32 when its consumer is an integer context, the same way
  #3673 round 8's typed `__get_member_<n>__f64` dispatchers avoid the
  box→unbox round trip. That is a proper slice.

Also confirmed during this round: `tests/issue-1817.test.ts` has **3
pre-existing failures** (`>>>` unsigned semantics) on the clean tip —
verified against an unmodified tree, unrelated to this attempt.

### Round 34 — native strings vs `wasm:js-string`, ISOLATED

Every #3673 number so far compared LANES (standalone vs gc/host), which
confounds the string backend with the object runtime it ships alongside.
This isolates the string backend: the SAME typed tokenizer source
compiled twice, differing only in `nativeStrings`, both instantiated and
measured in one process, checksums identical (`84077`), three runs:

| backend | binary | imports | ms | throughput |
| --- | --- | --- | --- | --- |
| **native (WasmGC i16 arrays)** | 38,519 B | **0** | 0.0990-0.0998 | **72 MB/s** |
| `wasm:js-string` (V8 builtins) | **8,738 B** | 4 (2 js-string) | 0.1234-0.1246 | 58 MB/s |

**Native strings are ~1.24x faster; the js-string binary is ~4.4x
smaller.** Spread inside each backend is under 1 %, so the difference is
real.

Mechanism: native strings put the character data in a WasmGC `i16` array
the module owns, so `s.charCodeAt(i)` is `array.get_u` off a `struct.get`
data pointer — round 32 confirmed that is already the optimal shape.
`wasm:js-string` keeps the data in V8's own string representation, so
each access is a builtin CALL across the boundary; V8's implementation of
that call is excellent, which is why it lands within 24 % rather than
being routed, but a call still cannot beat an inline load.

The tradeoff is therefore SIZE vs SPEED, not one backend being strictly
better: js-string needs no rope/flatten/intern machinery in the module
(hence 4.4x smaller) but pays a call per character; native strings inline
the access but carry their own string runtime.

Two caveats worth recording. First, native strings only became the
faster option because rounds 2-3 fixed them — before literal interning
and `__str_flatten` memoization the standalone lane was **3.5x SLOWER**
than the host lane. The backend is not inherently superior; the
implementation was simply bad and then wasn't. Second, this measurement
needed the full host harness to be honest — `buildImports(imports, deps,
stringPool)` AND the `setExports` callback. Skipping `setExports` leaves
the struct getters unwired and the js-string lane traps with
"illegal cast" inside `length`, which could easily be mistaken for a
compiler bug. Repro: `.tmp/string-backend.mjs`.
### Round 34 — the SIMD avenue is DEAD, and the ceiling is 2.3x FASTER than node

Round 32 blamed the character scan for the tokenize-only 3.06x gap, which
raised an obvious question: could Wasm **SIMD** — a capability V8 cannot
apply to a scalar JS character loop — buy back the loss? This round
answered that by measuring the *ceiling* directly with hand-written Wasm,
independent of our compiler.

**What our compiler supports today.** v128 is fully encoded — `SIMD` in
`src/emit/opcodes.ts` (all the load/splat/compare/bitmask/shuffle
opcodes), encoding in `src/emit/binary.ts`, printing in `src/emit/wat.ts`,
`v128` in the `ValType`/`Instr` unions in `src/ir/types.ts`, and
`stack-balance.ts` knows the arities. But the **only producer** is
`src/codegen-linear/simd.ts` — four hand-built runtime helpers
(`__str_eq_simd`, `__str_indexOf_simd`, `__arr_indexOf_simd`,
`__arr_fill_simd`) for the **linear-memory** backend. `addSimdRuntime` is
called from **`tests/simd.test.ts` and nowhere else**, and the
`simd?: boolean` option declared at `src/index.ts:408` is **never read**.
So SIMD is dead code: no TypeScript syntax reaches it in either backend.
It is also structurally unavailable on the WasmGC path — `v128.load`
addresses *linear memory*, and our strings are `$__str_data`, a WasmGC
`(array (mut i16))`, which no instruction can vector-load.

**Method.** All lanes measured **interleaved in ONE process**, deep-warmed,
min-of-14-batches × 50 reps, 5 rounds per process, repeated in 3
independent processes. Every lane asserts the identical checksum (83717)
on the identical 7,517-char input, plus a 90-case correctness sweep
covering non-ASCII, lone surrogates, and **every** length 0..80 (so all
len % 8 and len % 32 residues). Node was stable this time (min 0.0346 /
0.0348 / 0.0353 across the three processes) — not the 0.0343→0.0569
excursion round 32 warned about. Probes:
`.tmp/simd-tok.wat` (linear-memory + SIMD lanes, `wat2wasm`),
`.tmp/gc-tok.wat` (WasmGC lanes, binaryen `wasm-as --enable-gc`),
`.tmp/simd-shootout.mjs` (harness; also compiles the round-32 source with
our own compiler as the last lane). Node v22 accepts v128 — verified.

| lane | ms/parse | vs node |
| --- | --- | --- |
| node (JS, V8) | 0.0346–0.0353 | — |
| **hand-written WasmGC, i32 char reads** | **0.0148–0.0154** | **2.26–2.34x FASTER** |
| hand-written WasmGC, + identity call (control) | 0.0149–0.0155 | 2.25–2.33x faster |
| hand-written WasmGC, + `charCodeAt` f64 round trip | 0.0400–0.0414 | 1.14–1.19x slower |
| hand-written linear-memory scalar (locals) | 0.0221–0.0230 | 1.51–1.58x faster |
| hand-written linear-memory scalar, OO shape | 0.0285–0.0288 | 1.21–1.24x faster |
| SIMD: bitmap prepass + ctz token loop | 0.0276–0.0281 | 1.24–1.26x faster |
| SIMD: per-run 8-wide probe, no prepass | 0.0373–0.0385 | **1.07–1.11x SLOWER** |
| same bitmap token loop, *scalar* classification | 0.0540–0.0576 | 1.56–1.63x slower |
| [SIMD classification prepass alone] | 0.0014–0.0015 | ~5.0 GB/s |
| our compiler, same TypeScript (round 32 source) | 0.1007–0.1032 | 2.91–2.97x slower |

**1. SIMD is a dead avenue for this workload — a clear negative.** Both
designs were tried and both lose to plain scalar Wasm. The per-run 8-wide
probe (0.0373) is the *slowest* Wasm lane and is slower than node. The
whole-buffer bitmap prepass (0.0276) does beat node 1.25x, but it loses to
the plain scalar linear-memory lane (0.0221) and loses badly to plain
scalar WasmGC (0.0148). The reason is not that the vector work is
expensive — the SIMD classification of the entire buffer costs **0.0015 ms
(~5 GB/s), 24x less than node's whole tokenize**, and it is 19x cheaper
than the same classification done scalar (0.0576 − 0.0281 ≈ 0.030 →
0.0015). The cost is *consuming* the result: this grammar averages **~2.2
chars per token**, so replacing a 2-iteration character loop with a word
load + shift + `ctz` per run is a net loss. Vectorizing a scan only pays
when the runs are long; a JS/TS tokenizer's runs are not. **Do not build a
SIMD idiom recognizer for this.**

**2. The much bigger finding: WasmGC is not the handicap — it is the
fastest lane.** Hand-written WasmGC reading `array.get_u` off a
`struct.get`'d `$__str_data` (exactly the representation we emit) runs at
**0.0148 ms, 2.3x FASTER than node**, and beats hand-written *linear
memory* (0.0221) by 1.5x — V8 hoists the GC array's bounds check against a
known `array.len` better than it can the linear-memory bound plus `shl`
addressing. Even the deliberately-pessimised linear-memory OO control
(Lexer state in memory, a real call per token, no local promotion) still
beats node 1.21x. So "outperform node-acorn" is **not** blocked by AOT, by
WasmGC, or by our string representation. The entire 2.9x deficit is our
*lowering*.

**3. The `charCodeAt` f64 round trip is priced: 2.7x, single-handedly.**
The only difference between the 0.0148 lane and the 0.0403 lane is that
every character read goes `array.get_u → f64.convert_i32_u →
i32.trunc_sat_f64_s` instead of staying i32. The identity-call control
isolates it cleanly: same call shape, identity body, **0.0149** — so the
call is free and the whole 0.0255 ms delta is the conversion pair. That
one representation bug moves us from **2.34x faster than node** to **1.16x
slower**. Round 32 identified it; round 33 failed to fix it with a
peephole because the pair is never adjacent. This round says it is worth
**2.7x on the tokenizer**, which justifies the real fix (result-type
contract or a local-aware dataflow pass, per round 33's two notes) over
another cheap attempt.

**4. What is left after that.** Our compiler emits 0.1007 for the same
source, still 2.5x above the f64-round-trip lane (0.0403). That residual
is everything the hand-written lane does *not* pay: `this.pos` /
`this.tokKind` field traffic, `src.length` re-read per iteration, the
per-token `next()` dispatch, `isDigit`/`isIdent` not inlined, and the
per-parse `new Lexer`. That bucket is exactly the typed-`this` /
direct-call / value-rep program already in flight (#3683 and friends) —
this round just confirms it is the *second* lever, not the first.

**Revised ladder for the goal** (all measured, no extrapolation):

| | ratio vs node |
| --- | --- |
| compiled acorn today | 31x |
| our compiler on hand-typed source (round 32) | 2.9x slower |
| the same, if the `charCodeAt` f64 round trip is removed | ~1.16x slower |
| the same, plus typed-`this` / direct-call / no boxing | **2.3x FASTER** (the hand-written WasmGC lane) |
| best SIMD design measured | 1.25x faster — *worse than plain scalar WasmGC* |

No compiler change landed this round: the experiment's own result says the
change it was scoped to justify (a SIMD lowering) is not worth making.

### Round 36 — corrections, and the opcode census that reprices everything

Two measured corrections to earlier rounds, both from the IR-narrowing
investigation, both of which supersede numbers published above.

**(a) The 2.7x round-trip price was MIS-SCALED (my error).** The
hand-assembled control measured the `i32→f64→i32` round trip in code
where it was the ONLY work. In our actual hot function it is 10 ops out
of ~180. Worse, round 32's headline "29 truncations / 41 array reads"
is a WHOLE-MODULE count — 22 of those 29 live in an unrelated 2,148-line
f64→string runtime helper; in the hot loop it is 5 and 5. Scaling the
control properly (~7.5k char reads/run, 0.0267 ms delta ⇒ ~3.6 ns/read)
prices the round trip at **~0.027 ms of our 0.100 ms — about 27 %, not
2.7x.** Fixing it should land the tokenizer near **0.073 ms (~2.2x
node)**, not near the 0.015 ms hand-written ceiling.

**(b) Partial narrowing is a 2.7x PESSIMIZATION.** Rewriting the
tokenizer so the EXISTING `| 0` analysis makes char locals genuinely i32
(no compiler change) measured, same harness, identical checksums:

| lane | ms |
| --- | --- |
| node | 0.0328 |
| hand WasmGC (i32) | 0.0150 |
| hand WasmGC (+ f64 round trip) | 0.0405 |
| ours, baseline | 0.1002 |
| ours, i32 char locals only | **0.1874** |
| ours, + i32 cursor local | **0.2717** |

Narrowing locals inside an otherwise-f64 world means every narrowed value
is immediately re-widened (the fields are f64, `isDigit`'s param is f64)
and each `| 0` adds a NaN check plus a `trunc_sat` on top. **This is the
third independent confirmation of the whole-chain law** (after S4a's f64
fields gaining ~1 % and round 33's peephole): typing is whole-chain or
NEGATIVE. Treat it as a law of this codebase — any future slice that
types one link must type the whole chain or measurably lose.

**The census that matters more than either.** Opcodes in the hot
`Lexer_next` of our -O3 standalone module:
### Round 34 — the `i32` annotation was INERT, and reviving it is the fix

Round 33 recommended a local-aware dataflow pass in the IR. Before writing
one, two questions were answered empirically. Both answers redirected the
work.

**(a) The hot shapes do not route through the IR at all.** Compiling the
round-32 tokenizer with `trackIrOutcomes`: `Lexer_next` (every charCodeAt
round trip), `bench` and `<module-init>` are all `body-shape-rejected`;
only `Lexer_new` / `isDigit` / `isIdent` are IR-emitted. Isolating the
cause with one-variable probes: `add(a: number, b: number)` → **IR**;
`add(a: i32, b: i32)` → `type-resolution-unsupported`; a `number`-typed
body containing one `const t: i32` → `body-shape-rejected`; the alias
merely *declared* but unused → **IR**. Every function that *uses* an
`i32` annotation is knocked off the IR path, so an IR pass could not have
touched this benchmark.

**(b) Outside `fast` mode the `i32` annotation did nothing at all.**
`resolveNativeTypeAnnotation` detected the annotation via
`tsType.aliasSymbol?.name`, but TypeScript populates `aliasSymbol` only
for aliases of OBJECT and UNION types — never for an alias of an
intrinsic primitive. On TS 5.9.3: `type i32 = number` → `aliasSymbol =
(none)`, while `type Pair = {a: number}` → `Pair` and `type Uni = number
| string` → `Uni`. Instrumenting a live compile of the tokenizer:
**84 calls, 0 hits, no alias name ever observed.** The emitted code
agreed — `let n: i32; let i: i32; const c: i32` gave
`locals=[f64,f64,f64,…]` in gc/standalone/wasi and `[i32,…]` only under
`fast`, where *every* `number` is i32 regardless of annotation. The
inertness was **accidental, not a semantic gate**: `resolveWasmType`
consults the native map before any `ctx.fast` branch, so there was no
fast-gate to remove.

Consequence: round 32's row "same, with native `i32` fields/locals"
(0.1684 vs 0.1792) is mislabeled — the annotations were inert, so that
row did not measure typed fields/locals. Round 32's headline "29
truncations against 41 array reads" is likewise a **whole-module** count:
22 of the 29 truncs live in an unrelated 2148-line f64→string runtime
helper. In `Lexer_next` itself it is 5 truncs / 5 converts / 5 array
reads.

**Partial narrowing is a PESSIMIZATION — the third independent
confirmation of "whole-chain or negative".** Priced without touching the
compiler, by rewriting the tokenizer in `| 0` forms the existing
`collectI32CoercedLocals` analysis already accepts (so the locals really
do become i32). Interleaved, checksums identical:

| lane | ms |
| --- | --- |
| wasmGC hand-written (i32 char reads) | 0.0150 |
| node (JS, V8) | 0.0328 |
| wasmGC hand-written (+ f64 round trip) | 0.0405 |
| ours, baseline | 0.1002 |
| ours, `\|0` char locals only | 0.1874 |
| ours, + `\|0` cursor local | 0.2717 |

Narrowing locals inside an otherwise-f64 world re-widens at every field
write and every call, and each `|0` adds its own NaN-check + `trunc_sat`.
Same lesson as round 31's hot-chain experiment and #3683 S4a.

**The fix: resolve the annotation syntactically, from the declaration's
TYPE NODE, and do it whole-chain.** New `src/codegen/native-type-annotations.ts`
resolves an explicit `TypeReference` whose name binds to a user-declared
`= number` alias (generic aliases, lib declarations and same-named
non-`number` types are rejected, so a user type called `i32` cannot be
hijacked). Wired at every declaration site together: local variables,
class property declarations (including the constructor-assignment path,
which mints the slot *before* the property loop runs), constructor and
method and setter parameters, method/getter/function return types. In
`binary-ops.ts` the operand check is node-resolved too, with int32
literals and string/array `.length` reads admitted as *non-anchor*
compatible operands — at least one operand must carry a real annotation,
so unannotated code keeps its existing lowering.

Also fixed, in the IR: `this.pos = 0` on an `i32`-annotated field threw
`ir/from-ast: assignment to C.p (i32) got f64`, which the #2138 IR-first
gate promotes to a hard compile error (this already broke `fast` mode on
`main`). `coerceIrNumeric` now inserts exactly the conversion legacy
`coerceType` inserts at the same seam; the uint32 domain (`signed:
false`) bails rather than widening through the signed conversion, so
`-1 >>> 0` is untouched.

**Measured, all lanes interleaved in one process, 5 rounds of
min-of-14×50, checksums identical (83717):**

| lane | min | median | max | vs node |
| --- | --- | --- | --- | --- |
| node (JS, V8) | 0.0327 | 0.0343 | 0.0348 | — |
| wasmGC hand-written (i32) | 0.0151 | 0.0153 | 0.0160 | 2.17x faster |
| wasmGC hand-written (+ f64 round trip) | 0.0400 | 0.0413 | 0.0425 | 1.22x slower |
| ours BEFORE | 0.1002 | 0.1043 | 0.1046 | 3.05x slower |
| **ours AFTER** | **0.0796** | **0.0815** | **0.0849** | **2.44x slower** |

**−22 %**, 3.05x → 2.44x. Opcode census of `Lexer_next` (-O3 standalone):
truncs 5→2, `f64.add` 6→2, `f64.lt` 3→0, `f64.ge` 3→2, `i32.lt_s` 5→8,
`i32.ge_s` 5→6; the `Lexer` struct is now
`(field $pos (mut i32))` ×5 instead of `(mut f64)`.

This lands within the honest ceiling for this change: the hand-written
control prices the round trip at ~3.6 ns per char read, i.e. ~0.027 ms of
our 0.100 ms — **~27 %, not the 2.7x the control shows in isolation**,
because in our loop the round trip is 10 ops out of ~180.

**The bigger lever, measured and handed on.** Opcode census of the SAME
hot function:

```
throw 54 · ref.is_null 35 · extern.convert_any 73 · any.convert_extern 19
ref.cast 38 · ref.test 19 · struct.get 57 · struct.set 16 · call 7
array.get_u 5 · i32.trunc_sat_f64_s 5 · f64.convert_i32_u 5 · f64.add 6
```

**54 throws and 35 null checks in one tokenizer function.** The dominant
cost is not the round trip and not dispatch — it is null-check-and-throw
scaffolding on every `this.` access plus extern/any conversion churn
(73 + 19 + 38 + 19 = 149 conversion/cast ops against 5 actual character
reads). That is the next big lever, and it is the other half of #1947
("non-null params under strictNullChecks; every typed param is
`(ref null $T)` with per-access null-check-throw blocks").
## Linear memory vs WasmGC (measured)

Every round so far ran on the WasmGC lane (`src/codegen/`). This round
answers the standing question from `docs/architecture/codegen-axes.md`:
would the **linear-memory** backend (`src/codegen-linear/`, `target:
"linear"`) be faster for parser-shaped work? The two backends are
deliberate alternatives, so the answer bears on #3673 and on the
per-backend value-representation work (#1584 / #1852).

Scripts: `.tmp/linear-vs-gc-bench.mjs` (head-to-head),
`.tmp/linear-capability-probe.mjs`, `.tmp/linear-string-boundary.mjs`,
`.tmp/linear-charcodeat-matrix.mjs`, `.tmp/linear-w3-diag.mjs`,
`.tmp/linear-dataseg-overflow.mjs`, `.tmp/linear-arena-limit.mjs`,
`.tmp/linear-arena-reset.mjs`, `.tmp/wat-opcount.mjs`.

### Capability boundary — the parser shootout does NOT compile on linear

The existing repros (`.tmp/parser-shootout.mjs`,
`.tmp/tokenize-only.mjs`) are built on a `class Lexer { src: string; … }`
that does `this.src.charCodeAt(this.pos)`. **That shape cannot compile on
the linear backend at all**, and the reason is structural, not a missing
arm:

- `generateLinearModule` (`src/codegen-linear/index.ts:208-251`) runs the
  linear-IR overlay **only over top-level `FunctionDeclaration`s**. Class
  constructors and methods always take the direct AST→linear path.
- The **direct** linear path has no `charCodeAt` arm at all (stated
  outright at `src/codegen-linear/runtime.ts:2145-2147`). So any
  `charCodeAt` that lands on it is a hard `Codegen error: Unsupported
  method call: .charCodeAt()`.
- Consequently `charCodeAt` works **only** inside a top-level function
  that the overlay actually claims. A method, a module-level `const`
  receiver, and even `const t = this.src; t.charCodeAt(0)` all fail.

The second, sharper wall is `string.length`. Linear strings are **UTF-8
bytes** while `.length` is a **UTF-16 code-unit count**, so the overlay
demands an ASCII proof. Instrumenting the overlay's rejection list gives
the exact reason:

```
{ "func": "f", "reason": "build",
  "detail": "ir/linear-string: ASCII encoding proof required for length input (got unproven)" }
```

A `string` **parameter** carries no such proof, so `f(s: string)` with
both `s.length` and `s.charCodeAt(i)` demotes out of the overlay and then
dies on the direct path's missing `charCodeAt`. Only a **string literal
bound to a local** is proven ASCII. Measured matrix:

| shape | linear |
| --- | --- |
| `const s = "…"` local; `s.length` + `s.charCodeAt(i)` | works |
| `f(s: string)`; `s.length` + `s.charCodeAt(i)` | CE (ASCII proof) |
| `f(s: string, n: number)`; loop bound `n`, `s.charCodeAt(i)` | works |
| module-level `const S = "…"`; `S.charCodeAt(0)` | CE |
| `this.src.charCodeAt(i)` in a method | CE |
| `const t = this.src; t.charCodeAt(0)` | CE |
| `s[i]` string index | CE (`Unsupported element access`) |
| `this.inner.method()` / `xs[0].method()` | CE (`Unsupported method call`) |
| `type i32 = number` native alias | **emits INVALID wasm** (validation failure, no diagnostic) |
| module-level `const S = "hello world"; S.length` | **returns 0** (silently wrong; GC returns 11) |

Everything else a parser needs *does* work: classes with number fields,
nullable self-referential class refs (`left: Node \| null`), `new` in a
loop, arrays of objects, class instances as parameters, mutable module
globals, recursion, `number[]` params. So the comparison holds — it just
has to be **restructured**, not run as-is:

- source text as a **proven-ASCII local literal**;
- **tokenize and parse in separate modules** (a module that both scans a
  string and runs recursive descent demotes: `parsePrimary
  select:class-projection-unsupported`, `parseMul`/`parseAdd`
  `select:body-shape-rejected`, `checksum`
  `select:param-type-not-resolvable`, and once that happens `bench`'s
  `charCodeAt` becomes a hard CE).

### Two soundness bugs found while sizing the workload

Both are silent-wrong-answer bugs in the linear backend, worth their own
issues:

1. **String literals over ~960 bytes are silently corrupted.**
   `DATA_SEGMENT_BASE = 64` (`src/codegen-linear/index.ts:36`) and the
   bump allocator's `__heap_ptr` starts at `HEAP_START = 1024`
   (`src/codegen-linear/runtime.ts:12`). Nothing checks that the literal
   data fits the 960-byte window between them, so a longer literal spills
   past `HEAP_START` and the arena's first allocation overwrites it.
   Measured (`.tmp/linear-dataseg-overflow.mjs`): 960 chars clean, **980
   chars → `.length` reports 979 and 17 characters read wrong**, 2048
   chars → 939 wrong, 4096 chars → OOB trap. No diagnostic at any size.
   This is what first showed up as a checksum mismatch in the tokenizer
   (linear 29675 vs node/gc 28117 on a 2397-char input). Workaround: any
   `<number>.toString()` in the source flips number-format mode
   (`number-format.ts:74-80`), moving literals to 16384 and `heapStart`
   to 65536 — verified clean to 2048 chars.
2. **`type i32 = number` produces invalid wasm on linear.** The native
   type-alias annotation that the GC lane uses for i32 locals makes the
   linear backend emit a module that fails `WebAssembly.compile()`
   (`local.set`/`f64.add` type mismatches). It should either be supported
   or rejected with a diagnostic; today it is a silent miscompile.

### The head-to-head

Largest workload both backends accept, three lanes in one process,
rotating order, deep warm, min-of-batches over 15–21 rounds, checksums
asserted identical (`.tmp/linear-vs-gc-bench.mjs`). Input 909 chars / 431
tokens — deliberately under the 960-byte corruption cliff.

- **W1 scalar** — 200 iterations of a 200-step integer PRNG. No memory
  traffic; isolates arithmetic.
- **W2 tokenize** — the full tokenizer over the literal, no allocation.
- **W3 parse+AST** — recursive descent over pre-built `number[]` token
  arrays, allocating a `Node` per production, then a recursive checksum.
  Token arrays are hoisted out of the rep loop on purpose: leaving them
  inside compares array-literal construction instead (the linear lane
  emits **862 per-element push calls** where GC emits 3 `array.new`s,
  which swamped the allocation signal and made the two lanes look tied).

`optimize: 3`, ms per iteration:

| workload | node | GC (min / med) | linear (min / med) | linear ÷ GC | GC ÷ node |
| --- | --- | --- | --- | --- | --- |
| W1 scalar | 0.0015 | 0.0112 / 0.0118 | 0.0113 / 0.0118 | **1.00x** | 7.7x |
| W2 tokenize | 0.0024 | 0.0072 / 0.0077 | 1.3329 / 1.3630 | **184x slower** | 3.0x |
| W3 parse+AST | 0.0015 | 0.0061 / 0.0075 | 0.0010 / 0.0011 | **0.17x (linear 5.9x faster)** | 4.1x |

Reproduced across four independent invocations; W1 ranged 0.98–1.02x, W2
183–212x, W3 0.13–0.17x. Per-lane spread (max÷min within a run) was
1.03–1.2x except the GC lane on W3, which is bimodal (up to **21–56x
spread**, tail 0.0854 ms) — GC pauses. The linear lane's W3 spread is
1.6–1.8x. Unoptimized (`OPT=0`) gives the same three verdicts.

Size and compile time (`-O3` / no-opt):

| workload | GC bytes | linear bytes | GC compile | linear compile |
| --- | --- | --- | --- | --- |
| W1 | 21,134 / 47,189 | **322** / 5,297 | 2.2 s / 0.9 s | 0.69 s / 0.04 s |
| W2 | 23,527 / 51,725 | 2,139 / 7,567 | 1.5 s / 0.29 s | 0.77 s / 0.06 s |
| W3 | 48,399 / 99,555 | 12,651 / 17,203 | 2.3 s / 0.74 s | 0.73 s / 0.12 s |

Linear binaries are **4–65x smaller** and compile **3–20x faster**. Most
of the GC lane's bytes are the standalone string/number runtime it always
links.

### Mechanism (from `npx wasm-dis`, op counts via `.tmp/wat-opcount.mjs`)

**W1 — why both lanes lose to node identically.** Both backends carry
every `number` as **f64** and emulate `|0` with an
`f64.trunc` → `i32.trunc_sat_f64_u` → `f64.convert_i32_s` round trip plus
an `f64.floor`/`f64.mul` modulo dance. The linear W1 body is *literally*
f64 arithmetic with no i32 anywhere. So the 7.8x floor is the **value
representation** (#1584 / #1852), identical in both backends, and
**not** a memory-model question. Choosing linear buys nothing here.

**W2 — why linear is 184x slower.** This is a representation difference,
not a memory-model one:

- GC's `charCodeAt` helper is **O(1)**: bounds check, then
  `array.get_u` on an `i16` array via `struct.get` of
  {length, offset, data} — 39 lines, `array.get_u ×1`, `struct.get ×3`,
  **no loop**.
- Linear's `__linear_ir_str_char_code_at` is **O(i)**: 297 lines
  containing a `loop` that walks UTF-8 bytes **from byte 0**, decoding
  1-/2-/3-/4-byte sequences and incrementing a UTF-16 unit counter until
  it reaches the requested index (`i32.load8_u ×7`, `i32.load ×8`,
  `loop ×1`). Source at `src/codegen-linear/runtime.ts:2342+`.

A tokenizer calling `charCodeAt(pos)` across a length-N string is
therefore **O(N²)** on linear. At N=909 that is ~413k byte loads per pass
instead of 909 — right order of magnitude for the measured 184–212x.
`wasm-opt -O3` cannot fix it; it is algorithmic. Linear also **re-copies
the 909-byte literal from the data segment into a fresh arena block byte
by byte on every `bench()` call** (an inlined `__str_from_data` loop plus
a `memory.grow` check), which the GC lane does once via `array.new` +
`struct.new`.

**W3 — why linear is 5.9x faster.** Not because bump allocation beats
`struct.new`; those are ~1:1. It is WasmGC's **per-access downcast tax on
nullable class references**:

| function | GC lane | linear lane |
| --- | --- | --- |
| `parsePrimary` | 1414 lines: `struct.get ×40`, **`ref.cast ×38`**, **`ref.test ×45`**, `ref.is_null ×16`, `struct.new ×1` | 190 lines: `i32.store ×4`, `f64.load ×9`, no casts |
| `checksum` | 247 lines: `struct.get ×8`, **`ref.cast ×8`**, `ref.test ×4`, `ref.is_null ×5` | 41 lines: `i32.load ×2`, `f64.load ×2` |

Every read of a `Node | null`-typed field on the GC lane re-narrows the
reference — ~4 `ref.cast`/`ref.test` pairs per source-level field access —
because the nullable union is carried as a supertype ref. The linear lane
holds a raw i32 pointer and reads at a static offset: no cast is possible
and none is needed. **This is a type-lowering problem, not a GC problem**,
and it is the same family as the value-representation work in #1584 /
#1852.

Note the linear lane pays its *own* representation tax in the same
function: `st.i` lives as an **f64** field, so every array index does
`f64.load` → `i32.trunc_f64_s`, and every `&&` becomes an
`f64.gt (f64.abs …) (f64.const 0)` truthiness dance. It still wins by 5.9x
— which sizes how expensive the GC downcasts are.

### What the arena costs

The linear backend's allocator is a **bump arena that never reclaims**,
and `mod.memories.push({ min: 1, max: 256 })`
(`src/codegen-linear/runtime.ts:64`) caps memory at **16 MiB**. `__malloc`
deliberately does not branch on `memory.grow` returning −1
(`runtime.ts:101-102`). Measured with a 1023-node tree built repeatedly
(`.tmp/linear-arena-limit.mjs`):

| lane | allocations survived | outcome |
| --- | --- | --- |
| linear, default `allocator: "bump"` | 409,200 | **TRAPS** — `memory access out of bounds` at 16 MiB |
| linear, `allocator: "arena-reset"` + `__arena_reset()` per parse | 30,690,000 | no trap, 489 ms |
| WasmGC (standalone) | 20,460,000 | no trap, 308 ms |

So a linear-lane parser has a **hard ~409k-object lifetime ceiling** out
of the box. `allocator: "arena-reset"` removes it and is the right mode
for a parse-then-discard workload (one reset per parse), but it levels the
allocation advantage: ~15.9 ns/node-allocate-and-traverse for
linear+reset vs ~15.1 ns for GC on that shape. The 5.9x W3 win is real but
holds only while the arena stays **warm and unreset**; reset costs the
cache warmth, not the pointer bump.

### Recommendation

**Do not move the acorn work to the linear backend. Do harvest two
findings from it.**

1. **It cannot compile the workload.** Real acorn is classes holding a
   `string` input and calling `this.input.charCodeAt(this.pos)` — the
   single shape most comprehensively unsupported on linear (methods are
   outside the IR overlay; the direct path has no `charCodeAt`; a string
   parameter has no ASCII proof; module-level string consts are wrong or
   rejected). Getting there is not a small gap: it needs class methods in
   the linear-IR overlay, an ASCII/encoding proof that survives parameter
   passing, and a UTF-16-indexable string representation. That is a
   backend programme, not a #3673 round.
2. **Even if it compiled, the string half would be catastrophically
   slower** — 184x, structurally, because UTF-8 storage makes
   `charCodeAt` O(i). Since #3673 round 31 already measured the character
   scan as the GC lane's weak point (tokenize-only 3.06x vs full-parse
   1.59x), moving to a backend whose scan is two orders of magnitude
   worse is exactly the wrong direction.
3. **The W3 result is the valuable part, and it is portable.** Linear
   beats GC 5.9x on parse+AST purely by not emitting `ref.cast`/`ref.test`
   on every nullable-class-ref field read. That is a **WasmGC
   type-lowering** issue the GC lane can fix on its own: narrow
   `Node | null` once per binding instead of re-testing at each use, or
   carry a non-null ref plus a separate null flag. On the measured op
   counts (38 casts + 45 tests in one 1400-line function) this is
   plausibly the largest single remaining win for the AST-building half
   of an acorn parse — worth a dedicated issue under #1584 / #1852.
4. **The W1 floor says the 7.8x arithmetic gap is backend-independent.**
   Both lanes emit identical f64-with-truncation code. Value
   representation is the shared bottleneck; no backend choice avoids it.

Where the linear lane *is* clearly better and worth keeping in mind:
binary size (4–65x smaller), compile time (3–20x faster), and predictable
latency (no GC pause tail — the GC lane's W3 spread hit 21–56x). Those
matter for the WASI/standalone target, not for beating node-acorn.

### One compiler-source change (diagnostic only)

`src/ir/backend/linear-integration.ts` gained a four-line
`JS2WASM_LINEAR_IR_DEBUG=1` dump of the overlay's `compiled` / `rejected`
lists. There was no other way to see *why* a function demotes out of the
linear-IR overlay — the rejection reasons are computed and then dropped,
and the user-visible symptom is an unrelated `Unsupported method call:
.charCodeAt()` from the direct path. It is inert unless the env var is
set. Gates: `npx tsc --noEmit` clean; the full `linear-*` suite plus
`issue-2045/3497/3500/3520` linear tests pass (140 tests). The file is
reachable only via `target: "linear"`, so the GC/standalone paths are
untouched.

### Round 37 — two soundness bugs in the linear backend (filed from the comparison)

The linear-vs-GC measurement surfaced two correctness defects that are
independent of the performance question and should not be lost:

1. **String literals over ~960 bytes silently CORRUPT on the linear
   backend.** `DATA_SEGMENT_BASE = 64` versus `HEAP_START = 1024` with no
   bound check: at 980 chars `.length` reports 979 and 17 characters read
   wrong; at 4096 it traps. This surfaced as a checksum mismatch during
   benchmarking — i.e. it is silent data corruption, not a crash.
2. **`type i32 = number` emits INVALID wasm on the linear backend.**

Also worth recording as capability boundaries (not bugs): the linear
lane runs its IR overlay only over top-level function declarations, so
class methods take the direct path which has no `charCodeAt` arm at all;
`s[i]`, `this.inner.method()` and module-level string constants are
unsupported (a module-level `S.length` silently returns **0**); and the
default `allocator: "bump"` never reclaims and traps after 409,200
allocations at the 16 MiB cap (`allocator: "arena-reset"` fixes it and
levels the allocation advantage — ~15.9 vs GC's ~15.1 ns/node).

Filed here rather than as separate issues because they are all discovered
in one pass and all live in the same subsystem; whoever picks up the
linear lane should triage them together.

### Hybrid study — verdict: **don't build it** (#3687)

Asked whether a WasmGC/linear **hybrid** ("linear for character data, GC
for AST nodes") would give best-of-both. Measured answer: no — and two of
the three rows above do not survive the check. Full write-up in
[#3687](3687-wasmgc-linear-hybrid-study.md).

1. **The W3 "linear 5.9x faster" row is retracted.** The input contains
   `fn0(x0, …)` call syntax the toy grammar cannot parse, so `parseAdd`
   returns at the first `(` after `fn0`: **11 of 431 tokens parsed, 11
   nodes allocated per "parse"** (`.tmp/w3-sanity.mjs`). With the call
   syntax removed so the grammar consumes the whole stream, linear's win
   is **1.5x, not 5.9x**, flat across a 16x size sweep (63→1023 nodes;
   node ~18-23, linear ~62-72, GC ~101-110 ns/node).
2. **Even the 1.5x is not a memory-model property.** Same corrected
   workload, same algorithm and allocation count, changing only which
   construct carries parser state: class cursor + class Node → linear
   0.66x; `number[]` cursor + class Node → **1.06x (GC faster)**;
   `number[]` cursor + array arena → **3.35x (GC faster)**. Linear is good
   at class field access and bad at array element access; GC is the
   reverse. Both are lowering quality, fixable in place. There is no
   stable advantage for a hybrid to allocate work across.
3. **"Linear is bad at strings" is a BUG, not a fact** — correcting
   recommendation #2 above on the word *structurally*. Swap the string for
   a `number[]` of char codes (O(1) indexed on both backends, same
   tokenizer) and linear goes from **503x** slower to **1.17x** slower. It
   is `__linear_ir_str_char_code_at`'s decode-from-byte-0, nothing else.
   Fixing it makes linear competitive on scans, not superior.
4. **The narrow hybrid (source buffer in linear memory) is measurably
   negative.** It swaps `array.get_u` for `i32.load8_u`; round 35's
   hand-written lanes say GC wins that read 1.49x, and our own compiler
   says 1.16x. It also needs no ownership protocol and still loses.
5. **The scaffolding (#3686) is priced, and the op counts overstate it.**
   A hand-written WasmGC control carrying the *complete* cast/null/extern
   scaffolding costs **+10-16 %** on build+walk and **+23-29 %** on a pure
   walk (0.45-0.53 ns/read) — not a multiple; `extern.convert_any` is a V8
   no-op. #3686 is still worth doing, but its "evidence 2" (the 5.9x) is
   void, and the GC lane's real 5x is the **generic `===` ladder** on
   laundered values: `tk[i] === 40` with both operands statically `number`
   emits 4 `__box_number`, 4 unboxes, an object→string conversion and a
   string comparison per token. That is #3685 / #1584 / #1852 territory.
6. **Blocker found for #3686**: `class Node { left: Node }` — a
   non-nullable field of the class's own type, i.e. exactly the AST shape
   #3686 wants — makes codegen recurse until stack overflow
   (`objectIrTypeFromTsType` ↔ `tsTypeToFieldIr`, `src/codegen/index.ts`
   1081/1099, no cycle guard). The nullable spelling only works because a
   union misses the `Object` flag and bails to legacy.
7. The >960-byte data-segment corruption (round 37) **reproduced at 3127
   chars**: linear returns checksum 106161 where node and GC both return
   101058. Silent, no diagnostic, inside a benchmark.

### Round 38 — the hybrid study refutes both hypotheses (see #3687)

The hybrid question is answered **don't build it** — but NOT for the
reason I proposed. I hypothesised that #3686 would dissolve linear's
advantage; the agent priced the whole cast/null/extern scaffolding with a
hand-written WasmGC control and found it worth **+10-16 % on build+walk
and +23-29 % on a pure walk** (0.45-0.53 ns/read) — a percentage, not a
multiple, and not enough to cross linear's number on its own.
(`extern.convert_any` is a V8 no-op.) My hypothesis was wrong and is
recorded as wrong.

The case collapses for a **stronger** reason: **there is no stable
backend advantage to hybridise.** The sign flips under a one-word change
— same algorithm, same allocation count, two independent runs:

| parser state carried by | linear ÷ GC |
| --- | --- |
| `class St` cursor + `class Node` | 0.66x / 0.68x — linear faster |
| `number[]` cursor + `class Node` | 1.06x / 1.24x — **GC faster** |
| `number[]` cursor + array arena | 3.35x / 3.53x — **GC faster** |

Linear is good at class-field access and bad at array-element access; GC
is the reverse. Neither is a property of the memory model, so there is
nothing durable to split along.

Three further corrections to the record:

- **"Linear is bad at strings" is a BUG, not a fact.** Swapping the
  string for a `number[]` of codes — O(1) on both backends, same
  tokenizer — takes linear from **503x** slower to **1.17x** slower.
  Fixing `charCodeAt` makes linear COMPETITIVE, not superior.
- **The narrow hybrid is priced NEGATIVE.** Keeping only the immutable
  source buffer in linear memory — the version needing no ownership
  protocol — *loses* the very read it exists to win: 1.49x (hand-written)
  / 1.16x (our compiler). Only byte density could rescue it, and that
  needs a cache-bound measurement nobody has done.
- **The GC lane's real 5x is not the scaffolding — it is the generic
  `===` ladder.** `tk[i] === 40` with BOTH operands statically `number`
  emits 4 `__box_number`, 4 unboxes, **an object→string conversion and a
  string comparison per token**. That is #3685/#1584/#1852 territory and
  is a bigger prize than #3686.

**Blocker discovered for #3686:** `class Node { left: Node }` — a
non-nullable field of the class's own type, exactly the AST shape #3686
targets — makes codegen recurse until stack overflow
(`objectIrTypeFromTsType` ↔ `tsTypeToFieldIr`, `src/codegen/index.ts`
~1081/~1099, no cycle guard). Nullable/optional variants only work
because a union misses the `Object` flag and bails to the legacy path.
**#3686's end state is not expressible in source today** — the cycle
guard is a prerequisite, not an optimisation.

Also: the round-37 data-segment corruption reproduced at **3127 chars**
(linear returns 106161 where node and GC return 101058 — silently,
inside a benchmark).
Null-check-and-throw scaffolding on every `this.` access plus extern/any
conversion churn dominate, by a wide margin, the conversions this round
removed. That is the next lever (it connects to #1947's non-null-params
half).

Verification: `tsc` clean; prettier + biome clean; full `tests/equivalence`
(463 suites / 1646 tests) diffed BY TEST NAME against the merge parent —
**33 failures on both, 0 new, 0 fixed**; pins `issue-1817` / `issue-1818` /
`issue-869` / `issue-956-957` / `native-i32-type` — identical 12-failure
set on both (all pre-existing, including the 3 `>>>` ones and a
`string_constants`-import harness bug in `native-i32-type`);
`issue-3673-i31-smallint`, `issue-3673-fast-tokenizer`,
`issue-3683-typed-this-twin`, `issue-3683-numeric-fields`,
`issue-3685-receiver-flow`, `issue-1712`, `issue-1712-tokenizer-identity`
all green; `DOGFOOD_ACORN=1 dogfood:acorn-corpus` → 0 real gaps, 21/21 OK;
standalone acorn canaries smoke=4, **imports ZERO**. Strongest safety
evidence: compiled acorn (which carries no `i32` annotations) is
**byte-identical** — sha256 `0e7e2ae1…` on both the merge parent and this
branch, 1,215,689 bytes.

Not done, and why: full IR *eligibility* for `i32`-annotated signatures
needs an `i32` scalar in the selector's `ResolvedKind` vocabulary
(`resolveParamType` maps a `TypeReference` to `"object"` today) threaded
through `resolvePositionType`, `from-ast` and `lower` — its own slice.
The `fast`-mode tokenizer still fails to compile, but strictly less than
before: 3 IR errors on the merge parent, 2 now, and both survivors
(`class-method typeIdx parity mismatch` on `isDigit`/`isIdent`) reproduce
unchanged on the merge parent.

### Round 40 — the typed-parser gap after the i32 and `===` fixes

Round 32 measured a hand-typed recursive-descent parser at **1.59x**
node. That number predated two fixes that both apply directly to it: the
`type i32 = number` annotation being inert (round 39) and the
static-number `===` ladder (#3688). Re-measured on the merged tree, same
harness, same input:

| variant | ms/parse | throughput | vs node | was (round 32) |
| --- | --- | --- | --- | --- |
| plain `number` fields | 0.1556 | 46.1 MB/s | **1.45x** | 1.69x |
| **native `i32` fields** | **0.1276** | **56.2 MB/s** | **1.20x** | 1.59x (inert — see round 39) |
| node (same JS) | 0.1062-0.1070 | 67.0 MB/s | 1x | — |

**1.59x → 1.20x**, and the `i32` row is now measuring what its label
says for the first time.

**Checksum note (this is a correctness observation, not a discrepancy):**
the i32 variant answers `-2015914222` where node answers `2279053074`.
That is exact i32 wraparound — `2279053074 | 0 === -2015914222`, verified
— of the benchmark's own final `nodes * 1000000 + sumTree(root)`
arithmetic, NOT a difference in parsing. Wrapping is precisely the
contract `type i32 = number` opts into (#323: "a performance escape hatch
for developers who know their value ranges"), so this is the annotation
working as documented. The parse work is identical; only the summary
arithmetic overflows i32.

**Where the last 1.20x sits.** Not in the character loop and not in
allocation — both were addressed. The census points at the remaining
item: null-check/throw scaffolding on every `this.` access plus
extern/any churn (#3686), which is blocked behind a codegen cycle-guard
bug (`class Node { left: Node }` recurses to stack overflow). That is the
next lever, and it is the only measured one left between here and parity
on well-typed input.

## What "surpass node-acorn" actually requires (measured decomposition)

Session cumulative: **52.4 → ~1.92ms/parse (~27x)**; warm node-acorn on
the same input is **0.0341ms** (measured; the earlier 0.06 estimate was
generous) — the remaining gap is **~56x**. Two more null results recorded
honestly: aggressive Binaryen inlining
(`--flexible-inline-max-function-size=500
--one-caller-inline-max-function-size=1000`) is wall-flat (1.92ms — V8's
wasm tiering already absorbs the call overhead), and cold single-parse
also loses (wasm compile of the 1.27MB module ~75ms vs ~23ms for V8
parsing+evaluating acorn.mjs and one interpreter-tier parse).

Time split of the round-10 profile (excluding harness noise): **runtime
helpers ≈58%, user-closure code ≈38%, GC ≈5%**. Zeroing every remaining
runtime helper — the asymptote of the inline-cache/fast-path program this
branch has been executing — lands around **0.8ms, still ~23x off**. The
user-closure share is the compiled parser itself: every field read is a
dispatcher CALL returning a boxed value, every arithmetic op round-trips
through externref boxing, every method call crosses the closure-call
bridge. node-acorn's equivalents are single machine loads under inline
caches.

Surpassing node-acorn is therefore a CODEGEN-ARCHITECTURE goal, not a
runtime-tuning goal. The concrete path (maps to existing goals):

1. **Typed `this` monomorphization for fnctor prototype methods**
   (#1946/#1947 class of work): when every callee of
   `Parser.prototype.readToken` is provably a `$__fnctor_Parser`
   receiver, compile the method with `this: (ref $__fnctor_Parser)` —
   field reads become bare `struct.get`, writes `struct.set`, no
   dispatcher calls.
2. **Unboxed value representation** (#1584 / value-rep goal): keep
   number-typed locals/fields as raw f64/i32 through expressions;
   box only at genuine `any` boundaries. Kills the
   `__box_number`/`__unbox_number`/`$AnyValue` churn that dominates the
   user-closure share.
3. **Direct-call devirtualization**: `this.method(...)` on a
   monomorphized receiver becomes a direct `call` to the compiled
   method function (no closure struct, no `__apply_closure`, no
   `call_ref` type ladder).
4. Only then do the residual runtime helpers (`__regex_run`,
   `__to_primitive`, iterator glue) matter again.

Items 1-3 are the standing IR/value-rep roadmap; this branch's inline
caches remain valuable as the fallback path those optimizations demote
to.

## Round 6 — arity IN the closure representation (the deferred layout change)

Every closure struct in the root wrapper hierarchy now carries an immutable
`$arity` i32 at field 1 (`CLOSURE_ARITY_FIELD_IDX`); captures/TDZ slots
start at `CLOSURE_CAPTURE_FIELD_BASE` (2). `buildClosureArityProbe` (inside
`__apply_closure`) and the `__closure_arity` export answer with ONE
`ref.test <root>` + `struct.get` — the per-func-type chain survives only
for shapes outside the hierarchy (fnctor ctor closures). Touched: type
mints (wrapper root/per-sig/constructible, arrow/named/fallback structs,
funcref-as-closure `__fn_cap_*`, async-scheduler settle-cap, builtin-fn
meta, IR `__ir_closure_*`), all allocation sites (emitClosureConstruction,
trampolines/lazy caches, member-get dispatch arms, promise executor caps,
builtin closure values, IR `closure.new` via a new optional
`emitClosureArityOperand` backend-trait method — bytecode/linear backends
unaffected), capture-index math (closures.ts, funcref-as-closure
trampolines, IR capFieldIdx), and the bfn meta state/id field shifts in
`fillBuiltinFnMeta`. One missed site (the IR lowering) was caught by the
loud struct.new-operand-count validation failure in issue-3546's suite and
fixed.

**Result: `__apply_closure` VANISHED from the standalone parse profile
(was 12.5% self).** Wall time ~2.7ms/parse (the arity chain was the last
of `__apply_closure`'s cost); profile-loop throughput +30%. Post-round
profile: `__extern_get` 14.1%, `__obj_find` 8.2%, `__str_equals` 6.3%,
`__vec_overlay_lookup` 5.6% — property lookup is now decisively the top
family (#3669/#3671 next).

Verification (round 6): 16-shape closure smoke matrix compiles+validates
both targets; closure/hoisting/arity battery back to exactly the 10 known
pre-existing failures (3546 green); IR suites — 9 `ir-bytecode-wasmgc-vm`
failures reproduce identically on base (pre-existing env issue); async +
generator suites green; standalone batch — same 3 pre-existing; host
corpus 23/23 exact; standalone canaries 4/4; 1712 acceptance green; tsc +
biome clean. The emitted `__apply_closure` carries a 149-arm `ref.test` chain
over distinct closure FUNC types to answer "declared arity of this
closure" (the #3592 widening probe), and `__call_fn_method_1` a 69-arm
chain to select the `call_ref` target type. Together `__apply_closure`
(12.5%) + `__call_fn_method_{0,1,2,3}` (~13.5%) are the dominant remaining
cost, and both are O(#closure-func-types) per dynamic call. The real fix
is REPRESENTATIONAL: carry the declared arity (and ideally a small
signature id) as a field in the root closure wrapper so the probe is one
`struct.get`. That shifts every capture field index by one — capture
indices are computed at multiple sites (`closures.ts` `i + 1` sites, TDZ
at `1 + captures.length + ti`, `__constructible` append, every allocation
`struct.new` operand list) — a contained but genuinely risky refactor
that needs its own slice with the full closure/dispatch suite as the
gate (the #1712 history shows this class of change causing invalid-wasm
regressions when done piecemeal). Remaining profile after round 4:
`__apply_closure` 12.5%, `__extern_get` 11.3%, `__obj_find` 6.5%,
`__call_fn_method_1` 5.4%, `__str_equals` 5.2%.

**Answer to the hybrid question**: yes, and it is now the winning
direction. The standalone object runtime, after this round, outperforms
the host bridge — so a "standalone-core + thin host imports" artifact
(host provides only what Wasm can't: I/O, RegExp beyond the native subset,
Date/locale, etc.) is the right target shape. Two concrete gaps block
promoting it to the default acorn artifact:
  - the 17-file corpus-concat fixture TRAPS in the standalone parser
    (pre-existing, reproduces before this branch — needs its own triage;
    the 23-input host corpus is all-green, so this is a standalone-runtime
    gap, not a parser gap);
  - standalone string output/marshalling back to JS needs a thin
    `wasm:js-string`-style seam so a Node host can call `parse` with a JS
    string without compiling the input into the module.

Verification for this round: all four standalone acorn canaries green
(parse / parseExpressionAt / tokenizer / function-body), 94
standalone/native-string test suites — zero new failures (9 pre-existing,
each verified identical on the committed base: issue-1599 JSON-refuse ×3,
issue-2865 async-await ×2, issue-2879 floor ×2, issue-681 iterators ×2),
host corpus 23/23 exact, host bench unchanged, 1712 pins green, tsc +
biome clean.

## Correctness fix — `Function.prototype.call`/`apply` on a closure

(Not a perf round: a semantics bug surfaced by scaling the standalone
benchmark up to a full-size input.)

Found by scaling the standalone benchmark from the 4 tiny canaries + the
330 B fixture up to acorn parsing **its own 245 KB `dist/acorn.js`**. The
canaries pass; the full self-parse did not — it died with
`TypeError: Cannot access property on null or undefined at 2724:51`
(`parseMaybeAssign`, `refDestructuringErrors.shorthandAssign >= left.start`).

Root cause, and it is a **correctness bug, not a perf one**: a closure is
not a `$Object`, so `__extern_method_call` sent a method call on a function
value to the #3468 closure own-property side table. That table has no
`call`/`apply` entry, so the lookup missed and the whole call expression
evaluated to `undefined` — the function was never invoked. It only bites
where the receiver is **dynamic** (a parameter or field), because a static
receiver is rewritten by the `.call`/`.apply` cases in `calls.ts` long
before the runtime sees it. acorn hits exactly that shape:
`left = afterLeftParse.call(this, left, startPos, startLoc)` with
`afterLeftParse` a parameter (`this.parseParenItem`), so `left` came back
`undefined` and every parenthesized or destructuring assignment crashed on
the following line.

Fix: a new reserved helper `__closure_method_call(fn, name, args)` (same
reserve-then-fill discipline as the rest of C-core, so no funcIdx shift),
spliced into `__extern_method_call`'s non-`$Object` arm. Two routes in spec
precedence order — an own property in the closure's bag still wins (§10.2
[[Get]], the #3468 `assert` harness behaviour, unchanged), otherwise
`call`/`apply` resolve to the %Function.prototype% builtins and invoke the
receiver itself via the existing `__apply_closure` bridge
(`fn.call(t, a, b)` → `__apply_closure(fn, t, [a, b])`;
`fn.apply(t, arr)` → `__apply_closure(fn, t, arr)`). The method name is
matched by `ref.eq` against the interned literal (round 2), the same
identity test the string-receiver fast path uses; a non-interned name
misses and falls through to the old undefined result, so nothing regresses.
Throw-free, per the C-core discipline.

Measured on a 29-case assignment/call matrix through standalone-compiled
acorn: **12 broken → 8 broken, 0 regressions** (each of the 8 verified
byte-identical on the committed base). Newly correct: `({a: b} = c)`,
`({...a} = b)`, `(a) = 1`, `(function(){…}).call(null)`, and direct
`f.call(a, b)` / `f.apply(a, [b, c])`. Pinned by
`tests/issue-3673-closure-call-apply.test.ts` (7 cases). Host/gc mode is
**byte-identical** (verified by sha256 of a compiled binary before/after —
the whole helper is behind the `ctx.standalone || ctx.wasi` gate).

### Full self-parse is still blocked — three SEPARATE pre-existing bugs

Fixing `.call` moves the 245 KB self-parse deeper but not to green. The
remaining blockers are independent of it and each reproduces on the
unmodified base, so they are **not** regressions from this round:

1. **`raise`/`getLineInfo` null deref.** Any acorn `raise(...)` traps with
   `dereferencing a null pointer` inside `getLineInfo` — `this.input` reads
   non-null at the `raise` entry but the `input` parameter is null one frame
   in. Reproduces on the base with a bare `1 = 2` or `var 3 = x`, i.e. it
   needs no destructuring and no `.call`.
2. **`for-in` over a fnctor instance enumerates nothing**, which breaks
   shorthand object destructuring. `({a} = b)`, `({a = 1} = b)`,
   `({a, b: [c]} = d)` reach `toAssignable`'s `default:` arm and raise
   "Assigning to rvalue" although they are valid; the trace shows the
   `Property` arm entered with `kind=init`, so the bad node is the shorthand
   `prop.value`, which acorn builds with `copyNode`'s
   `for (var prop in node) { newNode[prop] = node[prop] }`. Confirmed with a
   9-line repro — copying a fnctor instance carrying expando properties
   yields a copy with **none** of them, so `value.type` is `undefined` and
   no `toAssignable` case matches (cf. the known #2668 for-in gap). Then
   (1) turns the bogus raise into a trap.
3. **RegExp construction.** `var re = /ab+c/g` traps with `illegal cast` in
   `parseFloat` via the regexp validator's `reset`. — **already tracked as
   #3675** (same trap, same `parseFloat`/`reset` dispatch site), confirmed
   after merging `upstream/main`.

Ownership after the 2026-07-27 upstream merge: (3) is **#3675**. The
oversized-string-literal limit this benchmark also tripped (a single 245 KB
literal overflows the compiler, hence the 8 KB chunking in
`.tmp/bench-acorn-full.mjs`) is **#3674**. (1) and (2) are **not yet owned
by any issue** — #1243 covers `for-in`/`Object.keys` enumeration but is
`done` and did not cover the standalone lane's fnctor instances.

The standalone lane's correctness gate is currently 4 canaries, which is why
all of these (including the `.call` bug) were invisible. **A full acorn
self-parse is the gate that would have caught them** — worth adding once
(1), (2) and #3675 land.

## Remaining follow-up (out of scope here, needs codegen)

The residual ~150-300x is dominated by crossing VOLUME, not per-call cost.
Structural reductions belong to the existing codegen goals:

- **#3669 / #3671 property-slot monomorphism** — keep hot fnctor field
  reads/writes on typed struct slots Wasm-side instead of `__extern_get`/
  `__extern_set_strict` crossings.
- **#1946/#1947 GC-ref typing / closure devirtualization** — reduce
  `__extern_get_raw_callable` + `__extern_method_call` dispatch.
- Cheap codegen wins observable in the .wat: `__get_undefined` is a host
  call per `undefined` literal use (4.7k/parse — cacheable in a global);
  `__typeof_number`/`__is_truthy`/`__host_eq`/`__host_compare` on boxed
  numbers could take a Wasm-side fast path before falling back to the host.
- Value representation (`__box_number`/`__unbox_number` 11k crossings per
  330B parse) is the #1584-era value-rep question.


## Appendix — the upstream #3673 filing (merged 2026-07-27)

The issue was independently filed on main as
`3673-compiled-acorn-selfparse-performance.md` (116 lines, whole-file
self-parse protocol). That file is folded in here to resolve the id
collision; its body follows verbatim.


# #3673 — Make compiled Acorn self-parse performance usable

## Problem

Acorn 8.16.0 compiled by js2wasm now produces exact ESTree for every tracked
Test262 parser input (#1712), but parsing Acorn's own distribution is roughly
three orders of magnitude slower than node-acorn. Correctness is complete for
the JS-host artifact; performance is not production-ready.

The measured input was the pinned `acorn@8.16.0` `dist/acorn.mjs`:

- 230,975 UTF-8 bytes;
- SHA-256
  `efb0124a960b34d53f9928c4926bfcfd300bb6a3d7ab64ee949b3a8bed1c7e5f`;
- options `{ ecmaVersion: 2025, sourceType: "module" }`;
- compiler revision `2bf320a91f330727ac2b7d9cc05cf13aeb982bae`;
- Node 24.4.1 on macOS arm64.

The protocol used three warmups, fifteen measured samples, alternating lane
order, and forced GC outside each timed sample.

### Public `parse()` lane

This lane calls the public parser export and materializes the complete AST on
the host.

| Metric     |  node-acorn | compiled Acorn |
| ---------- | ----------: | -------------: |
| median     |   19.745 ms |  25,914.072 ms |
| p25        |   18.809 ms |  25,318.868 ms |
| p75        |   24.724 ms |  28,138.480 ms |
| mean       |   21.252 ms |  27,111.723 ms |
| throughput | 11.698 MB/s |  0.008913 MB/s |

The median slowdown is **1,312.451×** and the mean slowdown is **1,275.740×**.
The compiled artifact is 681,946 bytes. js2wasm compilation took 8,351.925 ms,
while native `WebAssembly.compile` and instantiation took 1.465 ms and
16.270 ms respectively.

### In-module body-length lane

To separate parser execution from AST host marshalling, a second module calls
Acorn internally and returns only `Program.body.length`.

| Metric     |  node-acorn | compiled Acorn |
| ---------- | ----------: | -------------: |
| median     |   17.394 ms |  26,691.089 ms |
| p25        |   13.810 ms |  26,254.397 ms |
| p75        |   19.996 ms |  27,540.707 ms |
| mean       |   17.068 ms |  27,869.387 ms |
| throughput | 13.279 MB/s |  0.008654 MB/s |

The median slowdown is **1,534.511×** and the mean slowdown is **1,632.884×**.
The augmented module is 915,284 bytes. Its js2wasm compilation,
`WebAssembly.compile`, and instantiation took 10,285.972 ms, 2.544 ms, and
20.879 ms.

Because the in-module lane is not faster than the public lane, AST host
marshalling is not the dominant cost. The remaining cost is inside compiled
parser execution and its runtime/dynamic-dispatch paths. A profile is required
before assigning the cost to a particular call family.

## Required investigation

- Check in a repeatable benchmark with both the public-AST and in-module scalar
  lanes, the pinned input hash, warmups, sample count, alternating order, and
  percentile output.
- Capture profiles/counters that separate generated parser work from runtime
  method/property dispatch, string operations, RegExp operations, allocation,
  and host bridge calls.
- Identify the smallest set of hot paths responsible for at least 80% of
  compiled wall time. Do not infer that AST marshalling is the bottleneck from
  the public lane.
- Optimize the measured hot path without replacing Acorn with a parser-specific
  intrinsic or changing the public
  `parse(nativeString, optionsObject) -> ESTree object` contract.

## Acceptance criteria

- The benchmark is reproducible from a clean checkout and emits
  machine-readable raw samples plus median, p25, p75, mean, throughput, binary
  size, compiler time, Wasm compile time, and instantiation time.
- A before/after profile records the dominant cost centers and explains at
  least 80% of the compiled execution time.
- Both compiled lanes improve by at least **10×** from the measurements above
  on the same machine/protocol, with no more than a 10% node-acorn control
  drift. If host variability prevents that comparison, use paired sample
  ratios and record the control distribution.
- The required 23-input Acorn corpus, the exact full Test262 AST differential,
  and the zero-import standalone scalar canaries remain green.
- Any remaining gap above 10× native is split into measured, non-overlapping
  follow-up issues before this issue closes.

## Scope boundary

This issue owns parser execution performance. The standalone full-source
illegal cast is #3675. Oversized static string initialization is #3674.
