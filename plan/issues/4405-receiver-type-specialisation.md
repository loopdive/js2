---
id: 4405
title: "receiver-type specialisation: prove `this` per prototype-method family, emit guard-free typed variants"
status: ready
sprint: current
created: 2026-08-14
priority: high
horizon: xl
feasibility: hard
task_type: perf
area: codegen
related: [4157, 4406]
# (#4405 Phase 0) The census instruments five early returns that live INSIDE
# `resolveTypedThisField` / `resolveTypedThisWritableField`. A decline bucket has
# to be recorded where the decline happens, so the growth is unavoidable and is
# ~40 lines, most of it the comments explaining what each bucket means. The
# counting logic itself is in the new `src/codegen/receiver-spec-census.ts`.
loc-budget-allow:
  - src/codegen/typed-this.ts
---

# #4405 — receiver-type specialisation: prove, don't guess

## Problem

#4157 entry 39's paired-profile decomposition: after the tuned-11 flip,
**~3.2× of the remaining ~5.7× gap to Node lives INSIDE compiled function
bodies**, not in helper calls. The worst offenders are acorn's prototype
methods — `pp.next` **19.5×** slower than V8's compiled version,
`pp$5.parseSubscript` **9.9×**, `finishNodeAt` **9.0×**, `pp.skipSpace`
6.2× — while functions with already-direct shapes (`pp$2.finishNode`,
`stringToNumber`) sit at **1.0× parity**. The gap is concentrated, not
uniform: it is the per-operand re-resolution, guard diamonds, and boxed
traffic that dynamic `this` forces on every member access.

The compiler already has the proven-path tier (`__typed_this` closure
variants exist where `this` is derivable today; `ELIDE_PROVEN_NONNULL_TYPEERROR`
elides on proof; guard-reuse drops provably-redundant checks). What's missing
is the WHOLE-PROGRAM step: for the `pp.foo = function(){...}` prototype-method
idiom, prove the receiver's constructor family closed-world and emit a fully
typed variant with raw `struct.get`/`struct.set` — **no guard, no fallback** —
plus the dynamic original for unproven call paths.

## Why proof, not more ICs (project-lead direction, 2026-08-13)

