---
id: 6616
title: "A spread call into a STATIC or OBJECT-LITERAL method bound the spread source as one argument — and a static `...rest` formal arrived null"
status: in-progress
sprint: current
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
goal: standalone-gap
parent: 5383
assignee: ttraenkler/senior-dev-s29
loc-budget-allow:
  # 2026-09-15 — inherited from #6612–#6615 (the S25–S28 stack this branch is
  # based on), restated here because the LOC gate reads the allowance from a
  # file the PR touches and those issue files are not in this slice's diff.
  # `src/runtime.ts` sits at 19,822 against a 19,601 ceiling on the stack tip;
  # this slice adds nothing to it.
  - src/runtime.ts
  # 2026-09-15 — #6616's own growth. `call-namespace-static.ts` is the arm that
  # CLAIMS a static call through a class-object identifier; the missing spread
  # + rest ABI has to go where the call is emitted, and the alternative (a new
  # module) would have to re-derive `paramTypes`/`funcIdx`/`memberDecl` from
  # the same local scope. +32 lines, over half of them the comment recording
  # why the rest half cannot be split from the spread half.
  - src/codegen/expressions/call-namespace-static.ts
func-budget-allow:
  # 2026-09-15 — same inheritance: `buildImports` is 308 against a 300 ceiling
  # on the stack tip. Untouched by this slice.
  - buildImports
  # 2026-09-15 — #6616's own growth, the same +29 lines as the LOC grant above,
  # in the one function that emits this call. Splitting it would have to carry
  # `paramTypes`/`funcIdx`/`memberDecl`/`calleeReadsArgsEarly` across the seam
  # for a branch that is four `const`s and one `if`.
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
---

# #6616 — a spread call into a static or object-literal method never flattened

S29 of the standalone Temporal provider run (#5383, criterion 4). Base:
`issue-5383-standalone-temporal-s28` @ `11fcafe07c`.

## The defect

Two halves of the known-callee argument ABI were missing from the arms that
claim a call whose callee is a **static method reached through a class object**
or an **object-literal method**. The instance-method arm has had both for a
long time; these two never did.

### (a) A spread argument was bound as ONE positional argument

```js
const H = { m2(a, b) { return a + "/" + b; } };
const xs = [1, 2];
H.m2(...xs);            // base: "1,2/undefined"  — the ARRAY landed in `a`
H.m2(...[1, 2]);        // base: wasm VALIDATION FAILURE (tuple struct in `a`)

class K { static s2(a, b) { return a + "/" + b; } }
K.s2(...xs);            // base: "1,2/undefined"
```

Nothing flattened the spread: each argument **node** was bound to one formal, so
the spread source arrived whole and every later formal got its default. When the
source was an inline array literal its carrier is a tuple struct rather than a
vec, and the resulting call did not even validate — the module failed to
instantiate.

The shape that matters for #5383 is the forwarding idiom, which test262's
`temporalHelpers.js` uses throughout:

```js
const H = {
  m2(a, b) { … },
  fwd(...args) { return this.m2(...args); },   // base: "1,2/undefined"
};
```

### (b) A `static f(...rest)` formal arrived `null`

Independent of any spread, and with a trap rather than a wrong value:

```js
class K { static f(...args) { return args === null ? "NULL" : "ok"; } }
K.f(1, 2);              // base: "NULL"
class K2 { static f(...args) { return args.length; } }
K2.f(1, 2);             // base: TRAP dereferencing a null pointer
```

The static-through-a-class-object arm in `call-namespace-static.ts` never called
`knownMethodRestInfo` / `emitKnownRestMethodArguments`, so the hidden rest vec
was never materialised. Every other callee shape — object-literal method, plain
function declaration, instance method — was already correct, which is what makes
this a missing arm rather than a missing mechanism.

**(b) had to be fixed together with (a).** Fixing (a) alone turned
`static fwd(...args) { return K.m2(...args); }` from a wrong value into an
**uncatchable trap**: the flattened path actually reads `args`, which was null.
A trap is worse in kind than a wrong value, so shipping (a) without (b) would
have been a regression in the failure mode even where the row failed either way.

## The fix

Four arms gain the spread handling the instance arm already had, and one of them
also gains the rest ABI:

| file | arm | `paramOffset` | added |
| --- | --- | --- | --- |
| `call-namespace-static.ts` | static through a class-object identifier | 0 | spread **+ rest** |
| `call-receiver-method.ts` | static (class arm) | 0 | spread |
| `call-receiver-method.ts` | struct receiver, nullable | 1 | spread |
| `call-receiver-method.ts` | struct receiver, non-nullable | 1 | spread |

Each follows the instance arm exactly: try `compileSpreadCallArgsWithArguments`
first when the callee reads `arguments` (#5093 — it publishes a RUNTIME `__argc`
and the extras split), otherwise `compileSpreadCallArgs`; and gate the extras
loop, the default padding and `maybeSetArgcForKnownCall` off when either the
spread or the rest path claimed the arguments.

## Why the change is bounded

The new code is reached **only** at a call site that has a `SpreadElement`
argument, or a static callee that declares `...rest`. Every such site was
previously miscompiled — wrong value, or a module that did not validate, or a
null-deref trap. There is no site where the old path was right and the new path
differs, so the change is monotone by construction, not by sampling.

## Suspended / residual

- `typeof x` **in return position** answers `null` (and sometimes a wrong
  member of the union) inside the assembled test262 harness module, while it is
  correct in an ordinary module and in a linked pair. Found while
  instrumenting; not this slice's defect. Filed as a residual, reduced in
  `.tmp/s29/t/probe4.js` + `probe5.js`.
- Several object literals in ONE module still interfere: the same case that
  passes alone can fail to validate when other object literals with methods are
  present (`.tmp/s29/cases-f.mjs` vs `cases-g.mjs`, same expressions).
