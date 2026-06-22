---
name: project_2580_m1a_length_reftest_dispatch
metadata: 
  node_type: memory
  type: project
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

#2580 M1a (`.length` on an `any`/`unknown` receiver, HOST mode). **OUTCOME
(merged f6e7aa852, PR #1894): landed as OPTION C — M0 scaffold only, host
`.length`-on-any arm OFF.** The uniform-externref arm (described below) was the
first attempt; it ejected from the merge_group and a faithful test262 runner
proved the value-semantics is NOT a surgical M1 slice — see the "FINAL VERDICT"
section. The landed M1a = `emitDynGet`/`ensureDynReadHelpers` + the closure-base
helper REGISTERED + INERT (the arm is off; nothing calls `emitDynGet` in src), for
M2 to build the `$AnyValue`-tag-aware reader into. The value-semantics fix moved to
M2. The rest of this note documents the arm design + why it can't ship as M1.

**Three load-bearing facts (each cost a wrong attempt):**

1. **Position AFTER the vec-struct detection, not before.** An `any` local
   holding a real array (`const o: any = [1,2,3]`) is an externref wrapping a
   WasmGC vec; origin already reads its `.length` correctly via a generic
   externref reader. Folding the dyn-read arm AHEAD of the length-bearing-vec
   detection forced every array through `__extern_get(vec,"length")`, which the
   host evaluates to `undefined` (V8 sees an opaque struct). So the arm lives in
   the `savedLen` fallback block — fires only when the compiled receiver is NOT a
   `{length,data}` vec struct (the genuinely non-vec dynamic receiver).

2. **Dispatch with `ref.test` over `ctx.vecTypeMap`, NOT a `call __dyn_get`/
   `__is_vec`.** For the `length` key, `emitDynGet` emits an if/else chain:
   `ref.test $vec_i → box_number(f64(struct.get $vec_i 0))` on a vec hit (the
   array length), else `__extern_get(recv,"length")` (value or undefined).
   `ref.test typeIdx` uses TYPE indices, which are append-only / dead-elim-stable
   (the rec-group), so it carries NO funcidx-ordering / late-import-shift hazard.
   A defined-func wrapper (`call __dyn_get`) was the original blocker: its index
   FLOATS when a value-consumer adds a late import after the `call` is baked,
   landing on the adjacent helper (the #2043 class). `__extern_get` +
   `__box_number` are host IMPORTS (stable); ensure BOTH up-front before
   resolving any baked index. This `ref.test`-over-vecTypeMap pattern is the
   funcidx-safe substrate primitive — reuse it for M2/M3 dynamic reads.

3. **Uniform-externref result coerces for free — no M1b consumer pass needed.**
   The arm returns `{kind:"externref"}` (boxed number / JS undefined). The (a2)
   "chokepoint refactor" the M1 verdict feared was UNNECESSARY:
   `compilePropertyAccess` IS already the `.length` chokepoint, and the existing
   externref→f64 coercion (`__unbox_number`) handles ALL consumers — `+`/`*`/`<`/
   `for`-bound/`=== undefined` (presence arm)/`typeof`/`String()`/truthiness all
   correct, verified. Parallel-safe vs the tag-5 classifier wave (#1888/#1864):
   `=== undefined` + numeric arms are disjoint from their content classifier.

Standalone is unchanged (routes through the `__dyn_get` wrapper, correct there
because `__extern_get` is a defined native helper). See
[[project_standalone_any_string_value_read_substrate]] for the standalone reader.

**Process trap:** `git commit --amend` after `prettier --write` can silently drop
the format fix if the file was staged pre-format — the `quality` job's Format
check runs the full glob. ALWAYS verify `git show HEAD:<file> | prettier --check`
passes BEFORE pushing, not just the working tree.

**v1 MERGE_GROUP EJECT (PR #1894, 13 regr) + the v2 fix.** v1 (the vecTypeMap
dispatch above) passed all PR checks + all 117 merge_group shards but the
merge_group **net-regression gate** ejected it: 13 regressions, all
`assertion_fail`, wasm-hash-change, 0 improvements (fails net AND ratio);
`auto-park` set `hold`. ALL PR-level checks green does NOT clear the merge_group
net-guard — value-rep/chokepoint changes MUST be validated by merge_group (or full
local-ci), never a scoped sweep (the scoped 13-case suite missed all 13). To find
the exact regressed tests: pull the `test262-merged-report` artifact from the
failed merge_group run + diff its JSONL vs the fetched baseline JSONL on
`file`+`status`. The 13 = TWO clusters, ONE root cause: the `any|unknown` gate is
TOO BROAD — the arm fired on (A) closure `.length` (arity: `(fn as any).length` →
NaN, origin gave 0) and (B) `for ([x,...y] of); y.length` (rest binding is a
boxed/wrapped externref, vec-test misses, `__extern_get`→undefined→NaN; origin
gave the count). Both = "any boxed/wrapped NON-plain-object receiver" the prior
numeric path read right.
**v2 fix = DECLINE-FOR-STRUCT (option 3).** A positive `$Object` gate (the first
idea) is NOT viable in host mode: `objectTypeIdx` only exists via
`ensureObjectRuntime`, which registers `$PropEntry` with `key: ref $anyStrTypeIdx`
(host `anyStrTypeIdx = -1` → crash); and host plain `{}` is NOT a WasmGC `$Object`
struct — it's a host JS externref, nothing to `ref.test`. So instead: the dyn-read
`.length` arm DECLINES (return false → caller's prior numeric `.length` path) when
the receiver `ref.test`s as a VEC or a CLOSURE base type
(`collectClosureBaseWrapperTypeIdxs(ctx)`); fires `__extern_get(recv,"length")`
ONLY for the residual genuine host externref. array→decline→prior vec field-0 ✓;
`{}`→struct-miss→`__extern_get`→undefined ✓ (canary); closure→decline→0 ✓ (A);
rest-binding(vec)→decline→count ✓ (B). SIMPLER than v1 — drops the box-number vec
arm (the prior path already reads array `.length` right). Validate against the REAL
async-gen rest test262 file (reduced `for([x,...y]of)` probe is unfaithful — origin
also returns 0 there).

**v2 implemented = Cluster A only; Cluster B is a deeper `$AnyValue` problem.**
The decline-for-struct idea was implemented as a CLOSURE arm (`ref.test` closure
base types → `box_number(0)` arity fallback; closure base types derived inline
from `ctx.closureInfoByTypeIdx` to dodge a circular import on index.ts). That
FIXES Cluster A (5/13) and is committed. But Cluster B (8 for-await array-rest
`.length`) is NOT a closure and NOT a bare vec: the async-generator rest binding
`y` is an **`$AnyValue`-BOXED vec** (tag 6 = GC ref wrapping the vec,
`ctx.anyValueTypeIdx`). The arm's `any.convert_extern` + `ref.test $vec` MISSES the
`$AnyValue` wrapper → `__extern_get(y,"length")` → undefined → NaN, where origin's
generic path returned the count. Fixing B requires UNWRAPPING `$AnyValue` (tag-6
field extract) BEFORE the vec `ref.test` — a real deepening into `$AnyValue`
internals (the M2/M3 dynamic-read primitive anyway). **Cluster B cannot be
reproduced with reduced probes** — `for([x,...y]of)` and hand-rolled async-gen
probes return 0 on BOTH origin and the branch, yet the real test262 passes on
origin; it needs the full async-iteration test262 harness (merge_group / full
local-ci).

**FINAL VERDICT (faithful runner) — M1a `.length`-on-any value-semantics is NOT a
surgical slice; it needs M2's tag-aware reader.** Build a faithful local gate by
calling the REAL `runTest262File` (tests/test262-runner.ts) on the regressed files
directly (a `.tmp/run13.mjs` that imports it) — reduced `compile()`+probe shapes
repeatedly LIED here (a user closure ≠ a host builtin; `for([x,...y]of)` ≠ the
async-gen harness). The faithful runner proved: **arm OFF → 12/13 pass** (zero
regression = origin; the 13th skips on Temporal), and NO surgical narrowing
recovers the canary while reverting the 13 — closure-arm, receiver-`ref.is_null`
guard, and decline-for-struct all leave 0/13. Root cause = TOTAL ENTANGLEMENT:
every one of the 13 reaches `__extern_get(recv,"length")` → undefined → NaN where
the prior numeric path returned a usable value (0 via `__extern_length`'s
null-guard, or the real count), and the canary (`{}.length` → undefined) needs that
SAME `__extern_get`-undefined result to stay undefined. A non-null `{}` lacking
`length` and a non-null wrapped builtin/rest-binding are the SAME externref shape —
no `ref.test`/`ref.is_null`/`__extern_has` predicate separates them. Only a
TAG-AWARE reader (inspecting the boxed `$AnyValue` tag, M2's job) can disambiguate,
because the distinction lives in the box, not in a bare-externref runtime test.
Recommended resolution: **turn the arm OFF (option c)** — canary reverts to the
PRE-EXISTING #2580 bug (not a new regression), M0 stays inert, zero regression;
move the `{}.length`→undefined fix into M2. Lesson: a "canary" that's
statically-`any`-erased can be runtime-indistinguishable from the very cases it
must not touch — validate value-semantics slices against the REAL test262 runner
before believing reduced probes.

## M2 slice 1 (2026-06-22) — the M1a "total entanglement" was WRONG; the 13 split

The M1a "no predicate separates them" verdict above was incomplete. M2 slice 1
re-diagnosed each of the 13 against the faithful runner and found TWO separable
clusters + a fix for the canary:

- **The canary `{}` is a tag-5 HOST EXTERNREF** (via `__new_plain_object`), NOT
  `$AnyValue`-boxed. The host `__extern_get({}, "length")` → undefined CORRECTLY.
  So the canary needs no tag-reader — it works through the host's own knowledge.
- **Cluster A (5 `length.js`)**: the RECEIVER itself resolves to **undefined**
  (`IteratorProto[Symbol.iterator]` → undefined — a separate Symbol-prototype-walk
  gap), so `.length` on undefined → `__extern_get(undefined,"length")` → NaN;
  origin null-guards to 0 (matching `verifyProperty {value:0}`). **FIXED** by a
  null-guard in the reader: `__extern_is_undefined(recv) → box_number(0)`. The
  distinguisher is `__extern_is_undefined` — **NOT `ref.is_null`**, because a JS
  `undefined` is a NON-null externref wrapping the host undefined sentinel (that is
  exactly why M1's `ref.is_null` guard left Cluster A at 0/13). `{} == null` →
  false, `undefined-receiver == null` → true — so the null-guard separates the
  canary from Cluster A.
- **Cluster B (8 for-await array-rest)** is NOT a reader gap — it's an
  **async-state-machine local-versioning bug** the arm EXPOSES: the arm's
  `compileExpression(y)` recompiles the rest binding and gets the SOURCE array (a
  vec whose field-0 = source length 3), while origin's local-type arm
  (property-access.ts ~3527) reads `y`'s CURRENT local (the rest slice, length 2).
  Sync `[x,...y]` reads 2 correctly; only the async `for await` form aliases the
  source. `decline-for-vec` is safe (origin reads array-as-any=3 AND async-rest=2
  right) but origin's correct async-rest read (its local resolution) is unreachable
  from the arm post-rollback — `{}` and async-rest-`y` both compile to externref
  (no compile-time separator), and a runtime `ref.test`-vec's vec-branch can only
  `struct.get` field-0 (=3, the wrong source). So slice 1 lands canary + Cluster A;
  Cluster B is an orthogonal async-desugaring fix. WIP at `issue-2580-m2s1-reader`
  commit `b77a1c520` (not pushed). `.tmp/run13.mjs` (real `runTest262File`) is the
  reusable gate.
