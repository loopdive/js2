---
id: 6627
title: "standalone: `Reflect.X(...)` seeded the whole-program `numericFunctions` name-keyed oracle, corrupting any local defined from a Proxy trap (or other method) literally named `get`/`set`/`has`/… — does NOT close #5383's `Proxy get trap is not callable` bucket"
status: done
sprint: current
priority: medium
horizon: s
feasibility: hard
reasoning_effort: max
goal: standalone-gap
parent: 5383
completed: 2026-09-17
assignee: ttraenkler/sendev-s40
loc-budget-allow:
  # 2026-09-17 (S40) — `numeric-property-analysis.ts` grows 39 lines: a new
  # `NON_INSTANCE_GLOBAL_NAMESPACES` constant (with its doc comment explaining
  # the self-reinforcing fixpoint it closes) plus a one-line guard at the
  # single call site that consults it. No new mechanism — it narrows an
  # existing name-keyed heuristic (#4122) to exclude global namespace objects
  # it was never meant to cover.
  - src/codegen/numeric-property-analysis.ts
---

## Problem

S40's dispatch brief targeted the `TypeError: Proxy get trap is not callable`
bucket (6 rows in the four-family acceptance sample, all in
`Duration/from/order-of-operations.js`, `PlainDate/from/order-of-operations.js`,
`PlainDate/from/observable-get-overflow-argument-primitive.js`,
`PlainDateTime/from/order-of-operations.js`,
`PlainDateTime/from/observable-get-overflow-argument-primitive.js`,
`ZonedDateTime/prototype/add/order-of-operations.js`).

