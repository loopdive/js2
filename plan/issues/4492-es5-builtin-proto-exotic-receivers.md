---
id: 4492
title: "ES5 standalone: builtin-prototype methods on exotic/boxed/dynamic receivers (~103 tests across Array/String/Function.prototype)"
status: ready
sprint: current
created: 2026-08-15
updated: 2026-08-24
assignee: claude/es6-standalone-session
priority: high
horizon: m
feasibility: medium
task_type: conformance
area: codegen
es_edition: es5
goal: standalone-mode
related: [4444, 2175, 4161, 1461]
# (#4492 wave-5) Per-file rationale for each grant is in "## 2026-08-23 wave-5
# results" below, under "Gate grants".
loc-budget-allow:
  - src/codegen/object-runtime.ts
  - src/codegen/array-object-proto.ts
  - src/codegen/index.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/context/types.ts
  - src/codegen/native-strings.ts
  # (#4492 wave-6, 2026-08-24) The builtin-method-as-a-VALUE lane. Rationale in
  # "## 2026-08-24 wave-6" below, under "Gate grants".
  - src/codegen/proto-function-value.ts
  - src/codegen/object-proto-tostring.ts
func-budget-allow:
  - src/codegen/object-runtime.ts::ensureObjectRuntime
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  # +1 line: the initializer for the new `protoNamedWrittenMembers` field.
  - src/codegen/context/create-context.ts::createCodegenContext
---

# #4492 — ES5 builtin-proto methods on exotic receivers

## Problem (measured 2026-08-15, `.tmp/es5-standalone-clusters.ts`, fresh baseline)

Three sibling ES5 clusters share a receiver-shape root: `built-ins/Array/
prototype` (36) + `built-ins/String/prototype` (35) + `built-ins/Function/
prototype` (32) ≈ **103 tests**. Sample symptoms:

- Function.prototype.{call,apply,bind} this-binding on dyn receivers:
  `this["feat"] expected "kamon beyba", got undefined`, `obj.touched`
  families, `cannot read property 'length' of null` (bind on extracted fn).
- String methods on BOXED receivers (`new Boolean()`, `new Number()`)
  borrowed via `__instance.substring = String.prototype.substring` —
  answers `[object Object]` instead of coercing the receiver.
- Array generic methods: missing TypeErrors on frozen/sealed targets,
  `new Array()`-subclass-ish length coupling (`newArr.length` mismatches).
- Sputnik-era legacy shapes (`eval("1")` args, Math-as-receiver toString).

## Implementation Plan (fable, 2026-08-15) — triage-first

