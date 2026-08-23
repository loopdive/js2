---
id: 4492
title: "ES5 standalone: builtin-prototype methods on exotic/boxed/dynamic receivers (~103 tests across Array/String/Function.prototype)"
status: ready
sprint: current
created: 2026-08-15
updated: 2026-08-15
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
func-budget-allow:
  - src/codegen/object-runtime.ts::ensureObjectRuntime
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
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
