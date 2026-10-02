---
id: 6704
title: "standalone: `ns.f(x)` misses the callee's real funcref when a JSDoc-optional param lowers to externref (lodash-es checksum null deref)"
status: done
sprint: Backlog
created: 2026-09-27
updated: 2026-09-27
completed: 2026-09-27
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6684, 3205, 5334, 4096, 6646]
loc-budget-allow:
  # 2026-09-27 (#6704): calls-closures.ts gains only the hooks into four new
  # classified modules (dispatch-extern-arg-bridge, dispatch-vec-result-bridge,
  # function-typed-property-call, callable-property-apply-fallback) plus their
  # imports; restated here so the grant does not strand on #6684's file.
  - src/codegen/expressions/calls-closures.ts
func-budget-allow:
  # 2026-09-27 (#6704): compileCallablePropertyCall gains the `Function`-typed
  # field hook, the vec-materializer reservation and the three apply-fallback
  # hooks (plan / receiver capture / raw tee / ladder wrap); every mechanism
  # lives in the new modules. emitRootFuncrefDispatch gains the missing-string
  # argument read and the vec result bridge (one line each + braces).
  - src/codegen/expressions/calls-closures.ts::compileCallablePropertyCall
  - src/codegen/expressions/calls-closures.ts::emitRootFuncrefDispatch
---

# #6704 — callable-property dispatch has no arm for the callee's externref-param ABI

## Problem

After #6684 the lodash-es npm-compat `standalone-dynamic` lane gets through
module init (0 imports) and fails at the checksum call (verbatim):

```
RuntimeError: dereferencing a null pointer   (phase: checksum)
```

The trap is in the harness driver's own `__npmCompatApply`:

```js
const __pkgNs = { words, kebabCase };
function __npmCompatApply(input) {
  return Number(__pkgNs.words(input).length + __pkgNs.kebabCase(input).length);
}
```

A direct `words(input)` call answers correctly; the PROPERTY call does not.

## Reproduction (standalone, `compileProject`, no runtime-eval needed)

```js
// w.js
var re = /[a-z]+/gi;
/**
 * @param {string} [string=''] The string to inspect.
 * @param {RegExp|string} [pattern]
 * @param- {Object} [guard]
 * @returns {Array}
 */
function words(string, pattern, guard) {
  string = string + '';
  pattern = guard ? undefined : pattern;
  if (pattern === undefined) return string.match(re) || [];
  return string.match(pattern) || [];
}
export default words;

// main.mjs
import words from "./w.js";
const ns = { words };
export function run() { try { return ns.words("a b c").length; } catch (e) { return -1; } }
```

