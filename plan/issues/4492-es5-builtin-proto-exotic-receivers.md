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

The family's deltas (`0 vs 1`, `0 vs 2`, `3 vs 2`, `4 vs 3`, `2 vs 3`) share one
shape: **index enumeration over a sparse array-like `$Object` is wrong when the
`length` getter mutates the object during step 2**. The work is therefore in the
Array generic path's `HasProperty`/index reads over `$Object`
(`__extern_length` / `__extern_has_idx` / `__extern_get_idx`) — NOT in receiver
coercion, so it does not touch anything #2742/#4207 own.

**Recommended next action**: re-scope #4492 to the Array + Function halves and
take the filter 9-b slice first. Not started here — starting before the re-scope
risks the same collision the String half would have caused.

## Validation

`TEST262_TARGET=standalone TEST262_PATH_FILTER="built-ins/Array/prototype|built-ins/String/prototype|built-ins/Function/prototype" pnpm run test:262`
— baseline ~103 non-pass in the ES5 bucket (the filter also runs ES6+ files;
diff per-file against the fresh baseline, not by count). gc-lane control.

## Re-scope decision (fable, 2026-08-15)

Accepted the triage above in full. **#4492 is re-scoped to the Array + Function
halves only** (~44 real failures + the 2 routed to #2175):

- The String bucket (~13 + the transfer shape) is FOLDED OUT to its owners:
  #2742 (in-progress, `ttraenkler/codex-es5-string`) and #4207 (ready,
  `ttraenkler/W28`). Do not implement String receiver coercion here.
- The `Array.prototype.filter` 9-b slice (11 files) is approved and dispatched
  to the reflection lane (sparse array-like index enumeration under a mutating
  `length` getter — `__extern_length`/`__extern_has_idx`/`__extern_get_idx`).
- `Function.prototype.{call,apply,bind}` this-binding (10) stays here but MUST
  be pre-dispatch-gated before anyone starts it.
- Process note: this issue was filed without running `pre-dispatch-gate.mjs`
  on its constituent buckets — the gate at implementation time caught what
  filing time missed. Gate at FILING time for cluster issues that aggregate
  previously-tracked symptoms.