A monomorphic guard is nearly free at runtime but is a control-flow diamond
the optimizer cannot fold across — defect C existed because of exactly that.
Proof buys code size AND unblocks downstream optimization, and where it
succeeds it subsumes the (default-OFF) site-IC guards of
`JS2WASM_SET_MEMBER_IC` / `JS2WASM_CALL_DISPATCH_IC` (#4491).

## Shape of the work

1. **Closed-world receiver inference**: for each fnctor/constructor family,
   collect every prototype-method assignment and every construction site;
   prove per method that all reachable receivers are the family's struct
   (no expando writes to the accessed props, no `delete`, no setter, no
   escaping alias that widens the type).
2. **Typed variant emission**: clone the method body with `this` bound to the
   proven struct type; member reads/writes lower to direct field ops; numeric
   fields stay f64/i32 end-to-end.
3. **Call-site routing**: call paths whose receiver provenance is proven route
   to the typed variant; everything else keeps the dynamic original.
4. Flag-gated (`JS2WASM_RECEIVER_SPEC`, default OFF), byte-identical off,
   poison probe, exec-census + per-function profile deltas on the acorn lane
   (targets: `pp.next` and `parseSubscript` self-time, entry 39's table as
   the before).

## Acceptance criteria

- `pp.next`'s wasm/node self-time ratio drops materially below 19.5× with the
  flag on (measured by entry-39's paired-profile method).
- Checksum 422; equivalence suites green scoped; flag-off byte-identical.
- An architect spec (`## Implementation Plan`) lands in this file before
  implementation — the inference's soundness conditions are the hard part.

---

## Implementation Plan

**Architect, 2026-08-14.** Written against `recover/levers-integration`
@ `a57876adc`. Every number below is MEASURED on this tree, not carried
forward from the issue text — see §0 for how, and §1 for what it corrects.

### 0. Reproduction — the one command everything here rests on

There is **no `exec-run.mjs` in the repo** (see §1.5). The lane used for
every measurement in this spec is the committed standalone acorn compile:

```js
// .tmp/probe-4405-census.mjs
import { compileStandaloneAcorn } from "../tests/dogfood/acorn-standalone-compile.mjs";
const r = await compileStandaloneAcorn();
process.stderr.write(`[probe] success=${r.success} bytes=${r.binaryBytes} ms=${r.compileMs}\n`);
```

```bash
JS2WASM_TYPED_THIS_DEBUG=1 JS2WASM_DIRECT_CALLS_DEBUG=1 \
  npx tsx .tmp/probe-4405-census.mjs
JS2WASM_PROVEN_RECEIVER_STATS=1 npx tsx .tmp/probe-4405-census.mjs
```

~85 s, `optimize: 3`, `target: "standalone"`, acorn 8.16.0 from the pinned
tarball. Baseline artifact on this tree: **success=true, 1,157,936 bytes**.

### 1. Root cause — the issue's premise is out of date, and that changes the work

**The whole-program receiver inference this issue asks for is already built,
already sound, already DEFAULT-ON, and already at 97.9 % coverage on acorn.**
Shipping a second one would be duplicate work. The measured residual is on a
*different axis* than the issue names. Five corrections, then the real
decomposition.

#### 1.1 `__typed_this` is not "variants where `this` is derivable" — it is the entire program #4405 describes, shipped

`src/codegen/typed-this.ts` (2,079 lines) implements, end to end:

| stage | what | where |
| --- | --- | --- |
| S1 | closed-world write-once prototype-method verdicts | `analyzeProtoMethodWriteOnce`, `fnctor-escape-gate.ts:664` |
| S2 | typed twin body, `this.<f>` → `struct.get`/`struct.set` | `admitTypedThisTwin` :209, `resolveTypedThisField` :401 |
| S3 | direct-call devirtualization between twins | `tryEmitDirectTwinCall` :1563, `admitDirectCall` :1100 |
| S3b | arity padding for under-applied sites | `DirectCallTrampoline.padInstrs` :862 |
| S4a | f64/i32 field slots end-to-end | `numeric-property-analysis.ts` |
| #3754 | **refined f64 twin RETURN type** | `refinedTwinReturnType` :1054 |
| #3780 | direct target for capture-carrying methods | `recordDirectCallGeneric` :969 |
| #3685 | proven-receiver reads for NON-`this` receivers | `tryEmitProvenReceiverFieldGet` :1321 |

Measured on acorn (`JS2WASM_TYPED_THIS_DEBUG=1`):

```
[typed-this] twins=488 declinedTwin=0 get=1366 set=98 compound=18 incdec=98
[direct-calls] sites=3976 trampolines=545 twinFills=516 genericFills=29 legacyFills=0
[direct-calls] declined: no-write-once-verdict=208 named-fn-expr=16 uses-arguments=8 ref-typed-param=4
```

**488 twins, zero twin declines, zero legacy fills.** `this.<field>` inside a
twin resolves to a direct struct op **1,580 times against 34 declines — 97.9 %**.
The 34 are all `nofield:` on accessor-backed flags (`inAsync`,
`inTemplateElement`, `canAwait`, `treatFunctionsAsVar`, `allowUsing`,
`allowReturn`, `allowSuper`, `allowDirectSuper`, `allowNewDotTarget`,
`inGenerator`, `inClassStaticBlock`).

Consequence for entry (30)'s exemplar: `this.lastTokEnd = this.end` in
`pp.next`. `lastTokEnd` and `end` are both declared **f64** slots of
`__fnctor_Parser`, neither presence-tracked (they appear as
`ok:lastTokEnd:f64` / `ok:end:f64` in the census), and the instrumented run
recorded **zero** `WRITE-immutable` and **zero** `WRITE-callsig` declines. So
inside `pp.next`'s twin that statement is already two struct ops. **Defect A
and defect B are fixed for `this`-rooted operands.** Anyone starting this
issue by re-attacking that statement will find it already done.

#### 1.2 The soundness conditions the issue asks to "specify precisely" are all implemented — here is the map

Do **not** re-derive these. Read `fnctor-escape-gate.ts:183-227` and
`typed-this.ts:24-70` (the equivalence argument) first.

| condition #4405 requires | implemented as | file:line |
| --- | --- | --- |
| no expando write to an accessed prop | `otherNameWrites` set | escape-gate :204-216 |
| dynamic property names alias a prop | `otherNameWrites = null` sentinel | escape-gate :906 |
| no `delete` on the prototype | `poisoned` (delete ⇒ poison) | escape-gate :189-194 |
| `delete` on an INSTANCE slot | presence-bit carve-out + struct-delete sentinel | typed-this :434-439, :55-69 |
| no accessor shadowing | `ctx.classAccessorSet` carve-out | typed-this :421-425 |
| escaping alias widens the receiver set | `poisoned` (prototype escape) | escape-gate :189-194 |
| foreign inheritor via `Object.create` | `inheritedFrom` | escape-gate :217-224 |
| slot reassigned later | write-once `methods` map | escape-gate :186-199 |
| `.call`'d on a foreign receiver | the generic body's `ref.test` shim | `buildTypedThisForwardGuard` :332 |
| reserved names | `RESERVED_PROPS` | typed-this :98 |

Failure mode throughout is "miss a monomorphization", never "wrong lowering".
The acorn idiom the issue asks to verify — `var pp = Parser.prototype; pp.next
= function(){…}` — is explicitly handled (escape-gate :186-189) and the 488
twins are the proof it fires.

#### 1.3 `JS2WASM_IC_GUARD_REUSE` does not exist

Grep of `src/`, `scripts/`, `tests/` for `GUARD_REUSE`/`guardReuse`/
`guard-reuse` returns **nothing**. Entry (30)'s **defect C** (no redundancy
elimination between adjacent ICs, 6,723 `ref.test` of one struct type) is
**unbuilt**. Do not plan around a pass that isn't there.

> **Correction (main session, 2026-08-14) — branch skew, not absence.**
> `JS2WASM_IC_GUARD_REUSE` IS built: `src/codegen/ic-guard-reuse.ts` on PR
> #4455's branch (`claude/acorn-performance-optimization-hagjht`, in the
> merge queue at time of writing), default OFF, measured −829 static type
> tests / 319,847 executed reuses per parse. This spec's base
> (`recover/levers-integration`, stacked on main) predates that merge, which
> is why the grep was empty. Consequence for Phase 4: do NOT rebuild defect
> C's fix — price guard hoisting against `ic-guard-reuse.ts` once #4455
> lands, and extend it rather than adding a second pass.