Node: `3`. Standalone: `-1` (TypeError from the dispatch ladder's terminal arm).
Removing only the `@param {string} [string='']` line makes it pass.

## Root cause (measured)

`emitRootFuncrefDispatch` (`src/codegen/expressions/calls-closures.ts`) is
handed candidates derived from the property's TS signature — all with param 0
`(ref null $AnyString)`:

```
cands: (ref null $6, externref, externref) -> {ref null $2 | externref | void | f64 | i32}
```

but the compiled `words` (and its `__fn_tramp_words_cached`) takes
`(externref, externref, externref)` — the optional-with-default JSDoc param
lowers to externref in the body. No candidate names that funcref type, so the
ladder falls to its terminal TypeError; in the full lodash graph the call ends
in a null result instead and `.length` traps.

`callablePropertyRefBridge` also refuses `ref → externref` on the no-host
lanes (only generator states pass), so even an admitted candidate could not
bridge a native-string argument to an externref formal.

## Acceptance

- The repro answers 3 under `--target standalone`.
- lodash-es `standalone-dynamic` gets past the checksum call.

## Implementation Plan

Executed 2026-09-27 on the #6175 (#6684) branch, predecessor-stacked. The
issue's repro was the first of four defects on the same checksum call;
each was isolated with a small probe (`words`/`kebabCase` imported directly:
8 s compile; through `package/string.js`: 25 s; full `package/lodash.js`:
5–16 min), fixed in a new classified module, and pinned by a test that fails
on the parent.

1. **ref → externref crossing (the issue as filed).** On the no-host lanes
   `callablePropertyRefBridge` admits a GC reference argument into an
   `externref` formal as `extern.convert_any` (not `$AnyValue`, which needs
   its projection helper) — the same crossing `coerceType` performs. A null
   `$AnyString` is the compiler's missing-string sentinel, so the arm reads
   it as `undefined` (#4741): a padded optional `string` reaches the callee as
   `undefined`, not JavaScript `null`. Module: `dispatch-extern-arg-bridge.ts`.
2. **Array results.** A live arm whose callee returns `externref` while the
   call site expects a `__vec_*` array now calls the shared
   `__vec_from_extern_<T>` materializer (identity for the exact vec, copy for
   any other array carrier such as a match array) instead of #6684's guarded
   downcast, which answered null for anything but the exact type. The
   materializer is reserved at the call site before the ladder is emitted.
   Module: `dispatch-vec-result-bridge.ts`.
3. **`Function`-typed field.** lodash types every `createCompounder(...)`
   product `@returns {Function}`, which has no call signature, so
   `__pkgNs.kebabCase(input)` fell to the graceful tail: callee and argument
   evaluated, dropped, answer `undefined` (`.length` read 0). On the no-host
   lane a field whose oracle fact is `builtin Function` is now invoked with
   `__apply_closure(f, receiver, [args…])` (the #4096 / #6646 bridge),
   receiver evaluated once. Module: `function-typed-property-call.ts`.
4. **Non-wrapper callable value.** In a module graph containing a dynamic
   `Function(params, body)` (lodash's `template`), the imported `words` value
   read back into `{ words, kebabCase }` is callable but is not a
   funcref-wrapper struct. The ladder's root cast gave null, the nullish
   check passed (the raw value is not nullish) and `struct.get $root 0`
   trapped — the lane's `dereferencing a null pointer`. The multi-candidate
   path now keeps the raw value and wraps the ladder in one test: root cast
   failed → `__apply_closure(raw, receiver, argv)` with the result converted
   to the ladder's type (materializer / guarded downcast; a numeric result keeps the old path);
   otherwise the ladder runs unchanged. Helpers are reserved before emission;
   the ladder is emitted into the live body and only then moved into the
   else arm. Module: `callable-property-apply-fallback.ts`.

JS host: every change is gated on `standalone || wasi`; the JS-host lane's
emission is unchanged.

## Resolution

Lane `npx tsx scripts/generate-npm-compat-report.mjs --only lodash-es
--no-write --perf-only --lane standalone-dynamic`, same machine:

| | status | detail |
|---|---|---|
| before (#6175 head + main, measured) | `optimization-error` | `wasm-opt -O4 did not produce the measured artifact: wasm-opt -O4 failed: unexpected expr type` (Binaryen `Flatten.cpp:231`) |
| step 1 only (measured) | `runtime-error` | `RuntimeError: dereferencing a null pointer`, phase `checksum` |
| after | `measured` | checksum 54 = 54, 0 imports, ratio 0.036 (wasm 255 µs vs node 7.7 µs per op), compile 863 s |

The table is measured on the pre-merge base (`c2601efa89` + the #6175 branch).
After merging main `37b11b2891` the lane stops EARLIER, at module init,
verbatim `TypeError: Cannot access property on null or undefined at 10:22`
(phase `module-init`) — and main's own `calls-closures.ts` (without this
change) fails identically, so that is drift on main, filed as
[#6720](6720-standalone-lodash-es-module-init-null-property-regression.md).

Next blockers, in order: #6720 (module-init, on main); then CI's full refresh
runs this lane in a child with a 120 s budget (`standaloneLaneInChild`) that
the local `--only` run does not apply, verbatim: `standalone-dynamic lane
exceeded the 120000ms harness budget (compile-budget)` — the full
`package/lodash.js` graph compiles in 5–14 min standalone.

Regression tests (`tests/issue-6704-callable-property-optional-param.test.ts`,
`tests/issue-6704-callable-property-apply-fallback.test.ts`,
`tests/issue-6704-callable-property-non-wrapper-value.test.ts` — the last uses
a bound function, the same non-wrapper shape as the runtime-eval-scope value
with a far lighter compile, so every file fits the 512 MB default fork heap;
main's own `calls-closures.ts` traps on it with `dereferencing a null
pointer`): parent 0/4,
fix 4/4. The missing-string row also discriminates the sentinel mapping
(plain `extern.convert_any` answers 304, i.e. `"null"`; the fix answers 309).

Scoped standalone test262 (`scripts/run-test262-paths.mts --standalone`, 927
rows: `language/expressions/call`, `language/expressions/object/method-definition`,
`language/expressions/property-accessors`, `language/arguments-object`,
`built-ins/Function/prototype/{call,apply,bind}`, `built-ins/String/prototype/match`):
parent 732 pass / 129 fail / 66 CE, fix 732 / 129 / 66 — 0 losses, 0 gains,
0 per-row status changes. JS-host control: lodash dogfood 59/62 (unchanged).

Residual (not taken here): the SINGLE-candidate callable-property path has
the same guarded-cast-then-`struct.get` shape and would trap on a
non-wrapper value the same way; no current lane reaches it.
