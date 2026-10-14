---
id: 6987
title: "standalone: Octane `typescript` — module-init chunk crash from a resurrected inline-IIFE parameter slot, `process.*` host-import leaks, and lost prototype methods on capturing namespace constructors"
status: done
completed: 2026-10-14
assignee: ttraenkler/octane-typescript
sprint: current
created: 2026-10-14
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: closures, iife, module-init, process, function-constructors
goal: standalone-gap
related: [4376, 6675, 2660, 2961, 1177, 6910]
loc-budget-allow:
  # 2026-10-14 (#6987) property-access-dispatch.ts +6: the host-free `process.*`
  #   fall-through beside the existing `process.env` stand-in (same predicate).
  - src/codegen/property-access-dispatch.ts
  # 2026-10-14 (#6987) arrow-phases.ts +4: import + the module-scope guard in the
  #   #1177 by-name slot rescan; the predicate lives in closures/module-scope-binding.ts.
  - src/codegen/closures/arrow-phases.ts
  # 2026-10-14 (#6987) types.ts +3: the `nestedFnValueGlobals` registry field.
  - src/codegen/context/types.ts
func-budget-allow:
  # 2026-10-14 (#6987) +3: the module-scope guard inside the rescan loop.
  - src/codegen/closures/arrow-phases.ts::planClosureCaptures
---

# Octane `typescript` on `--target standalone`

Goal: compile the Octane `typescript` driver (Octane base.js + typescript.js +
typescript-input.js + typescript-compiler.js, ~26k lines) with
`target: "standalone"`, instantiate it with no imports, and run `octane_run(1)`.

On `main` the compile failed outright. Three root causes are fixed here; two
more blockers remain and are recorded at the end — the benchmark does **not**
run yet.

## Fixed

### 1. Module-init chunk crash: a closure captured a dead inline-IIFE parameter

`Codegen error: stack-balance invariant (entry): '__module_init_chunk_40'
references local 8563, but only 0 params + 16 locals are declared`.

