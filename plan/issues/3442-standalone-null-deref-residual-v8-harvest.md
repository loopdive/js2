---
id: 3442
title: "standalone: null-deref residual (789 gap tests) — general __module_init + sync destructuring-rest traps, no open tracker"
status: ready
created: 2026-07-19
priority: high
task_type: bug
area: standalone
goal: standalone-mode
model: fable
sprint: current
horizon: m
related: [1781, 2865, 3387, 647]
---

# #3442 — standalone null-deref residual (v8 harvest, 2026-07-19)

## Summary

Harvesting the 2026-07-19 standalone baseline (`test262-standalone-current.jsonl`,
oracle v8) and computing the honest host↔standalone gap
(`host_pass ∧ ¬standalone_pass`, official) surfaced **789 gap tests** with
`error_category: null_deref` — standalone modules that **compile** but trap
`dereferencing a null pointer` at runtime, where the JS-host lane passes. These
are **genuine standalone-codegen bugs**, NOT host-import refusals (no
`host imports` / `not supported in standalone` string).

The historical residual null-pointer buckets (#647, #441, #526, #566) are all
`status: done` — none is an **open** tracker for the current v8 baseline. #2865
(in-progress) owns the async-generator/for-await **carrier** subset; this issue
owns the remaining ~600 non-async-carrier residual.

## Sub-buckets (normalized signature within the 789 gap tests)

| signature | count | owner |
| --- | ---: | --- |
| `dereferencing a null pointer [in __module_init()]` (general: top-level dstr, RegExp, arrow) | 365 | **this issue** |
| `... [in __async_resume_f*() ← __async_gen_next_* ← __module_init]` (async-gen/for-await rest dstr) | ~190 | #2865 (in-progress) |
| `... [in C_method() / C___priv_method() / __anonClass_*___priv_method()]` (sync class-method array/obj rest dstr) | ~135 | **this issue** |

The class-method + general cluster is dominated by **array/object destructuring
rest patterns** (`ary-ptrn-rest`, `obj-ptrn-rest`) in class methods and top-level
code — a null struct dereferenced during the rest-collection iterator drain.

## Sample paths

- `test/built-ins/RegExp/S15.10.2.8_A3_T15.js` (general `__module_init`)
- `test/language/statements/variable/dstr/ary-ptrn-elem-ary-rest-iter.js` (top-level rest dstr)
- `test/language/statements/class/dstr/meth-ary-ptrn-rest-ary-rest.js` (class-method rest dstr)

## Root cause (hypothesis)

The standalone destructuring lowering allocates the rest-array / iterator-result
struct but a path leaves a field null (the iterator-`done` sentinel or the
collected-rest ref) that a later `struct.get` dereferences. In the JS-host lane
the same read routes through a host import that tolerates the null; standalone's
native path traps. Likely shares the iterator-drain root with the done #2904 /
#2756 destructuring fixes, re-exposed at the class-method / top-level scope under
the v8 harness.

## Suggested fix

1. Reproduce `language/statements/class/dstr/meth-ary-ptrn-rest-ary-rest.js` in
   `--target standalone` and locate the null `struct.get` in `C_method`.
2. Audit the rest-pattern iterator-drain lowering for the null-sentinel guard
   that the done #2904 fix added — confirm it covers class-method + top-level
   scopes, not only param scope.
3. Coordinate with #2865 for the async-resume subset so the carrier fix and the
   sync fix don't diverge.

## Regression note

The done residual buckets (#647/#441/#526/#566) closed at earlier baselines; this
789-count cluster is the current v8-baseline standing surface. Treat as
re-exposure under the real upstream harness (v8 flip #3370), tracked fresh here.

## Implementation Plan (architect, 2026-07-19 — root cause CONFIRMED by bisection; supersedes the rest-pattern hypothesis above)

### Root cause (confirmed): omitted-argument call sites + non-nullable inferred ref params

The destructuring-rest hypothesis is WRONG — the rest patterns are incidental.
Empirical bisection of `language/statements/class/dstr/meth-ary-ptrn-rest-ary-rest.js`
(standalone) reduced the trap to a **3-line repro with no destructuring at all**:

```js
function assert(v, m){ if (v === true) return; throw new Error(m); }
function other(x){ assert(false, "y"); }   // 2-arg call site pins m: string
assert(true);                              // 1-arg call site → TRAP
```

`--target standalone` → `RuntimeError: dereferencing a null pointer` in
`__module_init`. Remove the 2-arg call site → passes. gc/host lane → passes.

Mechanism (all sites verified in source):

1. `inferParamTypeFromCallSites`
   (`src/codegen/declarations/param-return-inference.ts:65-104`) walks call
   sites to type untyped JS params. Its loop does `if (arg) { … }` — **a call
   site that OMITS the argument contributes nothing**. So one `assert(false,
   "y")` pins `message` to the native-string type and the 1-arg sites are never
   counted as evidence that the param must admit `undefined`.
2. The param lowers to NON-NULLABLE `(ref $String)` in the function signature.
3. Call sites with the argument missing pad it via `pushDefaultValue`
   (`src/codegen/type-coercion.ts:3379`), whose `case "ref"` (line ~3411) emits
   `ref.null <t>; ref.as_non_null` — **an unconditional
   "dereferencing a null pointer" trap** (the comment "parameter-padding
   contexts typically don't reach non-null ref params" is exactly the falsified
   assumption). The emitted WAT for `assert(true)` is literally
   `i32.const 1; ref.null $String; ref.as_non_null; call $assert`.

Why this explains the whole bucket: **`test262/harness/assert.js` contains both
shapes** — `assert.compareArray` calls `assert(false, message)` (2-arg, line
~114-124), while nearly every test's first assertion is 1-arg
`assert(cond)`. So on the standalone lane every literal-harness test whose
body executes ANY 1-arg `assert(...)` traps:
- at top level → the 365-record `[in __module_init()]` sub-bucket;
- inside a class method (`assert(Array.isArray(x))` in the dstr meth tests) →
  the ~135-record `C_method()` sub-bucket (bisected: `assert(true)` alone in a
  method traps identically; `Array.isArray`/rest-patterns irrelevant);
- likely a large share of the #2865 async-carrier subset too (same call under
  an async frame) — coordinate before assuming that subset needs its own fix.

The host lane passes because there the param stays `externref` (host-boxed
string), where `pushDefaultValue` emits undefined, not a trapping cast.

### Changes

**File: `src/codegen/declarations/param-return-inference.ts`, `inferParamTypeFromCallSites` (line 65)**
- Track omitted arguments as evidence: when
  `node.arguments.length <= paramIndex` for a matching call site, set
  `sawOmitted = true`.
- After the walk: if `sawOmitted` and the agreed type is a non-nullable
  `ref` (or any type that cannot represent `undefined` — including `i32`
  string-char or struct refs), **return `null`** (no inference → the param
  keeps the default externref/any carrier, which represents `undefined`).
  Do NOT merely demote `ref → ref_null`: the body must still distinguish
  `m === undefined` (§ the harness does `if (message === undefined)`), and
  null≙undefined conflation on a string ref is a fresh bug class. Conservative
  bail-out is the correct first fix; a typed `ref_null`+sentinel refinement can
  come later if the perf delta matters.
- Same treatment for spread call sites (`...args` — arity unknowable): treat as
  omitted-evidence for all params past the spread position, or bail.

**File: `src/codegen/type-coercion.ts`, `pushDefaultValue` (case "ref", line ~3411)** — hardening, second commit
- An unconditional `ref.null; ref.as_non_null` is a landmine. Behind the
  primary fix, add a debug-mode diagnostic (or compile-time warning channel)
  when this arm is reached from an argument-padding context, so the next
  inference gap surfaces as a named error instead of a bare null-deref trap.
  Keep the emission itself (other callers rely on the validate-only shape).

### Edge cases
- A function whose omitted param is genuinely dead (`function f(a, b){ return a; }`,
  called `f(1)` and `f(1,2)`) currently *works* only when `b`'s inferred type
  is padding-safe — the fix must not regress the all-sites-provide-args case
  (inference unchanged there).
- Recursive/self-referential call sites (assert.js's own
  `assert(false, …)` inside properties assigned onto `assert`) are ordinary
  call sites for the walker — no special-casing needed.
- `inferParamTypeFromBody` (line 125) can still fire after the bail; verify it
  cannot re-pin a non-nullable ref for a param with omitted-arg call sites
  (thread the `sawOmitted` fact through, or check call sites there too).

### How to test
- Unit repro: the 3-line snippet above under `{ target: "standalone" }` must run
  clean; assert both `assert(true)` (return path) and
  `try { assert(false) } catch` (throw path, message === undefined branch —
  exercises the undefined-representability requirement).
- Scoped test262 (standalone): `language/statements/class/dstr/meth-ary-ptrn-rest-*`
  and any `built-ins/RegExp/S15.10.2.8_A3_T15.js`-style general
  `__module_init` sample — expect the null-deref to vanish (verdicts become
  honest pass/fail).
- Expect a LARGE standalone pass jump (most of the 789, minus the #2865
  subset) — coordinate baseline promotion like #3418.

### Standalone-native vs host-refusal
Pure codegen-typing fix; no host imports involved, benefits both lanes
(host lane keeps byte-identical output where inference is unchanged).