#### 1.4 `ELIDE_PROVEN_NONNULL_TYPEERROR` is not usable proof plumbing

Real name `JS2WASM_ELIDE_PROVEN_NONNULL_TYPEERROR`, `nonnull-proof.ts:72-78`,
**default OFF**, and #4157's own entry measured it as *"a 2-of-3,629 null"*.
It is not a foundation to build on.

#### 1.5 The cited baseline table (entry 39) is NOT in the record on this branch

`plan/issues/4157-close-the-acorn-node-performance-gap.md` on
`recover/levers-integration` jumps from entry **(34)** to entry **(44)**.
Entries 35–43 are absent; grep for `parseSubscript` / `finishNodeAt` / `19.5`
across `plan/` returns nothing. Entry (44) *references* "entry 39's
decomposition" but the table itself is unrecovered.

**Therefore the acceptance criterion "`pp.next` drops materially below 19.5×"
cannot be evaluated** — there is no committed 19.5×. Phase 0 below
re-establishes the baseline before any optimisation is judged against it.
Whoever recovers entry 39 should paste it back into #4157.

> **Correction (main session, 2026-08-14) — same branch skew as §1.3.**
> Entry 39 (the paired-profile table with pp.next 19.5× / parseSubscript
> 9.9× / finishNodeAt 9.0×) IS committed — on PR #4455's branch; entries
> 40–43 are on PR #4490's. Both are in the merge queue; once they land, the
> table is on main and the acceptance criterion is evaluable as written.
> Phase 0's re-measurement stays worthwhile regardless (the 19.5× was
> measured pre-flip; the post-flip, post-#4455 baseline is the honest
> "before" for this issue).

#### 1.6 The real decomposition, measured

`JS2WASM_PROVEN_RECEIVER_STATS=1` on the same compile:

```
[proven-receiver] asked=4064 proven=244 inlined=88 declinedAfterProof=156
[proven-receiver]   unproven-receiver=3820
```

Plus a hand-instrumented run (temporary counters in `resolveTypedThisField`'s
three un-noted early returns — Phase 0 makes these permanent):

| bucket | count | meaning |
| --- | ---: | --- |
| `this.<f>` in a twin, inlined | **1,580** | done |
| `this.<f>` in a twin, declined | **34** | accessor-backed flags only |
| attempts from a NON-twin function | **5,884** | constructors + no-write-once fns |
| attempts in a twin, receiver ≠ `this` | **2,346** | **the target** |
| non-`this` receivers asked → proven | **4,064 → 244 (6.0 %)** | **proof coverage gap** |
| proven → inlined | **244 → 88** | **struct-shape gap (156)** |
| non-`this` WRITES inlined | **0** | **no emitter exists** |

Receiver breakdown of the 2,346 (top entries):

```
types$1=590  node=488  state=370  propaccess=134  prop=108  expr=64
refDestructuringErrors=48  elemaccess=44  this.type.<>=28  element=24
list=22  value=22  id=20  scope=20  this.input.<>=18  key=18 …
```

Every one is a local identifier or a second-hop member — never `this`. And
the 156 declined-after-proof are dominated by `nofield:Node.*`:
`local`, `raw`, `key`, `argument`, `exported`, `imported`, `expressions`,
`operator`, `value`, `property`, `id`, `body`, `static`, `quasis`,
`properties`, `generator`.

Why: `deriveFnctorFields` (`fnctor-escape-gate.ts:1778`) derives slots from
`this.<f> =` writes **inside the constructor body only**. Dumped shape:

```
__fnctor_Node fields = type:ref_null start:f64 end:f64 loc:ref_null(P)
  sourceFile:externref(P) range:ref_null(P) $presence_0:i32 $presence_1:i32
  $constructor:externref $shape:i32 $resid:ref_null
```

acorn's `Node` constructor writes exactly `type`/`start`/`end` (+3 optional).
**The entire AST payload is written later, by the parse methods, and lives in
the `$resid` sidecar** — reachable only dynamically. That is the structural
reason `finishNode`-family code is slow, and no amount of receiver *proof*
fixes it; the slot has to exist.

### 2. Verdict on the two design questions the brief asks for

**(a) All-or-nothing per method, or per-site downgrade? → PER-SITE, and this
is not really a choice.** The shipped architecture is already per-site: every
emitter (`tryEmitTypedThisFieldGet` :450, `tryEmitTypedThisFieldSet` :500,
`tryEmitProvenReceiverFieldGet` :1321) returns `undefined` to decline, and a
decline falls through to the byte-identical pre-existing dispatcher lowering.
Switching to all-or-nothing would mean a method that touches one
presence-tracked field loses typing on its other 20 accesses — a strict
regression against a measured 97.9 %. Keep per-site. The one place
all-or-nothing already applies correctly is *twin admission* itself
(`admitTypedThisTwin` :209), because a twin is a whole second compilation of
the body and a partial one is not a thing.

**(b) "No guard, no fallback"? → REJECT for the non-`this` axis. Keep the
`ref.test`.** The codebase already argues this against itself, at
`DirectCallTrampoline.guardedReceiver` (typed-this.ts :838-852): the `this`
form is unguarded because *the only way to reach the call site is through the
twin's own cast*, so a mis-cast is impossible by construction. A
receiver-flow verdict carries no such guarantee — it is a whole-program
inference, and an unguarded cast **turns any imprecision into a runtime trap
with no fallback**, versus a missed optimization. A `ref.test` + two-arm `if`
is ~3 instructions against a helper call being removed.

The *right* way to get guard-free is not to delete the guard but to **hoist**
it: one test per proven binding per function, reused by every access — which
is simultaneously entry (30)'s unbuilt **defect C**. `JS2WASM_PROVEN_FIELDS=unguarded`
(typed-this.ts :1482) exists precisely to *price* that hoist and is documented
as "UNSOUND as a shipping mode". Use it to measure, never to ship. Guard
hoisting is Phase 4 and should probably be its own issue.

### 3. Scope statement