Reducing `PlainDate/from/observable-get-overflow-argument-primitive.js`
(`TemporalHelpers.propertyBagObserver`'s `get` trap, which does
`const result = Reflect.get(target, key, receiver); … return result;` or
`return TemporalHelpers.toPrimitiveObserver(calls, result, …)`) surfaced a
REAL, independently-reproducible defect: any object-literal method literally
named `get` (the near-universal Proxy trap name) whose body stores the result
of a `Reflect.X(...)` call in a local before returning it gets that local
narrowed to an **f64** slot by the whole-program `numericFunctions` usage
oracle (`src/codegen/numeric-property-analysis.ts`, #4122) — even though the
value is a string/object/whatever `Reflect.get` actually read. Downstream this
is either a silently WRONG VALUE (a string result unboxed to a number and
back) or a hard WASM VALIDATION TRAP when the corrupted f64 local later flows
into a native-string struct read (`.length`).

## Root cause

`numeric-property-analysis.ts`'s `isNumeric` prover, for a call
`<identifier>.<name>(...)` where the receiver is a bare identifier NOT
`Math`/`Date` (#4122's own precedent), falls through to:

```js
if (ts.isIdentifier(recv)) return sets.numericFunctions.has(callee.name.text);
```

— "is `<name>` a function name that, EVERYWHERE in the program, only ever
returns a number" (the whole-program NAME-keyed oracle #4122 documents by
design). `Reflect` IS a bare identifier, and `Reflect.get`'s method name is
`"get"` — the SAME string as the near-ubiquitous Proxy trap name. The
`numericFunctions` set is SEEDED optimistically with every function/method
name in the program and PRUNED by a fixpoint that removes a name the moment
any of its declarations return something non-numeric. For an object-literal
method named exactly `get` whose own return is (directly or through a local)
the result of `Reflect.get(...)`, evaluating "is this return numeric" asks
`numericFunctions.has("get")` — and since THIS SAME METHOD's own
disqualification is what the fixpoint is trying to decide, the answer is
"not yet disqualified" ⇒ `true`, which is exactly the fact that keeps it
`true`: a self-reinforcing fixpoint with no external anchor.

`Reflect` (and `JSON`/`Object`/`Array`/`String`/`Number`/`Symbol`/`Promise`/
`Proxy`/`Intl`) are namespace objects — `<Namespace>.m(...)` is never "some
user class's `m` method the whole-program oracle should generalise over"; it
is always THE global static method. Fix: exclude these from the generic
bare-identifier-receiver fallback (`NON_INSTANCE_GLOBAL_NAMESPACES` in
`src/codegen/numeric-property-analysis.ts`), the same targeted narrowing
`Math`/`Date` already got for their own known-numeric arms.

## Reduction (minimal, single module, no link)

```js
export function probe() {
  var h = {
    get(target, key, receiver) {
      var result = Reflect.get(target, key, receiver);
      return result;
    }
  };
  var target = { overflow: "reject" };
  var v = h.get(target, "overflow", target);
  return typeof v === "string" ? v.length : -99;
}
```

Base tree: `WebAssembly.Module(): Compiling function #74:"probe" failed:
struct.get[0] expected type (ref null 6), found local.get of type f64`.
The SAME shape through a real `new Proxy(...)` trap traps with
`dereferencing a null pointer` instead (a different downstream consequence of
the same corrupted local). Fixed tree: `6` (`"reject".length`), both shapes.

Bisected via `wasm-dis`/an in-process WAT dump
(`emitWat`/`result.wat` — decoding the raw BINARY with `wasm-dis` fails on an
invalid module; `compileMulti({..., emitWat: true})` gives the pre-encode text
directly) and targeted `console.error` instrumentation (temporary, reverted)
at `ensureStructForType` (index.ts), `hoistVarDecl` (index.ts),
`call-receiver-method.ts`'s struct-method-call arm, and a `funcMap.set` trap —
which showed the callee (the `get` method itself) and the call site both had
the CORRECT externref types; only the CALLER's own `var v = h.get(...)` local
was f64, traced from `usageInferredLocalType`
(`src/codegen/statements/variables.ts`) → `ctx.usageInference.scalarForDecl`
→ `analyzeFunctionBody`'s `numericFunctions` fixpoint → the `isNumeric` arm
above.

## THIS DOES NOT CLOSE #5383'S TARGET BUCKET

Measured directly: the real test262 row's compiled artifact (`wasm_sha`) is
**byte-for-byte identical** with and without this fix
(`65ac37c6a67e`), and the row still fails with the identical error,
`TypeError: Proxy get trap is not callable`. The real trap
(`TemporalHelpers.propertyBagObserver`'s `get`) has an early `return
undefined;` branch, which is non-numeric and disqualifies `numericFunctions`
for the name `"get"` on its own — so the self-reinforcing fixpoint this issue
fixes was never actually engaged for the real corpus row. The minimal
reduction above needed a SIMPLER trap body (no early non-numeric return) to
hit it; the real harness's trap happens to avoid it by construction, not by
this fix.

## The bucket's REAL mechanism (found, NOT fixed — S40's residual)

Reduced independently, single module, no link — the exact real shape (multi
trap: `ownKeys`/`getOwnPropertyDescriptor`/`get`/`has`,
`TemporalHelpers.toPrimitiveObserver` call, `calls.push` side effects) works
**correctly** (`probeToString = 1`, `debugCallCount = 1` — the trap fires
exactly once) when compiled as a **plain, unlinked** module. The SAME source,
compiled as a **linked consumer** of ANY provider package — even a trivial
one (`export const NS = Object.freeze({ noop() { return 1; } })`), never
calling into it — breaks: `options.overflow` reads as if the `get` trap were
absent (`debugCallCount = 0`, the trap body never runs) and the final value is
neither the trap's answer nor the un-trapped target's raw value.

Reduced to the following minimal linked-consumer repro (`.tmp/s40/probe8.mts`
→ `probe9.mts` in the S40 worktree, not yet promoted to a checked-in test —
handed off below):

```js
// consumer, LINKED to any provider (content irrelevant, not even called):
var options = new Proxy({ overflow: "reject" }, {
  get(target, key, receiver) {
    return target[key]; // Reflect.get is NOT required to reproduce this
  },
});
export function probeToString() {
  var v = String(options.overflow);
  return v === "reject" ? 1 : -2; // answers -2 when linked, 1 when not
}
```

No Reflect, no `propertyBagObserver` wrapper, no `calls` array, module-scope
OR function-scope `new Proxy(...)` — all irrelevant. The ONLY variable that
flips the answer is whether the CONSUMER module has ANY package `link:`ed at
all (`ctx.standalone && peerNamespace(ctx) !== undefined`, i.e. whether
`emitStandaloneLinkReverseLocalTerminals`
(`src/codegen/standalone-link-reverse-peer.ts`) runs for this module).

**Hypothesis, not yet verified**: `ensureProxyRuntime`
(`object-runtime-proxy.ts`, called from `ensureObjectRuntime` around
`object-runtime.ts:6769`) "patches the `ref.test $Proxy` front-guard onto
`__extern_get`/`__extern_set`/`__extern_has`" — and
`emitStandaloneLinkReverseLocalTerminals` (called right after, `~6852`) also
reads/wraps `ctx.funcMap.get("__extern_get")` to build the CONSUMER's
`localGet`/`localKeys`/`localHas`/`localIsNull`/`localMethodCall` terminals
that get installed into the PROVIDER at `__module_init`. Both touch
`__extern_get`'s identity/body in the same narrow window; whether one
observes a stale copy of the other, or whether the terminal-install
`ref.func` captures shift something the Proxy dispatch relies on, was not
pinned down within this slice's ~2h budget — reducing further needs a WAT
diff of `__extern_get`/`__proxy_get_dispatch`/`__module_init` between the
linked and unlinked builds of the 9-line repro above, which is the next
slice's first step.

## Acceptance criteria (this slice)

- [x] `NON_INSTANCE_GLOBAL_NAMESPACES` fix in `numeric-property-analysis.ts`,
      landed and witnessed (`tests/issue-6627-reflect-namespace-numeric-inference.test.ts`,
      2 fix-witnesses fail on base / pass on fix by file-copy revert, 3 controls
      unchanged both trees).
- [x] `tests/issue-66*.test.ts` (28 files / 138 tests) pass together.
- [x] `npm run -s test:equivalence:gate` 22/1720/22, unchanged.
- [ ] The assigned bucket (`Proxy get trap is not callable`, 6 rows) is
      **NOT** closed — see above. Filed as the residual for the next slice,
      with the reduced linked-vs-unlinked repro and hypothesis above.

## Handover

- HEAD: this branch's tip (see PR).
- Worktree: `/home/user/js2/.claude/worktrees/agent-a3729a08b14b90f31`
  (`issue-5383-standalone-temporal-s40`, based on S39b's tip `9875b99735`).
- Next slice: WAT-diff `__extern_get` / `__proxy_get_dispatch` /
  `__module_init` between a linked and unlinked build of the 9-line repro in
  this file; the S40 probe scripts (`.tmp/s40/probe6.mts`…`probe9.mts`,
  `local19.mts`) are local-only (gitignored) but reproduce the finding
  directly if re-created from the snippets above.