1. **Sub-bucket by RECEIVER SHAPE, not by method** (mandatory table here):
   (a) `.call/.apply` with dyn/`any` receivers, (b) borrowed methods assigned
   onto boxed primitives (the #2161-B1 wrapper-slot probe precedent —
   `new String(x)` receiver handling in coerceType's externref→AnyString arm
   was specced there; check whether it landed and extend the same pattern to
   `new Boolean`/`new Number` receivers), (c) generic Array methods on
   array-likes (post-#1461 residue), (d) TypeError-on-immutable-target
   enforcement, (e) legacy/eval-arg shapes (may route to runtime-eval lane).
2. Coordinate with the #2175 reflection lane (in-flight): the value-erased
   method-closure path is ITS substrate; this issue owns the RECEIVER
   COERCION inside those closures, not closure resolution itself. Skip any
   test whose failure is "method not resolved" — route those to #2175.
3. Largest bounded sub-bucket first; unit tests per fix; A/B baselines; zero
   pass→non-pass on all three scoped filters.

## Triage (claude/es6-team-reflection, 2026-08-15) — step 1 DONE.
## STOP before implementing: most of this issue is already owned.

### Re-measured on HEAD, not inherited

Candidate list (`.tmp/es5-recv-cluster.ts`, standalone jsonl `734fab88`)
reproduces the plan's **103** exactly. Re-ran all 103 through
`runTest262File(..., "standalone")` on `9e17d34f3` + the uncommitted #2175 S3b
work: **3 pass, 97 fail, 3 CE**.

**Of the 100 non-passing, 23 are a local-driver artifact** — `JS2WASM_EVAL_ENGINE=quickjs
but the quickjs provider is not built`. Those are eval-dependent files a CI
runner (which builds the provider) will classify differently; I cannot judge
them from this worktree and did NOT count them. **Real failures: 77.**

| dir | real failures |
|---|---|
| `built-ins/Array/prototype` | 34 |
| `built-ins/String/prototype` | 32 |
| `built-ins/Function/prototype` | 10 |
| `annexB/built-ins/String` | 1 |

### Receiver-shape sub-buckets (the plan's mandatory table)

| bucket | count | owner |
|---|---|---|
| String method on a generic/TRANSFERRED receiver skips `ToString(this)` → `"[object X]"` | ~13 | **#2742 (in-progress, CLAIMED)** + **#4207 (ready, assigned)** |
| `Array.prototype.filter` step 9-b family (`15.4.4.20-9-b-*`) | **11** | **unowned — the real #4492 slice** |
| remaining Array generic/array-like + immutable-target TypeErrors | ~23 | #4492, after the filter slice |
| `Function.prototype.{call,apply,bind}` this-binding | 10 | #4492 (not yet gate-checked against other lanes) |
| method not resolved / codegen refusal | 2 | route to #2175 per plan step 2 |

### The blocker the plan did not anticipate

`node scripts/pre-dispatch-gate.mjs 2742` → **STOP**: `#2742 is CLAIMED by
ttraenkler/codex-es5-string (branch codex/2742-es5-string-generic-receiver)`.
The String cluster — the largest, and the one whose symptom this issue's own
problem statement quotes (`__instance.substring = String.prototype.substring`
→ `[object Object]`) — is being implemented right now by another lane, and is
additionally covered by **#4207** ("a builtin prototype method reached by
property TRANSFER skips both the [[Class]] brand check and the primitive-receiver
coercion — 70 ES5 standalone files", assignee `ttraenkler/W28`), plus #3254,
#4056, #4095.

The transfer shape I isolated is #4207 verbatim: `S15.5.4.13_A3_T4` does
`this.slice = String.prototype.slice` on a user object whose `toString` returns
`"undefined"`, and we answer `"[object Object]"`. **Do not implement it here.**
Re-scope #4492 to exclude the String bucket, or fold that half into #2742/#4207.

### The one bounded, unowned slice: `Array.prototype.filter` 9-b (11 files)

#1130 / #1358 / #1461 are all `done`, so this is exactly the "post-#1461
residue" the plan names. Root cause, from `15.4.4.20-9-b-3.js`:

```js
var obj = { 2: 6.99, 8: 19 };
Object.defineProperty(obj, "length", { get() { delete obj[2]; return 10; }, configurable: true });
var newArr = Array.prototype.filter.call(obj, () => true);
// spec: the length getter runs first (deleting index 2), then HasProperty per
// index → [19], length 1.   we answer length 0.
```

### CORRECTION — the root cause above is WRONG. Measured, then re-measured.

My first reading of this cluster, stated in an earlier revision of this section
and reported to the coordinator, was: *"index enumeration over a sparse
array-like `$Object` is wrong when the `length` getter mutates the object during
step 2."* **That is wrong on both counts.** It is not enumeration, and mutation
is irrelevant. Probes `.tmp/f1.js`–`.tmp/f7.js`, standalone:

- **Data-property `length` works.** `{2:6.99, 8:19, length:10}` →
  `Array.prototype.filter.call(o, ()=>true)` returns **2**, correct. `HasProperty`
  and index reads on a plain `$Object` array-like are fine (`2 in o`, `8 in o`,
  `o[8] === 19` all correct).
- **Accessor `length` yields 0, mutation or not.** A getter that merely counts
  calls and returns 10 — no `delete` anywhere — fails identically.
- **The decisive probe** (`.tmp/f7.js`) counts getter invocations around the
  call: a direct `o.length` before → getter runs (hits 1, value 10); the
  `filter.call` → **hits unchanged**; a direct `o.length` after → getter runs
  (hits 2, value 10). So the accessor is installed correctly, works before and
  after, and **`filter` never performs `Get(O,"length")` on this receiver at
  all**; it obtains a length by some other path that answers 0 for an accessor.

`__extern_length`'s `$Object` arm is NOT the culprit — it already routes through
`__extern_get` (`object-runtime-enumeration.ts:474-527`, "#2036 — array-like
`$Object` arm: ToLength(Get(O,"length"))"), which is accessor-aware. So either
filter does not use `__extern_length` for this receiver, or it reads the raw
`$PropEntry` value slot (empty for an accessor ⇒ 0) somewhere in its own length
acquisition.

**Why the mutating-getter framing was seductive and wrong:** every test in the
family *does* have a mutating getter, because that is how the 9-b step tests
observe evaluation order — so the mutation was present in 100% of the failures
and looked causal. It is a confound, not the cause. Removing it does not fix the
test; removing the *accessor* does.

### SECOND CORRECTION — it is not the length acquisition either. No code landed.

I took the "route filter's length through the #2036 accessor-aware [[Get]]"
step, implemented it, and **disproved it**. The change is reverted; the tree
carries no code from this attempt. What the probes establish:

1. **The receiver is a CLOSED-SHAPE STRUCT, not a `$Object`.** Decisive
   discriminator (`.tmp/f8.js`): identical content and an identical accessor,
   built two ways. As an object LITERAL (`{2:6.99, 8:19}` → closed struct, WAT
   shows `struct.new 45` with `$__sget_2`/`$__sget_8` getters) the length getter
   ran **0** times and `filter` returned **0** elements. Built by dynamic writes
   (`b={}; b[2]=…; b[8]=…` → real `$Object`) the getter ran **1** time and
   `filter` returned **2**. The `$Object` arm was always right; the receiver
   never reached it.
2. **`__extern_get` is NOT the gap.** `.tmp/f9.js`: a computed `a["length"]`
   (which routes through `__extern_get`) invokes the accessor and returns 10 on
   the closed struct. So the accessor IS visible to `__extern_get`.
3. **`__extern_length` is NOT the gap either.** The inline array-like loop does
   call it (func 169, confirmed by index→name mapping). I widened its
   non-`$Object` fall-through to run the same `ToLength(Get(O,"length"))`, then
   replaced that branch with a **sentinel constant 7** — and `filter` still
   returned 0 elements. A length of 7 would have visited index 2 and produced 1.
   **The result is 0 for any length**, so the ELEMENT reads are empty and length
   is not what is failing.

**Narrowed target (this is where the next attempt should start).**
`fillExternArrayLikeStructArms` (`object-runtime.ts:9145`) only mints the
integer-index arms for a closed struct it accepts as an array-like CANDIDATE,
and candidacy requires the struct to declare a **`length` FIELD**
(`fields.findIndex(f => f.name === "length" && …)`). An object literal whose
`length` arrives via `Object.defineProperty` has no such field, so no numeric
arms are minted and `__extern_get_idx`/`__extern_has_idx` see none of its
integer-named fields — the borrowed generic then iterates over nothing. This
matches every observation, including why `{2:6.99, 8:19, length:10}` (a real
`length` field ⇒ a candidate) filters correctly.

**Caveat on the reverted change, stated so it is not lost:** the
`__extern_length` widening may still be *needed* (a closed struct's accessor
`length` should not read 0), but the experiment could not confirm it — the
observable result is 0 whatever the length is. I reverted rather than keep an
unvalidated behaviour change that demonstrably fixes nothing on its own; it
should be re-made together with the candidate-gate fix, where it can actually be
measured.

**Method note for the next lane:** the mutating-getter framing (correction 1) and
the length-acquisition framing (correction 2) were both inferred from what the
tests are *about* rather than from a differential probe. The probe that settled
it each time was the same shape: hold the data constant and vary ONE
representational choice (literal vs dynamic build; real length vs sentinel).

### THIRD attempt — candidacy widening. Implemented, did NOT land. Reverted.

One timeboxed attempt at the narrowed target. **Both source files are reverted
to base; this slice has landed no code.** What was tried and what it proves:

**Change (2 sites, exactly as scoped):**
1. `fillExternArrayLikeStructArms` (`object-runtime.ts`) — admit a closed struct
   with integer-named fields as an array-like candidate even with **no `length`
   field**, and skip minting an `__extern_length` arm for such a candidate (its
   length must come from the generic fall-through, since a `defineProperty`
   accessor cannot be a struct field).
2. `__extern_length` (`object-runtime-enumeration.ts`) — re-made the
   `ToLength(Get(O,"length"))` widening on the non-`$Object` fall-through, so
   those candidates get an accessor-aware length. (`Instr` builders are
   factories, not shared arrays — the double-remap hazard.)

**The candidacy gate was genuinely the blocker, and the widening genuinely
opens it.** Instrumented, the object literal now reaches the loop and is
admitted: `[cand] __anon_0 lenIdx=-1 numeric=2 vecSub=false`. Before the change
it was rejected at `if (lengthFieldIdx < 0) continue;`.

**But the observable behaviour did not move at all** — `.tmp/f8.js` still
answers `filter` → 0 elements with 0 getter invocations, identical to base. So
admitting the candidate and minting its index arms is **necessary but not
sufficient**: something downstream of the arms still reads nothing. The
remaining unknown is why `__extern_get(<closed struct>, "length")` does not
invoke the expando accessor from `__extern_length`'s fall-through, when the
SAME lookup through a computed `a["length"]` does (`.tmp/f9.js`, getter runs,
returns 10). Those two facts are not yet reconciled and that is where a fourth
attempt should start.

**Why this is reverted rather than banked as partial progress:** on its own the
candidacy widening changes emitted code for every closed struct with integer
fields (new index arms, changed byte output) while fixing nothing measurable —
the same "unvalidated change that fixes nothing" I declined to keep for the
`__extern_length` widening in attempt 2. Keeping it would trade real regression
risk for no test movement.

**Cost note:** three attempts across one budget window for an 11-file cluster.
Each attempt disproved a plausible mechanism and narrowed the target, but the
transfer cost of that knowledge is low compared to the archaeology cost of
re-deriving it — the probes are all preserved (`.tmp/f1.js`–`.tmp/f9.js`,
runnable via `.tmp/p.ts --file`), and the two source edits are reconstructible
from this section in minutes. Recommend a lane that already owns the
closed-struct / array-like machinery take it from here rather than a fourth
attempt from this lane.

**Scope note:** this is still clean of #2742/#4207 territory (it is length
acquisition, not receiver coercion), so the slice assignment stands.

## Validation

`TEST262_TARGET=standalone TEST262_PATH_FILTER="built-ins/Array/prototype|built-ins/String/prototype|built-ins/Function/prototype" pnpm run test:262`
— baseline ~103 non-pass in the ES5 bucket (the filter also runs ES6+ files;
diff per-file against the fresh baseline, not by count). gc-lane control.

## Coordinator routing note (fable, 2026-08-15)

The filter 9-b banked state above is CROSS-REFERENCED to the #4491 lane's
in-flight computed-string-key read-path fix: `a["foo"]` missing where `a.foo`
hits (arrays) and this cluster's `__extern_get(<closed struct>, "length")`
not invoking the expando accessor while computed `a["length"]` does are
likely the same `__extern_get` arm-ordering family on closed shapes. The
#4491 lane should test the banked f8 probe after its read-path commit; if it
doesn't flip, the candidacy widening (necessary-but-insufficient, edits
reconstructible from the section above) composes with whatever it finds.
Reflection lane redirected to P1/P2 (its substrate).

## 2026-08-19 re-census + dispatch

Fresh standalone baseline (`test262-standalone-current.jsonl`, 48,735 entries,
fetched 2026-08-19 04:52): standalone ES5 is **8,506 / 9,029 (94.2 %)** with
**523 non-passes** (495 fail, 24 compile_error, 4 compile_timeout). Earlier
figures in this file predate that and should be read as history.

This issue's lane in the 2026-08-19 6-way fan-out: **73 rows — String / RegExp / Number / Boolean / Error / Date / global**.
Umbrella + full partition: #4163.

The residue is a **long tail** — the largest single error signature across all
523 rows is 13. Expect many small root causes, not one lever.

Local gate for this lane: 551 locally-verified-passing standalone ES5 tests must
stay at 551/551. Reproduce with the `--standalone` flag (without it you measure
the JS-host lane, a different and much worse corpus at 84.8 %).