> **#4405 is re-scoped to: receiver-type specialisation for NON-`this`
> receivers.** The `this` axis (#3683 S1–S4, #3754, #3780) is complete and
> stays untouched. The work is (i) raise receiver-flow proof coverage from
> 6.0 %, (ii) give the proven receivers real slots to load, (iii) build the
> missing write-side emitter.

Retitle the issue accordingly; leave the original problem statement as
history with a pointer to this section.

### 4. Phasing — four landable PRs, each with its own checkpoint

Every phase: flag `JS2WASM_RECEIVER_SPEC` default **OFF**; sha256 of the
emitted binary identical to base with the flag off; a poison probe; checksum
422 on the acorn lane.

> **Byte-identity caveat, state it in every PR.** The existing typed-this /
> proven-fields machinery is default **ON** (`typedThisEnabled()` :101,
> `provenFieldsEnabled()` :1285 — both `!== "0"`). "Flag-off byte-identical"
> therefore means *identical to today's default-on artifact*
> (1,157,936 bytes), **not** to some untyped baseline. Do not accidentally
> gate existing behaviour behind the new flag.

#### Phase 0 — permanent census (no codegen change)

`src/codegen/receiver-spec-census.ts`, modelled on `proven-receiver-stats.ts`.
Promote the three currently-silent early returns in `resolveTypedThisField`
(typed-this.ts :413 `NOT-IN-TWIN`, :419 `RECEIVER-NOT-THIS`, :430
`no-field-table`) and the two unnoted declines in
`resolveTypedThisWritableField` (:488 `!mutable`, :490 `callsig`) to named
buckets under `JS2WASM_RECEIVER_SPEC_STATS=1`. Add a per-receiver-shape
histogram (identifier text / `this.<f>.<>` / element-access / call).

Also re-establish the per-function baseline entry 39 was supposed to hold
(§1.5) so later phases have a real "before".

- Byte-identical **by construction** — every `note*` is a statement, never
  part of a condition (the `alloc-census.ts` house rule).
- **Checkpoint:** reproduces §1.6's table exactly. Land this first; it is the
  instrument the other three are judged with, and it is cheap.

#### Phase 1 — proof coverage: 3,820 unproven receivers

`src/codegen/receiver-flow-analysis.ts` (530 lines). Its passes today:
1b alias map (:184), 1c prototype-method + return-class fixpoint (:212),
2 parameters agreeing across call sites (:283), 1d call-return bindings
(:403), 3 demotion (:472).

`call-return` **is** implemented (:417) and targets exactly `var node =
this.startNode()`. It nonetheless yields only 244 verdicts. **First task is
diagnosis, not code**: instrument which pass drops `node` / `state` /
`prop` / `expr`. Prime suspects, in order:

1. `resolveLocalBinding` (:110) is a deliberately weak syntactic scope walk
   that yields nothing on a duplicated name — and acorn's bundle is full of
   `scope$1`, `scope$2`, `scope$3`, `list$1`, `node$1` renames. Verify before
   assuming.
2. `isConstLike` (:93) accepts **`const` only**; the header claims "`const`
   or a `let` never reassigned" but the code does not implement the second
   half. acorn's dist bundle is ES5-style `var`. **This is very likely the
   dominant miss** and is a small, well-scoped fix: admit a `var`/`let`
   binding that pass 3 never demotes.
3. Pass 1d requires the initializer to be *syntactically* a `CallExpression`;
   `let node = this.startNodeAt(startPos, startLoc)` qualifies, but
   `node = this.startNode()` as a bare assignment (no declaration) does not.

**Explicitly out of scope: `types$1` (590 sites, the single biggest bucket).**
It is acorn's token-type *table* — a plain object literal, not a fnctor
instance, so no `__fnctor_*` struct exists for it and `receiverClassOf` can
never answer. File a separate issue for object-literal shape typing; do not
let it distort this one.

All type queries go through `ctx.oracle`. **Ratchet hazard:** the change-scoped
gate (`scripts/check-oracle-ratchet.mjs`) judges only files the PR touches,
against `origin/main`'s counts. `typed-this.ts` already carries **3**
`ctx.checker.getTypeAtLocation` calls (:460, :486, :1380) and is **not** in
`scripts/oracle-ratchet-baseline.json`, so *any* added raw-checker call in a
touched file fails the gate. `receiver-flow-analysis.ts` is pure-syntactic
(`import ts` only, no checker) — **keep it that way**; it is the cleanest
place to add proof rules.

- **Checkpoint:** `proven/asked` up from 6.0 %; `inlined` up from 88;
  1,157,936-byte artifact still compiles; checksum 422. Report the funnel, not
  just the top line — a proof that doesn't convert to an inline is not a win.

#### Phase 2 — the struct-shape gap: 156 proven-then-declined

The highest-value phase and the one that actually reaches `finishNode` /
`parseSubscript`. `__fnctor_Node` must carry the AST payload names as real
slots instead of `$resid`.

The machinery mostly exists — `$shape`/`$resid`, per-type layouts (#3927),
flow-grown fields, `fnctor-cold-tail.ts` (hot/cold field split, :88-134),
`closed-struct-extern-set.ts` (":43 every flow-grown field — the whole
copyNode surface"), `fnctor-layout-emit.ts`. What is missing is promoting
the *measured-hot* flow-grown names of `Node` into inline slots.

Constraints, in order of how badly they bite:
- A flow-grown field is **conditional**, so it is presence-tracked, and
  `tryEmitProvenReceiverFieldGet` refuses presence-tracked **non-externref**
  slots outright (:1398-1402, and the reason at :1391-1396 is a hard
  correctness condition: `undefined` has no representation in an f64 slot).
  So promoted payload slots must be **externref** — which is fine, the
  payload is AST references, and the census confirms the shape
  (`presence-nonextern:Node.loc:ref_null=16` is the *counter*example).
- Struct width is a code-size and allocation cost paid on **every** `Node`.
  `fnctor-cold-tail.ts`'s `JS2WASM_FNCTOR_HOT_FIELDS` knob already models
  exactly this trade-off — reuse it, do not invent a second budget.
- Do not promote a name that appears in `otherNameWrites`-style dynamic
  writes; `copyNode`-driven surfaces are the risk area.

- **Checkpoint:** `nofield:Node.*` → 0 for the promoted set;
  `declinedAfterProof` well below 156; binary size delta reported explicitly
  (this phase can legitimately *grow* the binary — say so and price it).

#### Phase 3 — the write side (entry 30 defect B, non-`this` axis)

There is **no** `tryEmitProvenReceiverFieldSet`. Grep confirms
`tryEmitProvenReceiverFieldGet` is the only proven-receiver emitter, consumed
at `property-access-dispatch.ts:592`. Meanwhile `__set_member_*` was measured
at **344,602 executed calls/parse** (entry 30).

Build it as the composition of two shipped things:
- the value/coercion logic of `tryEmitTypedThisFieldSet` (typed-this.ts :500)
  — including its `ctx.booleanPropertyNames` ToBoolean normalisation (:519)
  and the *two different nominal struct types cannot bridge directly* rule
  (:533-541), which is easy to get wrong;
- the `ref.test`-guarded two-arm `if` shape of
  `tryEmitProvenReceiverFieldGet` (:1490-1500), with the else arm being the
  existing `__set_member_*` dispatcher call.

The receiver must be spilled to a temp exactly once (evaluate-once, §13.15.2
reference-before-value); `tryEmitTypedThisFieldSet` gets this for free because
its receiver is already a local. Wire from `assignment.ts:3953`, immediately
after the `tryEmitTypedThisFieldSet` attempt. `operator-assignment.ts:2212`
gets the compound twin later, not in this PR.

- **Checkpoint:** `__set_member_*` executed count down from 344,602
  (`JS2WASM_EXEC_CENSUS`, `src/codegen/exec-census.ts`); checksum 422.

#### Phase 4 — guard hoisting (probably its own issue)

One `ref.test` per proven binding per function, result in an i32 local,
reused. This is entry (30)'s defect C and the sound route to the "guard-free"
outcome the issue asked for. Price it first with
`JS2WASM_PROVEN_FIELDS=unguarded` (:1482) — if the priced gap is small,
**don't build it**, and record that as the answer.

### 5. Interlock with #4406 — the seam already exists, extend it

Do **not** invent a new registry. `ctx.directCallTwins` (typed-this.ts :946,
`recordDirectCallTwin`) is already a map keyed `"<F>/<m>"` →
`{ twinName, params: ValType[], results: ValType[] }` — i.e. exactly the
"(fn, receiver-type, ret-type)" registry the brief asks for, minus a name.
`fillDirectCallTrampolines` (:1827) already **compares** a twin's recorded
`results` against the trampoline's and degrades to the legacy dispatcher on
mismatch rather than emitting an invalid module. That degrade path is the
safety net #4406 needs.

Return-type refinement is likewise already precedented: `refinedTwinReturnType`
(:1054) mints an **f64**-returning twin when the whole-program fixpoint
`ctx.numericFunctionNames` proves every return is numeric, and
`buildTypedThisForwardGuard`'s `boxTwinResult` (:339-351) handles the shim
that can no longer tail-call. **#4406 should follow this exact shape for
booleans**: add a `booleanFunctionNames` fixpoint beside
`numericFunctionNames` (`numeric-property-analysis.ts:1476`) and let
`refinedTwinReturnType` return `{kind:"i32", boolean:true}`. Note
`ctx.booleanPropertyNames` already exists for *properties* — the analysis
gap is *function returns*, not booleans in general.

Two things #4405 must not break for #4406:
1. Keep `refinedTwinReturnType` the **single** decision point. Its header
   (:1048-1052) records why: both consumers ask it, so they cannot disagree.
   Any new receiver-specialised variant must route its result type through
   the same function.
2. When Phase 3 adds a write-side variant, register it in the same
   `directCallTwins`-shaped map with its `params`/`results`, so #4406's
   call-site rewrite has one place to look.

### 6. Verification plan

Per PR:

1. **Flag off ⇒ byte-identical.** `sha256sum` the binary from §0's probe
   against base. Note the §4 caveat about what "base" means.
2. **Poison probe.** Corrupt the new lowering deliberately (e.g. emit
   `struct.get` of the wrong field index behind the flag) and confirm the
   acorn lane **fails** with the flag on and **passes** with it off. Entry
   (22) of #4157 is the cautionary tale: a slice was reported working while
   the measured helper was the wrong one. A green run with a poisoned path is
   proof the path is dead.
3. **Census delta**, flag on vs off, from Phase 0's instrument. Report the
   whole funnel (`asked → proven → inlined`), not the top line.
4. **Checksum 422** on the acorn self-parse; `success=true` and binary size
   reported.
5. **Scoped equivalence**: `npm test -- tests/equivalence.test.ts` plus
   `tests/dogfood/acorn.test.ts`. Do **not** run full test262 locally.
6. **Per-function profile** only after Phase 0 has re-established the
   baseline. Until then there is no committed 19.5× to beat (§1.5) — an
   unreferenced ratio is not evidence.

### 7. Risks

- **Duplicate-work risk is the big one.** A dev who reads only the issue body
  will rebuild `analyzeProtoMethodWriteOnce`. §1 exists to prevent that; make
  it the first thing the dispatch message points at.
- **File conflicts.** `typed-this.ts`, `receiver-flow-analysis.ts`,
  `fnctor-escape-gate.ts` and `property-access-dispatch.ts` are touched by
  #4406 and by the #4491 lever work. Phase 0 is additive (new file) and
  should land first to reduce the window.
- **Phase 2 grows the binary.** That is expected, not a regression, but it
  must be measured and stated — the standalone floor guards run in the
  `merge_group`, not on the PR.
- **`fctx.body` is NOT append-only** (#4157 entry 33's load-bearing finding).
  Any new emitter that assumes it can splice by index will be wrong.
- **Oracle ratchet** will fail any touched file that gains a raw `checker.*`
  call (§ Phase 1).

---

## Handoff state

**Senior dev, 2026-08-14.** Branch `impl-4405-receiver-spec`, pushed to
`origin` (= upstream `loopdive/js2`). Measured on that branch, base
`d98ea58a8`. Written mid-task because container restarts have destroyed
unpushed work repeatedly today.

### What landed (Phase 0, complete and measured)

`src/codegen/receiver-spec-census.ts` (new) + the five previously-silent
early returns promoted to named buckets, + `explainReceiverDecline()` in
`receiver-flow-analysis.ts` (diagnosis only, reached only under the census
gate). `loc-budget-allow` granted for `typed-this.ts` (+38): a decline
bucket has to be recorded where the decline happens.

Acorn standalone lane, both runs `success=true`, **1,408,321 B**, canaries
`2,3,4,5`, zero imports, ~108 s per compile. Note the spec's §0 figure of
1,157,936 B was on `recover/levers-integration`; this tree's base is bigger,
which is a base difference, not a regression.

**The census reproduces §1.6 exactly** — the same numbers, and the shape
histogram matches the spec's list term for term:

```
[receiver-spec] bucket:not-in-twin=5884   bucket:receiver-not-this=2346
[receiver-spec] shape: types$1=590 node=488 state=370 propaccess=134 prop=108
                       expr=64 refDestructuringErrors=48 elemaccess=44
                       this.type.<>=28 element=24 list=22 value=22 id=20
                       scope=20 this.input.<>=18 key=18 …
[proven-receiver] asked=4064 proven=244 inlined=88 declinedAfterProof=156
[typed-this] twins=488 declinedTwin=0 get=1366 set=98 compound=18 incdec=98
```

### The Phase-1 diagnosis — and it is NOT what §4 Phase 1 predicted

Splitting the 3,820 unproven receivers by whether the analysis ever looked at
them: **3,244 are bare identifiers it looked at and refused; 576 are
non-identifier shapes `provenReceiverClass` returns on before asking**
(`propaccess` 281, `elemaccess` 86, `this.type.<>` 62, `this.input.<>` 38,
`call` 35, …).

Of the 3,244, attributed to the pass that refused:

| reason | count | note |
| --- | ---: | --- |
| `no-verdict:var-init:ObjectLiteralExpression` | 1,361 | `types$1`=1,287 — **explicitly out of scope** (§4 Phase 1) |
| **`no-verdict:param`** | **1,240** | **the dominant addressable bucket** |
| `no-verdict:var-init:CallExpression` | 233 | pass 1d ran, `argumentClass` gave nothing |
| `no-verdict:var-init:ElementAccessExpression` | 175 | |
| `no-verdict:var-init:PropertyAccessExpression` | 130 | |
| `no-verdict:var-init:BinaryExpression` | 42 | |
| `no-verdict:var-init:Identifier` | 18 | |

`no-verdict:param` is led by exactly the receivers the spec names: `state`
434, `node` 243, `prop` 120, `expr` 112, `refDestructuringErrors` 68, then
`init`/`pat`/`base`/`conf`/`method`/`statement`/`ref`/`id` at 20–28 each.

**All three of the spec's prime suspects are refuted by measurement:**

1. `isConstLike` const-only — **already fixed on `main`**. Pass 1 admits
   `var`/`let` and leans on pass 3 demotion; the comment at
   `receiver-flow-analysis.ts:171-176` says so explicitly. The spec was
   written against `recover/levers-integration`, which predates that. Do not
   redo it.
2. `resolveLocalBinding` weak scope walk — contributes **zero**. Neither
   `ambiguous` nor `not-found` appears anywhere in the census. The `scope$1` /
   `node$1` rename worry does not materialise.
3. Bare assignment with no declaration — **zero**. `no-verdict:var-noinit`
   never fires.

### Root cause of the 1,240 (found, not yet fixed)

`calleeDeclaration` (`receiver-flow-analysis.ts:384`) returns early unless the
callee is a bare **identifier**:

```ts
const callee = call.expression;
if (!ts.isIdentifier(callee)) return undefined;
```

Every acorn prototype method is invoked as `this.parseStatement(node)` — a
`PropertyAccessExpression`. So pass 2 records **no observations at all** for
prototype-method parameters, and the final loop iterates `observations`, so an
unobserved parameter simply never gets a verdict. `state` / `node` / `prop` /
`expr` are not being *rejected*; they are never *asked about*.

The fix is small and reuses machinery pass 1c already built: resolve a
`this.<m>(…)` / `<protoAlias>.<m>(…)` / proven-receiver `<r>.<m>(…)` callee to
`methodBodies.get(`${cls}.${m}`)` and let pass 2 observe those call sites.
`enclosingThisClass` already supplies the `cls` for the `this.` form.

**Soundness note for whoever picks this up:** both consumers of a verdict
(`tryEmitProvenReceiverFieldGet`, and `tryEmitDirectTwinCall` at
`typed-this.ts:1641` which sets `guardedReceiver = true`) emit a `ref.test`
two-arm `if`, so an imprecise verdict costs a slow read and never a wrong
value. That guard — not the analysis — is what makes a missed call site
tolerable. It does **not** license dropping the guard (spec §2(b)).

### Phase 1 — CODE COMPLETE, NOT YET MEASURED (commit `f385d7dfe`)

Session ended before the acorn measurement run. **The code is written, typechecks,
and passes the scoped unit tests; the coverage claim is UNVERIFIED.** Do not
quote a coverage number from this branch — there isn't one yet. What exists:

- `optInFlagEnabled` in `src/perf-flags.ts` — the opt-in member of the tuned
  family (unset ⇒ **OFF**, shared off-tokens). `JS2WASM_RECEIVER_SPEC` uses it.
- `calleeDeclaration` resolves **property-access callees** via pass 1c's
  existing `methodBodies` map — the actual fix for the 1,240.
- The receiver of such a call is classified **round-independently** (`this` in a
  known method body, or a literal `new F()`), never through `argumentClass`.
  This is load-bearing: it fixes the observed-call-site set across rounds so an
  argument can only go unproven→proven, which is what keeps the fixed point a
  *least* one. Classifying through `argumentClass` lets a call site appear in
  round 3 and retract a verdict granted in round 1 — I started that way and
  backed it out; do not re-introduce it.
- **Poisoning** for call sites we therefore cannot see: `recv.m(…)` with an
  unclassifiable receiver, and any escape of a method slot out of callee
  position (`pp.m.call(…)`, `f(pp.m)`). Fails closed rather than leaning on the
  consumer's `ref.test`.
- Passes 1c/1d/2 now run as ONE fixed point (cap 4 rounds). **Flag OFF ⇒ exactly
  one round**, reproducing the original sequence — that is the byte-identity
  mechanism, and it is the thing to check first if flag-off identity fails.
- `analyzeReceiverFlow`'s passes split into named module-level functions rather
  than taking a `func-budget-allow`. Both budget gates pass with no allowance
  beyond the Phase 0 `typed-this.ts` one.

Scoped tests green: `issue-3685-receiver-flow`, `issue-3685-proven-receiver-calls`,
`issue-3683-typed-this-twin` — 36/36.

### Next steps, in order

0. **Measure Phase 1.** `JS2WASM_RECEIVER_SPEC=1 JS2WASM_RECEIVER_SPEC_STATS=1
   JS2WASM_PROVEN_RECEIVER_STATS=1 npx tsx .tmp/probe-4405.mjs` against the same
   command with the flag unset (~108 s each; `.tmp/probe-4405.mjs` and
   `.tmp/probe-4405-sha.mjs` are gitignored, recreate from the spec §0 snippet).
   Expect `reason:no-verdict:param` to fall from 1,240 and `proven` to rise off
   244. Then the flag-off sha256 identity check and the poison probe — **neither
   has been run**.

1. Extend `calleeDeclaration` to property-access callees (above). Expect the
   `no-verdict:param` bucket to fall and `proven` to rise off 244.
2. Re-measure the FULL funnel `asked → proven → inlined`, not the top line —
   the 156 declined-after-proof are `nofield:Node.*`, so extra proofs on
   `Node` receivers will convert at a poor rate until Phase 2 gives `Node` real
   slots. A proof that does not convert to an inline is not a win.
3. Only then the poison probe + flag-off sha256 identity.

### Ruled out / do not repeat

- `types$1` (590 shape hits, 1,287 decline records) can never be answered by
  `receiverClassOf`: it is an object literal, so no `__fnctor_*` struct exists.
  Out of scope by the spec, and now confirmed by measurement — it is 42 % of
  the identifier declines and will distort any "coverage %" that includes it.
- `gh` is not installed in this container and the GitHub REST API is refused
  (`403 GitHub access is not enabled for this session`), so **the PR could not
  be opened from here.** The branch is pushed; someone with API access needs to
  open it.
- The three `IR-FALLBACK` errors the probe reports (`function typeIdx parity
  mismatch` on `parse`/`parseExpressionAt`/`tokenizer`) are pre-existing on
  base — present in the very first baseline run before any edit. Not ours.