TypeScript's namespace emit `(function (TypeScript) {…})(TypeScript ||
(TypeScript = {}))` is inlined into `__module_init`. The IIFE's binding scope
is closed correctly (`enterInlineIifeBindingScope` deletes `TypeScript` from
`localMap`), but the parameter's local *slot* — still named `TypeScript` —
stays in `fctx.locals`. A later closure (`CommandLineHost.prototype.… =
function () { … TypeScript … }`) reading the module-scope `var TypeScript`
missed `localMap`, and the #1177 by-name rescan in `planClosureCaptures`
resurrected that dead slot: the closure captured the IIFE parameter and boxed
it, re-binding `TypeScript` in the module-init frame to the box. Two effects:

- **Wrong value:** later top-level writes to `TypeScript` went to the box, so the
  module global stayed stale (`NS = {a: 2}` after the namespace IIFE; an exported
  function then read `NS.a === 1`).
- **Crash:** `BatchCompiler`'s lifted constructor recorded the box slot as a
  capture during pass 1 (one init body). With module-init chunking (#4376) the
  class IIFEs land in a later chunk whose frame has no such slot, so the
  reserved capture ABI pointed at local 8563 of a 16-local chunk.

The rescan exists for block-scoped `let`/`const` slots whose `localMap` entry the
block-shadow manager removed. A binding declared at module scope is never such a
slot, so the rescan now skips names whose referenced declaration is module-scope
(`closures/module-scope-binding.ts`). The closure then reads the module global.

### 2. `process.*` host imports in a host-free build

`process.stdout` / `process.stderr` / `process.argv` (and `platform`/`arch`) in
the TypeScript compiler's Node IO adapter lowered to `env.__get_process_*`
JS-host getters even under `--target standalone`, where #2961 forbids them. The
code is only reached under `typeof require === "function"`. A host-free module
has no `process`: these reads now fall through to the ordinary
unresolvable-global lowering (ReferenceError on read, `typeof process ===
"undefined"`), exactly like `process.exit` already did. `process.env` keeps its
empty stand-in object (#6910). The gate is the same predicate the `env` arm
uses, so the JS-environment native regime (#6910) is unchanged.

### 3. Capturing constructor inside a namespace IIFE lost its prototype methods

```js
var NS; (function (NS) {
  var K = 3;
  var Table = (function () {
    function Table() { this.k = K; }       // captures K → memoized in a LOCAL
    Table.prototype.add = function () { … };
    return Table;
  })();
  NS.Table = Table;
})(NS || (NS = {}));
new NS.Table().add();   // TypeError: called value is not a function
```

A capturing nested function is memoized in a frame local
(`emitMemoizedNestedFnClosure`), so it had no `__closure_proto_of` identity key
(#2660 M3 keys edges by a module-global singleton). The static
`Table.prototype.add = …` wrote the per-fnctor prototype global, while the
dynamic `new NS.Table()` linked the instance through the closure's own
`prototype` bag entry — the TypeScript compiler's `StringHashTable` instances
had no methods. The memoized value of a constructible nested function is now
also published into a per-name module global (`__fn_value_<name>`) at creation,
and the edge collector uses it as the identity key. A function with no edge
keeps its previous answer; a later activation overwriting the global only makes
an older value miss the edge (the old behaviour), never match a wrong one.

## Not fixed — remaining blockers

### A. `env.__timer_set_timeout` (policy conflict, not a codegen bug)

The single-source preprocessor injects the #1501 timer shim for every target
but WASI, so the dead `setTimeout(…)` call in the Node IO adapter keeps an
`env.__timer_set_timeout` import. #6675 made timers unresolvable globals on
`compileProject` standalone builds, but the single-source path deliberately
keeps the import as an embedder capability: `tests/issue-4588-standalone-
timer-shim-cutover.test.ts` ("preserves artifact and numeric timer-handle
runtime behavior against the direct control") pins an uncertified standalone
`setTimeout(tick, ms)` working against a provided `setTimeout`, and its
byte-parity tests compare the IR-owned shim with the legacy shim. Lowering the
shim to ReferenceError (as #6675 does) was prototyped and breaks 4588/4573.
Needs a decision: either standalone timers are absent (then 4588's pins change
and the IR timer-shim route needs the same gate), or the Octane harness accepts
the `timers` embedder capability.

### B. `D.prototype = new G()` with a non-empty `G` breaks dynamic `new`

TypeScript's `__extends` does `function __() { this.constructor = d; }
__.prototype = b.prototype; d.prototype = new __();`. A fnctor with a non-empty
body is not reconstructed as `$Object` (#2660 S3a), so `new __()` is a bespoke
struct. The dynamic construct driver (`__native_construct_N`) seeds the instance
through `__object_create(proto)`, which keeps a proto only when it is an
`$Object` and otherwise stores null — the instance ends up on
`Object.prototype` and every inherited method is missing (`this.setText(…)` in
`Identifier`'s constructor throws). Minimal repro:

```js
var __extends = function (d, b) {
  function __() { this.constructor = d; }
  __.prototype = b.prototype; d.prototype = new __();
};
function AST(n) { this.nodeType = n; }
AST.prototype.kind = function () { return this.nodeType; };
function Identifier() { this.nodeType = 7; }
__extends(Identifier, AST);
var I = Identifier;
export function probe() { return Object.getPrototypeOf(new I()) === Identifier.prototype ? 1 : 0; } // 0, want 1
```

The static `new Identifier()` path works; only the runtime-value construct
loses the link. A fix needs struct instances to be valid `[[Prototype]]` values
of an `$Object` (or reconstruction of non-empty constructors whose instances are
stored as a `.prototype`) — #2660-scale work, out of scope here.

Further failures may sit behind B: the run stops at the first one.

## Validation

- Full driver (`.tmp/` copy, harness options): compiles (`success: true`, ~12 min);
  imports are `env.__timer_set_timeout` plus the two `js2wasm:runtime-eval`
  imports the harness links. With throwing stubs for every import,
  `octane_run(1)` throws `TypeError: called value is not a function` at
  blocker B (traced to `Identifier`'s constructor via `JS2WASM_TRACE_LAST_STMT`).
- `tests/issue-6987-octane-typescript-standalone.test.ts`: 4 cases, all fail on
  the base and pass with the fix.