**eval-rooted rows cannot be validated on the dev Mac** — CI's QuickJS eval tier
needs clang-18 (see #4163 for the full toolchain finding); record them as
blocked rather than chasing them.

## 2026-08-19 landed slice — 4 rows, and two findings worth more than the rows

Commits `df8d071`, `a047a5f`, `58b8635` on `es5-string-regexp-misc`.
**Lane 1 → 5 of 73, guard 551/551 (zero pass→fail), `target=standalone`.**
Base measured by reverting the touched files to `f7df34f1` in the same tree, so
the delta is a real before/after, not an inherited figure.

| commit | rows | what |
| --- | ---: | --- |
| `df8d071` | +1 | tag the four exotic builtin prototypes in `Object.prototype.toString` (`built-ins/Number/prototype/S15.7.3.1_A2_T2`) |
| `a047a5f` | +1 | `String.prototype.trim` gets its real reflective body (`.../trim/15.5.4.20-2-43`) |
| `58b8635` | +2 | `new String(<array>)` performs the real ToString, host-free (`S15.5.2.1_A1_T9`, `_A1_T19`) |

QuickJS-blocked in this lane: **2** rows (`built-ins/global/S10.2.3_A1.1_T3`,
`S10.2.3_A1.2_T3`).

### Finding 1 — `delete <NativeProto>.<member>` is a silent no-op in standalone

Returns `true`, and `hasOwnProperty` still reports `true` afterwards. Gates
**~8 rows** across `RegExp` A9 ×3, `Number/prototype/S15.7.3.1_A2_T1`,
`Number/prototype/S15.7.4_A1`, `Number/S15.7.2.1_A4`,
`String/prototype/S15.5.4_A1` and `_A3`. This is a coherent standalone gap with
a single root cause and is the largest identified lever left in this issue's
area — larger than anything the three landed commits moved.

### Finding 2 — a silent wrong answer, found, fixed, and deliberately NOT shipped

`x.toString()` on a plain object literal returns a **constant** `"[object
Object]"` (`src/codegen/expressions/call-receiver-method.ts:3259`), while
`String(x)` on the same receiver goes through the real path and is correct. So
the two disagree, and the fold is wrong whenever the receiver has an own or
inherited `toString`.

A verified fix exists but moved **zero** rows in this lane, so the lane reverted
it rather than carry unmeasured regression risk into the push. That is the right
call for a conformance lane and the reasoning is recorded here so the finding is
not lost. Patch kept at
`/Users/thomas/.claude/jobs/f2c14fbe/tmp/tostring-fold.py` (session scratch — not
durable; re-derive from the line reference above if it has aged out).

**This is a correctness bug independent of test262 scoring** — a program whose
object defines `toString` gets the constant instead of its own method — and
should be fixed on its own merits, with its own before/after, rather than
smuggled into a conformance batch.

## 2026-08-21 wave-2 census + Implementation Plan (protos lane)

Fresh corpus on the merged tree: the **builtin-prototypes lane is 96 rows** —
`String.prototype` 22, `Array.prototype` 20, `RegExp.prototype` 9,
`language/literals/regexp` 4, plus Number/Boolean/Date/Error/global/annexB
singles and 4 boxed-`valueOf` rows (#4582). Lane list:
`.claude/worktrees/es5w2-protos/.tmp/lane-tests.txt`.

Top signatures: `Unsupported dynamic regular expression pattern` (3),
`newArr.length SameValue` (3), async-harness `[object Object]` (3),
`Cannot access property on null or undefined` (2), inherited-index reads (2),
`__split[N]` (2).

### Plan (ordered)

1. Re-baseline lane + guard; prototype-write corpus baseline isolated.
2. **#4582 boxed `valueOf`** — the spec records a REVERTED wrong-answer attempt.
   Read it first: verify what param 1 actually holds on the boxed-brand glue
   before trusting the documented ABI, and note String never reaches the shared
   fallback (`emitStringProtoMemberBody` claims it and refuses). A wrong value
   is a failure; the refusal stays until the value is proven right. 4 rows.
3. **`delete <NativeProto>.<member>`** (#4492 finding, ~8 rows): `936f382`
   fixed the INDEX side via `protoIndexOwnViewSubstituteInstrs`; the NAMED
   member side needs the same three-op agreement (has/gOPD/delete).
4. **Array inherited-index + borrowed-HOF rows**: #4556 buckets B/H — the
   documented `proto-index-store.ts` boundary. Attempt only with the consult-
   order asymmetry in mind (`__extern_method_call` honours overrides for
   memberless builtins, ignores them for membered ones — #4556 records it).
5. **RegExp dynamic-pattern rows**: classify first; "Unsupported dynamic
   regular expression pattern" may be an engine gap, not a dispatch bug.


## 2026-08-21 wave-2 corrections (protos lane, measured)

- **Finding 1 is STALE**: 3 of its ~8 `delete <NativeProto>.<member>` rows
  already pass at the wave-2 branch point (`Number/prototype/S15.7.3.1_A2_T1`,
  `S15.7.4_A1`, `String/prototype/S15.5.4_A3`) — `936f382` landed after that
  census. The lever was really 2 open + 3 accessor-blocked; **both open rows are
  now closed** (`7b8410`: a `DeleteExpression` parent arms `protoMemberDirty`,
  which the member-value-use carve-out at `array-holes.ts:559` wrongly withheld —
  the syntactic path cannot record a deletion, and `__nproto_hasown`'s
  `$memberCsv` fallback resurrected the name).
- **The RegExp A9 rows (3) are BLOCKED on the accessor tier, not open**:
  `global`/`ignoreCase`/`multiline` are getter-kind; the companion seeder skips
  accessors deliberately, and `native-proto.ts` records that seeding them
  regresses the §22.2.6 `SameValue(this, %RegExp.prototype%)` identity read via
  a mechanism its own doc marks UNIDENTIFIED. Needs the accessor tier as a
  separate slice.
- The census contradiction (`S15.5.4_A3` passing while `_A1` failed on identical
  code) is explained: A3 reads `Object.prototype` as a value one line earlier
  and armed the flag by accident.
- New three-op disagreement found and deliberately not shipped → **#4596**
  (gOPD compile-time synthesis ignores a runtime delete).

## 2026-08-21 — bucket B/H survey (protos lane; surveyed, deliberately not attempted)

The remaining Array rows split three ways, none a small slice:

- **(a) live-prototype element visibility** (`Array.prototype[1] = 1` then
  `concat`/`toString`/`toLocaleString`) — the documented `array-holes.ts`
  boundary: a flat vec cannot re-check HasProperty against a live prototype per
  element. Exactly what `936f382` measured and left.
- **(b) heterogeneous-array value representation** (`[0].concat(obj, arr, -1,
  true, "NaN")` returns NaN for the object element) — value-rep lane, not a
  prototype problem.
- **(c) `x.concat = Array.prototype.concat; x.concat(…)`** — `concat` has no
  reflective Array body, and the refusal is INCONSISTENT: the `.call` form says
  the honest "not yet callable as a value in --target standalone" while the
  stored-slot form says a misleading "Cannot access property on null or
  undefined". Minimum fix: make the stored-slot form reach the same honest
  refusal.

The consult-order asymmetry (Finding: `__extern_method_call` honours an
override for `join` but not `toString`) was NOT touched by any wave-2 change.

## 2026-08-23 wave-5 census (lead sweep on campaign HEAD, fresh bundle+adapter)

Live failing rows in this issue's territory, all re-verified failing by the
lead's own sweep (`.tmp/sweep-wave4b.jsonl`). Two halves:

**String receivers / ToPrimitive on objects (16):**

```
built-ins/String/S15.5.1.1_A1_T9.js        Cannot convert object to primitive value
built-ins/String/S15.5.1.1_A1_T8.js        Array.prototype.toString override ignored
built-ins/String/S15.5.2.1_A1_T8.js        Function.prototype.toString override ignored
built-ins/String/S15.5.2.1_A1_T11.js       new String(__obj) == "true..."
built-ins/String/S15.5.5.1_A5.js           new String("ABCABC")
built-ins/String/prototype/constructor/S15.5.4.1_A1_T2.js   is not a constructor
built-ins/String/prototype/replace/S15.5.4.11_A1_T9.js      {valueOf, toString:void 0}
built-ins/String/prototype/replace/S15.5.4.11_A1_T5.js      replace(null, Function())
built-ins/String/prototype/slice/S15.5.4.13_A1_T5.js        Function.prototype.toString unimplemented
built-ins/String/prototype/slice/S15.5.4.13_A3_T4.js        instance.slice(0,100)
built-ins/String/prototype/substring/S15.5.4.15_A1_T5.js    Function.prototype.toString unimplemented
built-ins/String/prototype/split/instance-is-math.js        "[object Math]"
built-ins/String/prototype/split/argument-is-regexp-and-instance-is-number.js
built-ins/String/prototype/split/separator-regexp-limit-string-via-eval.js
built-ins/String/prototype/trim/15.5.4.20-2-51.js           trim.call(argObj)
built-ins/String/prototype/concat/S15.5.4.6_A2.js           concat with 128 arguments
```

**Boxed-primitive receivers (7):**

```
built-ins/Number/15.7.4-1.js                     "[object Object]" vs "[object Number]"
built-ins/Object/S15.2.1.1_A2_T11.js             n_obj.constructor
built-ins/Object/S15.2.2.1_A2_T7.js              n_obj.constructor
built-ins/Object/S15.2.2.1_A2_T5.js              n_obj.getFullYear() (boxed Date)
language/expressions/object/S11.1.5_A2.js        {prop: new Boolean(true)}
language/function-code/10.4.3-1-103.js           (5).x == 5
language/function-code/10.4.3-1-104.js           (5).x === 5
language/function-code/10.4.3-1-106.js           typeof (5).x
```

Note the recurring sub-root worth measuring first: **an object's own
`toString`/`valueOf` override is not consulted by the String conversion
path**, which would explain the `_A1_T8`/`_A1_T11`/`S11.1.5_A2` group in
one fix. `Function.prototype.toString is not yet implemented in --target
standalone` is a distinct, explicit gap (2 rows here, more elsewhere) —
implementing it is in scope for this lane if the measurement supports it.
`is not a constructor` rows belong to the builtin-as-value family — check
whether a sibling lane owns them before fixing.

## 2026-08-23 wave-5 results (dev-4492, branch `issue-4492-wave5`)

Worktree `/home/user/js2wasm/.claude/worktrees/agent-a52996008417c674b`, based on
campaign HEAD `c42bdbe3e`. Bundle + quickjs adapter rebuilt in-worktree before
any measurement (the adapter cache MISSED and rebuilt, so the eval tier is this
tree's compiler, not the shared 8-day-old artifact).

### The census's named sub-root is FALSE AS STATED — measured, then narrowed

The census asks to measure "an object's own `toString`/`valueOf` override is not
consulted by the String conversion path" first. It is not true in general:
`String({toString(){…}})`, `String({valueOf(){…}})` and the object-returning-
`toString`→`valueOf` fall-through **all already pass** on `c42bdbe3e`
(`.tmp/probes/t1.js`). What is true is much narrower, and the narrowing is what
made the fix tractable. Measured in ONE module (`.tmp/probes/t6.js`), with
`f1.toString = function(){ return "OWN_F_TS" }`:

| spelling | `f1` (own toString) | `f2` (plain) |
| --- | --- | --- |
| `f.toString()` | `OWN_F_TS` | `function f2() {}` |
| `"" + f` | `OWN_F_TS` | `function () { [native code] }` |
| `` `${f}` `` | `[object Object]` | — |
| `String(f)` | `[object Object]` | `[object Object]` |

**One value, four renderings.** `+` was right because #4491's
`emitAddOrdinaryToPrimitiveResidue` runs a REAL runtime §7.1.1.1 walk
(`__extern_get` + `__call_accessor_get`) — and that residue is deliberately
scoped to the `+` operator. Every other dynamic spelling lands on
`__any_to_string`, whose object terminal is the literal `"[object Object]"`. So
the defect is not "overrides are ignored", it is "the ONE place that resolves an
override at runtime is reachable from ONE operator".

**Method note, because it cost two probes:** every one of these differences is
MODULE-SENSITIVE. `f2.toString()` answers the source text in a 5-line module and
`"SHIFTED"` in a 50-line one; `String(new F())` is wrong until the module
contains a single `"toString" in inst`. Reading any of these off a multi-case
probe attributes the wrong cause — the isolation rule (methodology 3) is not
about compiler state here, it is about the compiler's own arming flags.

## Root cause — four, in the order they were found

1. **`Function.prototype.toString` and `Object.prototype.valueOf` had no
   reflective body.** `makeGlue` (array-object-proto.ts) wires none for those
   families, so every route that reifies them as a VALUE minted the #2984
   Phase-2 catchable-TypeError closure. `built-ins/String/prototype/slice/
   S15.5.4.13_A1_T5` and `.../substring/S15.5.4.15_A1_T5` fail on exactly those
   two messages, in that order — fixing `toString` alone moves the failure to
   `Object.prototype.valueOf is not yet implemented`.
2. **ToString of a CALLABLE never reached §20.2.3.5.** `__any_to_string`'s
   terminal is `Object.prototype.toString`'s answer, which §20.2.3.5 says a
   function must never get.
3. **A `toString`/`valueOf` installed on a PROTOTYPE is invisible to every
   compile-time dispatcher.** `__call_valueOf`/`__call_toString` are keyed by
   struct TYPE; `F.prototype.toString = …` and
   `Function.prototype.toString = …` land in the runtime prototype bag.
   `__extern_get` walks that bag; nothing in the ToPrimitive path asked it.
4. **A boxed wrapper's `[[PrimitiveValue]]` short-circuit ran BEFORE the
   §7.1.1.1 walk.** §7.1.1.1 reads `Get(O, "valueOf")`, and an own slot wins
   over `String.prototype.valueOf` — so
   `var s = new String("ABCABC"); s.valueOf = function(){ return "ed" }; s == "ed"`
   was false for EVERY ToPrimitive consumer at once.

## Fix

| commit | what |
| --- | --- |
| `fefaa9ab4` | §20.2.3.5 `Function.prototype.toString` + §20.1.3.7 `Object.prototype.valueOf` reflective bodies (`function-proto-to-string.ts`, `object-proto-value-of.ts`, wired in `makeGlue`); the CALLABLE arm spliced onto `__any_to_string` (`callable-any-to-string.ts`) |
| `c4e1d7c91` | one shared runtime §7.1.1.1 walk (`ordinary-to-primitive-probe.ts`), used by the callable arm AND by a new prototype-aware TAIL on `__class_to_primitive` |
| `6811828f5` | the wrapper `[[PrimitiveValue]]` short-circuit gated on "no own valueOf/toString" (`to-primitive-wrapper-slot.ts`), plus `.length` / `w[i]` moved off `__to_primitive` onto the bare `__wrapper_string_value` slot probe |

Three deliberate design choices worth carrying forward:

- **The walk is ONE builder, not a third copy.** `ordinary-to-primitive-probe.ts`
  is what both new call sites use, so the `+` residue's answer and the ToString
  answer cannot drift the way the four renderings above did.
- **`null` is not an accepted primitive result.** In standalone `undefined` and
  `null` are the same null externref, and the module already contains BOTH
  renderings of that one value (`normaliseToString` says `"undefined"`, the
  #4621-D raw-null arm says `"null"`). Picking either would make the walk
  disagree with one of them for a value it cannot distinguish, so it declines.
- **Widening ToPrimitive forced `.length` off it.** `new String("ABCABC").length`
  became **2** the moment the override was honoured — §22.1.4.1 fixes `length`
  at construction. `__to_primitive` had only ever been standing in for the slot
  read ("reads the slot first", its own comment); the two stopped being the same
  operation and had to be separated. Same for the §10.4.3.5 index read. Both are
  pinned as regression guards.

### Gate grants (frontmatter, per-file rationale)

- `src/codegen/object-runtime.ts` (+7 LOC) and
  `ensureObjectRuntime` (func budget): the `[[PrimitiveValue]]` arms were
  extracted to `to-primitive-wrapper-slot.ts` to keep the god-file growth to the
  call sites; +7 is the `__wrapper_string_value` identity arm plus the deps
  literal. `ensureObjectRuntime` is a 5.5k-line function no slice of this size
  can split further.
- `src/codegen/array-object-proto.ts` (+10) — two `??` arms in `makeGlue`'s
  ladder (Function/toString, Object/valueOf); the bodies live in their own files.
- `src/codegen/index.ts` (+10, `generateModule`/`generateMultiModule`) — one
  `fillCallableAnyToStringArm` call plus its comment on each of the two
  finalize paths.
- `src/codegen/property-access-dispatch.ts` — the `.length` slot-read switch is
  net-negative code with a longer comment.
- `src/codegen/context/types.ts` (+16) — one new field,
  `protoNamedWrittenMembers`, and the doc explaining why `protoNamedDirty` alone
  cannot gate a ToPrimitive consult (the harness prelude sets it in nearly every
  test262 module). A context field has to live in the context type.
- `src/codegen/native-strings.ts` (+16) — two exported helper-KEY constants
  (`ANY_TO_STRING_HELPER`, `EXTERN_TO_STRING_HELPER`) plus their doc. They live
  here because this file is the engine-owned home of that vocabulary under the
  #2108 gate; spelling the names anywhere else is the drift that gate measures.

No `coercion-sites-allow` was needed, and the reason is worth keeping: the first
cut of `callable-any-to-string.ts` hand-rolled its own boxed-number / i31 /
boxed-boolean → string matrix and the #2108 gate caught it
(`number_toString 0→1, __any_to_string 0→1`). The fix was not an allowance but a
SELF-CALL back into `__any_to_string` on a value already proven primitive — which
removes the fourth copy of the §7.1.17 cascade, inherits the `$undefined`-
singleton and i31 arms for free, and terminates by construction (the recursive
argument is non-callable, so the arm's own guard fails on re-entry).
`native-strings.ts` now exports `ANY_TO_STRING_HELPER` so the lookup key has one
spelling in the file that owns it.

## Handover — NOT this lane's row

`built-ins/String/prototype/constructor/S15.5.4.1_A1_T2.js` is
`var __constr = String.prototype.constructor; new __constr("choosing one")` — a
builtin CONSTRUCTOR read as a value and then `new`'d ("TypeError: is not a
constructor"). That is the builtin-as-value family, **dev-4515's lane**; nothing
in this change-set touches constructor reification, and it did not move.

**Re-verified 2026-08-24 rather than assumed**, because #4515's C1 cluster has
since landed on `main` and this branch carries it: on the after arm the row still
reports the identical `TypeError: is not a constructor`. So C1 did not close this
spelling. Back to #4515 with that evidence.

## Test Results — wave-5 verification floor (dev-4492, runs executed 2026-08-23/24)

Branch `issue-4492-wave5-cont`, worktree
`/home/user/js2wasm/.claude/worktrees/agent-a49a0d0d70faf5d03`. The container
restart killed the original lane; the four commits were recovered onto this
branch from `d47ae4583` and `origin/main` `f6e094cdb` was merged in cleanly (no
conflicts) BEFORE any measurement below. Every figure here is from a run
executed in this worktree — nothing is inherited.

### Arm separation, proved rather than asserted

The eval adapter is a js2wasm-compiled artifact whose cache key hashes the
compiler BUNDLE, so a stale bundle yields a self-consistent cache HIT with a
weeks-old compiler. Both arms were rebuilt (`pnpm run build:compiler-bundle` +
`build-quickjs-eval-provider`) and reported **cache MISS**, with distinct keys:

| arm | bundle hash | adapter key |
| --- | --- | --- |
| after (`HEAD`) | `41adcd1b2b8d58b8` | `c2de6d0184cddb5d` |
| base (src reverted to `f6e094cdb`) | `27deb1cc9f8a236c` | `70afda182fdbfd59` |

The base shards' own banner line confirms `adapter key 70afda182fdbfd59` was the
one in use, so neither arm was measured with the other's compiler. Restoring the
after arm afterwards reproduced key `c2de6d0184cddb5d` as a cache HIT — i.e. the
restored tree is bit-for-bit the tree that produced the after numbers.

The revert was checked with `git diff HEAD --stat -- src` = **15 files** before
the base arm and **0** before the after arm. `git diff --stat` alone is the wrong
detector here and would have hidden a partial restore: `git checkout <commit> --
<paths>` writes the INDEX too, so ten of the fifteen files were invisible to it
(it listed only the five deleted new files).

### Sweep scope — 2,005 rows per arm, and why it is this size

`--target standalone`, `runTest262File` per row, `SWEEP_TIMEOUT=120000`.

Kept in full: `built-ins/String` (1,223), `built-ins/Number` (340),
`built-ins/Boolean` (51), `built-ins/Function/prototype/toString` (80),
`built-ins/Object/prototype/valueOf` (20) + `.../toString` (41),
`built-ins/Object/S15.2.*` (49), `language/function-code/10.4.3-1-*` (200),
plus `language/expressions/object/S11.1.5_A2.js`.

Dropped (505 rows): the rest of `built-ins/Object/prototype`, the rest of
`built-ins/Object` top-level, the rest of `language/function-code`, and
`language/expressions/object` top-level — wide and not reachable from this diff.
The two `Object/prototype` subdirs and the `10.4.3-1-*` family were deliberately
KEPT against a wider drop proposal: `fefaa9ab4` wires the very methods the first
two test, and `6811828f5` changes exactly when a wrapper's `[[PrimitiveValue]]`
short-circuit fires, which is what the third exercises. A scope cut that removes
the directory testing one of your own fixes is deleting the evidence.

### Before / after

| arm | pass | fail | compile_error |
| --- | --- | --- | --- |
| base | 1,748 | 241 | 16 |
| after | **1,753** | 236 | 16 |

**Net +5, regressions 0.** The 16 compile errors are the SAME 16 files on both
arms (standalone RegExp/`matchAll` refusals, unrelated to this change), and
**zero rows on either arm carry a `timeout` error** — so the contention trap
that manufactured false flips elsewhere this session did not touch these numbers.

### Flip list (all 5 re-run SERIALLY on both arms, one file at a time)

| test262 row | base | after |
| --- | --- | --- |
| `built-ins/String/S15.5.2.1_A1_T8.js` | `new String(fn)` = `[object Object]` | pass |
| `built-ins/String/S15.5.2.1_A1_T11.js` | `new String(__obj)` = `[object Object]` | pass |
| `built-ins/String/S15.5.5.1_A5.js` | own `valueOf` ignored, `==` saw `ABCABC` | pass |
| `built-ins/String/prototype/slice/S15.5.4.13_A1_T5.js` | `Function.prototype.toString is not yet implemented` | pass |
| `built-ins/String/prototype/substring/S15.5.4.15_A1_T5.js` | same refusal | pass |

Root ↔ flip mapping: root 1 (missing reflective bodies) closes the two
`_A1_T5` rows; roots 2+3 (callable ToString + prototype-installed method)
close `_A1_T8`/`_A1_T11`; root 4 (wrapper slot gating) closes `S15.5.5.1_A5`.

### Pins

`tests/issue-4492-wave5.test.ts`, read off vitest's own summary line (never the
exit status — it is uncorrelated in both directions):

- after arm: **`Tests 34 passed (34)`** — executed 34 = total 34.
- base arm (before the four R3 pins were added): **`Tests 10 failed | 20 passed
  (30)`** — executed 30 = total 30. All **nine** positive family pins fail on the
  arm they test, plus one R4 control, so every pin is sensitive to this
  change-set. The three GUARD pins pass on both arms by design.

### Census drift worth recording

`built-ins/String/prototype/replace/S15.5.4.11_A1_T5.js` is listed in the wave-5
census as failing, but it **passes on the BASE arm** — a sibling lane closed it
between the census sweep and this one. It is not a flip of this change-set.

## Residuals — 18 census rows still failing, with owners

Every attribution below that says "root" was PROBED; the ones that say
"suspected" were not, and are labelled so on purpose. `it.fails` pins protect a
wrong root from ever being tested, so each cluster carries positive controls
chosen to claim the specific root rather than the area.

### R1 — an `Array.prototype.toString` override and the receiver spelling

Census row: `built-ins/String/S15.5.1.1_A1_T8.js`. **This corrects the earlier
write-up in this file**, which said `String(<array>)` folds to the native join
"before any consult". Measured, one module per cell:

| receiver | `String(x)` | `x.toString()` | `"" + x` |
| --- | --- | --- | --- |
| `new Array` inline | ✗ | — | — |
| `[]` inline | ✗ | — | — |
| `[1, 2]` inline | ✗ | — | — |
| `var a = new Array` | **✓** | ✓ | ✗ |
| `var a = [1, 2]` | **✓** | — | — |

Axes varied: receiver spelling, array emptiness, operation. Held fixed:
standalone target, override installed at the top of the same exported function,
one exported function per module. The previous note attributed the var form's
success to "the literal's own dynamic index reads" — refuted: `var a = [1, 2];
String(a)` has no index read and still passes.

Two separable defects fall out:

1. **INLINE receiver** — `String(new Array)` / `String([1,2])` ignore the
   override. Mechanism **suspected, not established**: an inline array-typed
   receiver plausibly keeps a concrete vec struct the compile-time array→string
   lowering claims before the runtime consult is reachable. A WAT read did not
   settle it (emitted names are numeric).
2. **`"" + a` ignores it even with a named receiver** — previously unrecorded.
   The `+` path reaches `__to_primitive`'s vec arm
   (`src/codegen/array-to-primitive.ts`), whose body is a hard-coded `join(",")`
   with no prototype consult. This is the self-contained one.

Owner: the Array lane (dev-4655 / #4556 bucket A). Relayed with this table.

### R2 — `F.prototype.toString` is unreachable FROM the instance

Census row: `built-ins/String/prototype/slice/S15.5.4.13_A3_T4.js`. **Also a
correction**: the earlier note said the fnctor instance "stays a closed nominal
struct with no chain for `__extern_get` to walk". Refuted by probe —

| observation | result |
| --- | --- |
| `"toString" in F.prototype` / `hasOwnProperty` | ✓ |
| `typeof F.prototype[k] === "function"`, `F.prototype[k].call({value:7})` | ✓ `"v7"` |
| `Object.getPrototypeOf(inst) === F.prototype` | ✓ |
| `inst.toString()` (compile-time member dispatch) | ✓ `"v7"` |
| `"toString" in inst` | **✗** |
| `inst[k]()` (computed key, runtime walk) | **✗** — neither `"v7"` nor the `[object Object]` tag |
| `String(inst)` / `"" + inst` / `` `${inst}` `` | **✗** |

So the prototype object carries the override, the link identity is right, and
the miss is specifically the **instance→prototype edge used by the runtime
property walk** — which is the edge `__class_to_primitive`'s new tail asks
`__extern_get` for. Owner: #2660 S3 / #2175 (fnctor instance representation),
upstream of everything this change-set touches.

### R3 — the runtime ToString terminal has no §20.1.3.6 brand classifier

**Three census rows, one root, each confirmed by probe rather than grouped by
resemblance.** In all three the compile-time tag site is CORRECT and the
runtime-provenance spelling is wrong — that identical signature is what makes
them one cluster:

| census row | correct spelling | wrong spelling |
| --- | --- | --- |
| `built-ins/String/prototype/split/instance-is-math.js` | `Object.prototype.toString.call(Math)` ✓ | `String(Math)`, `"" + m` ✗ |
| `built-ins/String/prototype/trim/15.5.4.20-2-51.js` | `Object.prototype.toString.call(argObj)` ✓ `[object Arguments]` | `String(argObj)` ✗ — answers the array join `"1,2,true"` |
| `built-ins/Number/15.7.4-1.js` | `…call(Number.prototype)` ✓, `…call(new Number(42))` ✓ | `…call(Object.getPrototypeOf(new Number(42)))` ✗ |

The last one is the sharpest: same receiver object, two provenances. Written as
a NAME the brand is resolved at compile time; obtained from `getPrototypeOf` it
is only known at runtime and nothing classifies it. Owner: #4492 residual —
needs the §20.1.3.6 classifier reachable from the runtime terminal AND from
`Object.prototype.toString`'s dynamic-receiver arm.

### R4 — the one `String(<wrapper>)` spelling bypasses ToPrimitive

Negative case probed FIRST: after this change-set `s.toString()`, `s == want`,
`"" + s` and a template substitution all answer the own method. Only `String(s)`
does not, because that spelling is lowered as the `[[StringData]]` coercion
(`__wrapper_string_value`) rather than §7.1.17 → ToPrimitive. Owner: #4492
residual. No census row rides on it alone; it is pinned so a future widening of
ToPrimitive does not silently re-break `.length` instead.

### Measured but NOT attributed — 13 rows

Arithmetic: 24 census paths − 5 flips − 1 already-passing (the drift row above) =
**18 still failing**; R1/R2/R3 account for 5 of them, leaving these 13. One of
the 13 (the `constructor` row) has an owner but no root from this lane. The rest
were re-measured failing on the after arm and their exact symptom is recorded,
but no root was probed, so **no root is claimed** — "root unknown, here is the
symptom" is a better handover than a confident wrong root.

| row | after-arm symptom |
| --- | --- |
| `built-ins/String/S15.5.1.1_A1_T9.js` | `String(this)` at top level → `TypeError: Cannot convert object to primitive value` |
| `built-ins/String/prototype/constructor/S15.5.4.1_A1_T2.js` | `TypeError: is not a constructor` — #4515, re-verified above |
| `built-ins/String/prototype/replace/S15.5.4.11_A1_T9.js` | `{valueOf: function(){}, toString: void 0}` receiver — wrong replace result |
| `built-ins/String/prototype/split/argument-is-regexp-and-instance-is-number.js` | `__split.length` is 1, expected 4 |
| `built-ins/String/prototype/split/separator-regexp-limit-string-via-eval.js` | `__split[0]` keeps the fractional tail |
| `built-ins/String/prototype/concat/S15.5.4.6_A2.js` | `concat` with 128 arguments throws |
| `built-ins/Object/S15.2.1.1_A2_T11.js` | `n_obj.constructor` is `undefined` |
| `built-ins/Object/S15.2.2.1_A2_T7.js` | `n_obj.constructor` is a Function but not the expected one |
| `built-ins/Object/S15.2.2.1_A2_T5.js` | `new Object(<Date>)` loses `getFullYear` |
| `language/expressions/object/S11.1.5_A2.js` | `{prop: new Boolean(true)}` — `object.prop === x` is false (wrapper identity) |
| `language/function-code/10.4.3-1-{103,104,106}.js` | `(5).x` — primitive-`this` box; `typeof (5).x` is `"object"`, expected `"number"` |

(The last line covers three rows, which is how 11 table lines carry 13 rows.)

## 2026-08-24 wave-6 — the builtin-method-as-a-VALUE root (dev-4492, branch `issue-4492-builtin-as-value`)

Branch `issue-4492-builtin-as-value`, worktree
`/home/user/js2wasm/.claude/worktrees/agent-ac51f58db58631d51`, implementation
commit `6ad3d17c6`, based on campaign tip `c84bea96e` merged into `08da97da0`. Bundle + QuickJS adapter rebuilt
in-worktree before any measurement (bundle hash `b9841ac11de20bd2`; the adapter
cache HIT names that same bundle, so the eval tier is this tree's compiler).

### The dispatch's framing — "five messages, one root" — is REFUTED

The lane was handed ten rows showing five different messages and asked to confirm
or refute that they are one root. They are **five distinct mechanisms**, and the
refutation was cheap: one differential probe each, one module per probe. The table
is the deliverable, because mis-sizing this issue as one fix is what the framing
risked.

| rows | message | mechanism (probe) | same root as any other? |
| --- | --- | --- | --- |
| `Function/prototype/{call,apply}/…_A1_T2` | `typeof obj.call is expected to be "function"` | `__object_create` cannot store a `$NativeProto` in `$Object.$proto` (`a3.js`) | no |
| `…_A1_T1` (same two methods) | identical message | the **callable** proto-view's own `$proto` is null, so `%Function.prototype%` is one hop away (`f1.js`) | shares the choke point, different link |
| `Function/prototype/bind/S15.3.4.5_A5` | `Function.prototype.bind is not yet implemented` | no reflective `bind` body at all (`makeGlue` refusal) | no |
| `Array/prototype/concat/S15.4.4.4_A2_T{1,2}` | `Array.prototype.concat is not yet callable as a value` | `emitArrayProtoMemberBody` has native cores for `slice` + the HOF family only (`d1.js`) | no |
| `{String,Object}/prototype/constructor/…_A1_T2` | `is not a constructor` | `new X.prototype.<name>` is classified a prototype METHOD; `constructor` is the intrinsic (`c1.js`, `c3.js`) | no |
| `Object/prototype/S15.2.4_A1_T2` | `Object.prototype.toString is not yet implemented` | the reflective §20.1.3.6 classifier has no `$NativeProto` receiver arm (`b4.js`) | no |

The one thing they DO share is the phrase in the dispatch, not a mechanism: each
is a place where a builtin's *own* answer is right and the path that reaches it as
a value is not. Two of the six were tractable in this lane; the other four are
recorded below with roots, not with resemblances.

The wording difference the dispatch flagged (`not yet callable as a value` vs
`not yet implemented`) is real and does name two sites —
`array-object-proto.ts:826` (`emitArrayProtoMemberBody`, Array members with no
native core) and `object-proto-tostring.ts:401`/`native-proto.ts:794`
(`emitObjectProtoOrRefusal` / the generic `makeGlue` tail) — but neither is the
cheaper one: both are the same "no body yet" refusal wearing different text.

### Root cause 1 — a `$NativeProto` in `[[Prototype]]` position is dropped to null

`$Object.$proto` is `(mut (ref null $Object))` (object-runtime.ts), and a builtin
prototype object is a `$NativeProto`, so `__object_create`'s `ref.test $Object`
misses and stores **null**. That is the SAME shape #4637 fixed for a callable in
the same position, at the same three choke points
(`__object_create`, `__object_setPrototypeOf`, `__isPrototypeOf` — all three go
through `canonicalizeProtoArg` in `object-runtime-prototype.ts`).

Measured on the branch base, `--target standalone`, one module per cell
(`.tmp/probes/a3.js`, `e2.js`). The axis varied is **what is assigned**, held
fixed: the constructor shape, the read spelling, the target.

| `.prototype` assigned | `getPrototypeOf(new F()) === it` | an inherited member |
| --- | --- | --- |
| a plain object literal | true | `function` |
| another user function's `.prototype` | true | `function` |
| `Array.prototype` | **false** | **undefined** |
| `Object.prototype` | **false** | (`hasOwnProperty` is `function` for an unrelated reason) |
| `Function.prototype` | **false** | **undefined** |

Two facts make this a REPAIR rather than a widening, and they are why the fix is
small: `F.prototype === Function.prototype` already answered **true** (the fnctor
prototype global is `externref`), and `Function.prototype["call"]` already answered
a real function (#4248's `$NativeProto` receiver arm on `__extern_get`). Both
endpoints were right; only the edge between them was missing.

### Root cause 2 — the callable proto-view's own `$proto` is null

#4637's header states this itself under *"What this does NOT claim"*. Measured
(`.tmp/probes/f1.js`): `function H(){}; H.prototype = G; Object.getPrototypeOf(new H()) === G`
was already **true** while `typeof new H().call` was **undefined** — the link
exists, the level above it does not.

### Root cause 3 — the reflective `Object.prototype.toString` has no `$NativeProto` arm

`NATIVE_PROTO_BRAND_TAGS` deliberately lists only the five prototypes whose tag is
NOT the step-13 default. `%Object.prototype%` is not in it, so a receiver that IS
`Object.prototype` matched no arm and hit the loud refusal. Measured
(`.tmp/probes/b4.js`), one module, receiver varied and everything else fixed:

| receiver of the stored-slot `getClass()` | base |
| --- | --- |
| `[1,2]` | `[object Array]` |
| `{}` | `[object Object]` |
| `Object.prototype` | **refusal** |

### Fix

| file | what |
| --- | --- |
| `src/codegen/proto-function-value.ts` | roots 1+2. A `$NativeProto` arm on `__proto_from_function` mapping the brand to its proto-index COMPANION `$Object` (`__protoidx_brand_off` + `__protoidx_companion(off, create=1)`), registered in the SAME bag registry so `__function_from_proto` maps it back; and `bagFunctionProtoLinkInstrs`, which gives a callable bag the `%Function.prototype%` companion as its own `$proto` when that slot is still null. |
| `src/codegen/object-proto-tostring.ts` | root 3. One `["Object", "Object"]` entry in `NATIVE_PROTO_BRAND_TAGS`. |

Three design points worth carrying forward:

- **The companion was already the right view, and already existed.** #4637 chose
  a proto-VIEW over widening `$proto` to `anyref`; the same argument applies
  verbatim here (every `struct.get $Object 0` feeds a `(ref null $Object)` local),
  and `proto-index-store.ts` already maintains a per-brand `$Object` companion
  holding that brand's own members — `__protoidx_own_recv` already substitutes it
  for own-property queries. So this is population of an existing mechanism, not a
  new MOP: **no new struct field, no new walk, no change to `$Object`'s layout.**
- **`create = 1` is the demand gate.** `__protoidx_own_recv` probes with
  `create = 0` deliberately (an own-property query must not mint). A
  `[[Prototype]]` link is the opposite: the read IS the demand, and minting also
  runs `__nativeproto_seed_<brand>`, which is what puts `call`/`apply`/`bind`/
  `toString` in the Function companion.
- **The register step is factored (`registerViewInstrs`) so the two arms cannot
  diverge.** `__function_from_proto` is the only thing standing between this
  change and `Object.getPrototypeOf(o)` publishing an internal object the program
  can never name — one arm forgetting it is exactly the wrong-answer trade the
  campaign forbids.

Declines built into the arm, all "absent, never wrong": a **class** `$NativeProto`
(`$isClass` set) is guarded out, because `__protoidx_brand_off` answers its
`Object` DEFAULT for a tag it cannot classify and mapping one would publish
`%Object.prototype%`'s companion as a class's prototype; an unreserved
proto-index store emits no arm and no bytes; a companion that is not an `$Object`
returns the receiver unchanged rather than cast-trapping.

### Gate grants (frontmatter, per-file rationale)

- `src/codegen/proto-function-value.ts` (377 → 587, **+210**). The module already
  owns "a value that is not an `$Object` in `[[Prototype]]` position"; a second
  shape of the same question belongs with the first, and splitting it out would
  have meant exporting `walkRegistry`, the three `$ProtoFnEntry` field indices
  and the local-slot numbering — four layout facts in two files, which is the
  drift this campaign keeps paying for. About **130 of the 210** are the two
  doc-comments (the measured base tables, the rejected `anyref` widening, and the
  ARMING residual that stops a reader re-deriving it); the executable part is two
  arm builders plus the extraction of the shared `registerViewInstrs` tail, which
  is net-negative against the duplication it replaces.
- `src/codegen/object-proto-tostring.ts` (689 → 708, **+19**). One entry in
  `NATIVE_PROTO_BRAND_TAGS` plus the comment saying why it is added ALONE — the
  table's own "deliberately NOT a catch-all" rule is what makes a blanket
  `$NativeProto ⇒ Object` default wrong (every `@@toStringTag` brand), and an
  unexplained entry in that table is how the next lane widens it.

No `func-budget-allow`, no `coercion-sites-allow`, no `oracle-ratchet-allow` was
needed: all five gates pass clean (`check-loc-budget`, `check-func-budget`,
`check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports` — run bare,
exit statuses read individually, never through a pipe).

### A fix that was implemented, measured, and DELIBERATELY NOT SHIPPED

Root "`new X.prototype.constructor` is not a constructor" has a one-token fix:
`isNewOnNonConstructablePrototype` (new-super.ts) and `classifyNonConstructableValue`
(non-constructable.ts) both read every `X.prototype.<name>` as a prototype METHOD,
and `constructor` is the intrinsic constructor. Excluding that one name was
written, type-checked and measured. **It is reverted; the branch carries no code
from it.** What the measurement showed (`.tmp/probes/c4.js`):

| spelling | base | with the exclusion |
| --- | --- | --- |
| `new Object.prototype.constructor()` | `TypeError: is not a constructor` | builds, tag `[object Object]` |
| `…then `obj.constructor === Object`` | (unreachable) | **traps**: `Cannot access property on null or undefined` |
| `new String.prototype.constructor("choosing one")` | `TypeError: is not a constructor` | **builds a plain object**, `== "choosing one"` is **false**, no throw |

The third row is the forbidden trade: a loud refusal became a silent WRONG answer.
Neither target row flips either way (`S15.2.4.1_A1_T2` merely fails later, on a
null-deref). The predicate diagnosis is correct and is handed on; the fix needs the
intrinsic-construct path, which is `#4515`'s territory, not a predicate edit.


### Test Results — verification floor (dev-4492 wave-6, runs executed 2026-08-24)

Every figure below is from a run executed in this worktree. Arms were separated by
file copy (`.tmp/base-*.ts` / `.tmp/new-*.ts`), never `git stash`, and the
`git diff HEAD --stat -- src` detector was read **before each arm**: **0 files**
on the after arm (the change is committed, so `HEAD` IS the after tree) and
**2 files** on the base arm. Reading the bare `git diff --stat` here would have
been blind to the restore — the correction this file's own wave-5 section made to
the brief.

#### Sweep scope — 1,087 rows per arm, and why it is this size

`--target standalone`, `runTest262File` per row, `SWEEP_TIMEOUT=180000`,
`JS2WASM_EVAL_ENGINE=quickjs TEST262_FULL_RUNTIME_EVAL=1`, serial.

| rows | directory | why it is in |
| ---: | --- | --- |
| 320 | `built-ins/Object/create` | the direct caller of the changed helper |
| 309 | `built-ins/Function/prototype` | the flips; the Function brand companion |
| 248 | `built-ins/Object/prototype` | the `Object.prototype.toString` arm |
| 59 | `built-ins/Object/keys` | the enumeration-leak question the new chain link opens |
| 59 | `language/expressions/new` | `new F()` — the other way into `__object_create` |
| 41 | `language/statements/function` (`S13.2.2_A*` only) | the [[Construct]]-prototype family this arm serves |
| 39 + 12 | `built-ins/Object/{get,set}PrototypeOf` | the other two `canonicalizeProtoArg` call sites |

**Dropped, and why.** `built-ins/Reflect` (153) — its `getPrototypeOf` /
`setPrototypeOf` are the same two natives as `Object`'s, already covered. The rest
of `language/statements/function` (410) — reachable only through a plain `new F()`
whose prototype is the lazily-minted `$Object`, where `__proto_from_function` is
the identity; the S13.2.2 family, which is the part that *does* test this change,
was kept. `built-ins/Object/getOwnPropertyNames` (45) — `Object/keys` asks the
same enumeration question. `built-ins/Array/prototype` (2,811) and
`built-ins/String/prototype` (1,073) — the diff cannot reach a member body;
`Object.create(Array.prototype)` is covered by `Object/create`.

#### Before / after

| arm | pass | fail | compile_error | rows | wall | load (median / max, sampled per minute) |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| base | 907 | 173 | 7 | 1,087 | 13:08→14:01 | 6.08 / 15.08 |
| after | **909** | 171 | 7 | 1,087 | 12:11→13:06 | 6.68 / 10.99 |

**Net +2, regressions 0.** The two arms ran at comparable load (medians 6.1 and
6.7 on 4 cores), the **denominators are identical** (1,087 each — so no row
disappeared to the `IT_TIMEOUT_MS` silent-kill), and **zero rows on either arm
carry a `timeout` error**, so the contention trap did not touch these numbers.
The 7 compile errors are the **same 7 files** on both arms (4 `Function/prototype/
bind` rows needing `Reflect.construct` realm preservation, 3
`Object/setPrototypeOf` rows on `__get_builtin` / BigInt) — unrelated to this
change.

#### Flip list — both flips re-verified SERIALLY on both arms, one file at a time

| test262 row | base | after |
| --- | --- | --- |
| `built-ins/Function/prototype/call/S15.3.4.4_A1_T2.js` | `typeof obj.call` is `"undefined"` | pass |
| `built-ins/Function/prototype/apply/S15.3.4.3_A1_T2.js` | `typeof obj.apply` is `"undefined"` | pass |

#### Movement, NOT a flip — 1 row

`built-ins/Object/prototype/S15.2.4_A1_T2.js` fails on both arms, but it now fails
at a **later assertion**: base dies on the FIRST one
(`Object.prototype.toString is not yet implemented`), after reaches
`assert.sameValue(e instanceof TypeError, true)` — the post-`delete` half, which
is the #4596 three-op residual above. Recorded as movement so the campaign's flip
total stays a sum of per-lane flip counts.

#### Pins

`tests/issue-4492-builtin-as-value.test.ts`, counts read off vitest's own summary
line (never the exit status):

- after arm: **`Tests 13 passed (13)`** — executed 13 = total 13, file line
  `(13 tests)` with no `skipped` suffix.
- base arm (both source files reverted): **`Tests 6 failed | 7 passed (13)`** —
  executed 13 = total 13. **All six positive pins fail on the arm they test**; the
  three GUARD pins and the four `it.fails` residual pins pass on both arms by
  design.
- both #4492 suites together on the after arm: `Tests 47 passed (47)` across
  `(13 tests)` + `(34 tests)` — wave-5's suite is unaffected.

`tests/equivalence/`, per-file loop (a single invocation OOMs), 13 files chosen as
the object/prototype surface the diff can reach — `arguments-object`,
`array-prototype-methods`, `issue-4123-param-receiver-proto-method`,
`issue-799-prototype-chain`, `object-create`, `object-keys`, `object-mutability`,
`object-to-primitive`, `object-define-property`,
`object-define-property-accessors`, `object-literal-getters-setters`,
`numeric-key-object`, `empty-object-widening`: **74 tests, all passing, every file
`executed == total` with no `skipped` suffix.**

#### Byte control — the host lane is inert, standalone pays 2 bytes

Five representative modules compiled on both arms, sha256 of the binary
(`.tmp/bytes-{base,after}.txt`):

| module | base → after |
| --- | --- |
| host lane (no `target`) | **byte-identical**, `41ed8163ef6d5d0f`, 350 bytes |
| standalone, no proto usage | 218,121 → 218,123 (**+2**) |
| standalone `Object.create({…})` | 209,058 → 209,060 (**+2**) |
| standalone `new F()` | 223,715 → 223,717 (**+2**) |
| standalone callable-as-prototype (armed by its `Object.getPrototypeOf` call) | 290,412 → 290,590 (+178) |

The **+2** is one extra locals-vector entry (`__fnProto`) in
`__proto_from_function`, declared unconditionally so the slot index cannot drift
between the arms that use it. It is never read on those paths and cannot change
behaviour. Declaring it conditionally — the local is last, and the only consumer,
`bagFunctionProtoLinkInstrs`, returns `[]` under exactly the same condition —
would restore byte-identity; it was **not** done here because the change landed
after the sweep, and reporting a sweep of one tree as evidence for another is the
defect this campaign documents most often. A follow-up lane can take it with its
own measurement. The +178 is the real arm, in a module that genuinely uses it.

### Residuals — with roots, and with what would close each

| rows | root (probed) | owner / what it needs |
| --- | --- | --- |
| `Function/prototype/{call,apply}/…_A1_T1` (2) | the mechanism WORKS; the module never names a builtin prototype, so `protoMemberDirty` stays clear, `reserveProtoIndexStore` never fires and the companion is never seeded. Proven by adding one line — `var arm = Function.prototype` — to the identical probe (`f1.js` → `f2.js`), which flips both reads to `function`. | #4492. Closing it means ARMING `protoMemberDirty` on "a non-literal value is assigned to a `.prototype`" (`isProtoMemberValueUse`, array-holes.ts). Declined here: that arms the whole proto-index store — companion seeder, ~4-36 member closures per brand — for every module that assigns a `.prototype`, and `isProtoMemberValueUse`'s own comment records that the seeder's extra functions perturb IR eligibility (#2855 ratchet). Two rows is not the price of that; it wants its own measured issue. |
| `Object/prototype/S15.2.4_A1_T2` (1, half-closed) | the FIRST assertion now passes. The rest needs `delete Object.prototype.toString` to be visible to the **syntactic** member call. Measured (`b5.js`): after the delete, `hasOwnProperty` is `false` and the DYNAMIC read is `undefined`, while the static read and the call keep the compile-time answer. | the three-op-agreement family (#4596) — the consult-order asymmetry wave-2 recorded. Not a value-read defect. |
| `Array/prototype/concat/S15.4.4.4_A2_T{1,2}` (2) | no reflective `concat` body; `emitArrayProtoMemberBody` covers `slice` + the non-reduce HOF family. T2 needs only "build `[thisArg]` at runtime"; T1 additionally needs heterogeneous element representation, which wave-2 already routed to the value-rep lane. | #4492 / the Array lane. T2 is the tractable half and should be sized on its own. |
| `Function/prototype/bind/S15.3.4.5_A5` (1) | no reflective `bind` body, and the row additionally needs bind's [[Construct]] currying plus `.apply` ON the resulting builtin value. | #4656 (`fn-proto-residual-bind-membrane-intrinsic`). |
| `{String,Object}/prototype/constructor/…_A1_T2` (2) | the predicate diagnosis above. | #4515. |

Adjacent defects found while probing, NOT fixed and NOT claimed as roots of any row:

- `typeof Function.prototype` answers `"object"`; §20.2.3 makes it a callable, so
  it must be `"function"` (`.tmp/probes/f2.js`, first line).
- `var C = Object; new C()` emits a host import `env::Object_new` under
  `--target standalone` and therefore cannot instantiate (`.tmp/probes/c2.js`).
  This is a different spelling from the `X.prototype.constructor` rows and was not
  investigated further.
- `Function.prototype.isPrototypeOf(o)` and `Array.prototype.isPrototypeOf(a)`
  answer `false` even with the link in place — measured **identically on both
  arms** (`.tmp/probes/g1.js`, base and after), so this change neither fixes nor
  regresses it. `__isPrototypeOf` is the third `canonicalizeProtoArg` call site,
  so the receiver IS canonicalized; the spelling evidently does not reach that
  native. #4480's record attributes the `isPrototypeOf` read point to the #2660
  escape gate rather than to the chain walk; this lane did not re-derive that and
  does not claim it.
