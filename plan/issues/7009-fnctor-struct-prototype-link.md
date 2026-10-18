---
id: 7009
title: "standalone: a fnctor STRUCT prototype (`d.prototype = new __()` from TypeScript's `__extends`) is dropped by `__object_create`, so a runtime-value `new D()` loses every inherited method (Octane typescript: called value is not a function)"
status: done
completed: 2026-10-15
assignee: ttraenkler/extends-proto
sprint: current
created: 2026-10-15
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: constructor-functions, prototype, new
goal: standalone-gap
related: [6975, 6944, 6766, 6951, 4643]
loc-budget-allow:
  # 2026-10-15 (#7009) object-runtime.ts +2: one import and one call line that
  #   splice the struct-link arms right after the #6766 Proxy arms. The arms
  #   themselves live in the new src/codegen/object-model/struct-proto-link.ts.
  - src/codegen/object-runtime.ts
func-budget-allow:
  # 2026-10-15 (#7009) +1: the `fillStructProtoLinkArms` call beside `fillProtoLinkArms`.
  - src/codegen/object-runtime.ts::ensureObjectRuntime
import-cycles-allow:
  - largestSccSize: 710 # 2026-10-15 (#7009): the new object-model/struct-proto-link.ts is called from object-runtime.ts and reuses the #6766 walker-splice helpers in object-runtime-proxy-chain.ts, both already in the SCC
---

# A fnctor struct as `[[Prototype]]` of an ordinary `$Object`

## Problem

TypeScript's down-level `__extends` helper builds the subclass prototype with a
non-empty helper constructor:

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
export function run() { return new I().kind(); } // standalone threw "called value is not a function"; node: 7
```

`new __()` is a `$__fnctor___` struct. A static `new Identifier()` works (its
walk starts at the per-fnctor prototype global and re-enters a struct link via
#6944). A runtime-VALUE `new I()` goes through `__native_construct_N`, which
seeds an ordinary `$Object` with `__object_create(I.prototype)`. `$Object.$proto`
is `(ref null $Object)`, so the struct was stored as **null**: no inherited
method, `Object.getPrototypeOf` wrong, `instanceof` false. Same for
`Object.create(new F())` and `Object.setPrototypeOf(o, new F())`. This blocks
Octane `typescript` on standalone. #6975 fixed only the empty-body helper case
(at the `new` site, in direct-AST codegen); its "Remaining" section names this
non-empty case.

## Approach (shared runtime only — no direct-AST codegen change)

Generalized the #6766 Proxy LINK to fnctor structs:

- `__proto_link_wrap` (used by `__object_create`, `__object_setPrototypeOf{,_status}`)
  now also links any value `__fnctor_struct_proto_ok` accepts (a fnctor struct whose
  struct-link chain terminates): a fresh empty `$Object` with null `$proto` and the
  struct in the `protoLink` field. `__getPrototypeOf` answers the struct; two links
  compare by the linked object (`ref.eq` on `eq`, so it also serves Proxies).
- New `src/codegen/object-model/struct-proto-link.ts` splices one arm per walker,
  answering through #6944's forwarders: `__extern_get` →
  `__fnctor_struct_proto_get(link, key, ORIGINAL receiver)`, `__extern_has` →
  `__fnctor_struct_proto_has`, the implicit-terminal check → 0, `__isPrototypeOf`
  → continue from the struct via `__getPrototypeOf` (`__proto_link_chain_from`,
  now shared with #6766). A struct RECEIVER (`x instanceof D` with `D.prototype`
  a struct) walks V's chain generically.
- The #6766 Proxy arms now TEST the link for `$Proxy` instead of null-checking it,
  so a struct link never reaches a Proxy dispatch and vice versa.
- Active only on standalone/WASI modules that reserved the #6944 helpers; gc
  output is byte-identical (sha256 of three probes, base vs head).

Not covered (link ends the walk, the pre-fix answer): an inherited setter or
non-writable data property reached through a struct link (a write still creates
an own property), and `for-in` over inherited keys through the link.

## Results

- `tests/issue-7009-fnctor-struct-prototype-link.test.ts`: 7 rows RED on base
  (47d9ff23b5), all 9 green on head (repro = 7, prototype identity, `constructor`,
  `instanceof`/`in`, `Object.create(new F())`, own-write isolation, Proxy + struct
  links in one module; guards: static fnctor fast path, empty-body helper).
- 88 related test files (fnctor / prototype / #2660 / #4506 / #4637 / #4643 /
  #6766 / #6944 / #6951 / #6975 / #3981 / …), file-copy A/B: no pass→fail; the
  base failures are pre-existing and identical on head except two that now pass:
  #6944 `structAncestorOwnFieldsAndReceiver` and the #4643 residual
  `fn-proto-argonly-in-operator` (flipped from "still fails" to a pin).
- The 6 standalone `tests/equivalence/` files: 87/87 pass.
