---
id: 7161
title: "Native-first, standalone, wasi: a Proxy over a struct-backed target arrives as null inside a single-call-site function"
status: done
sprint: current
created: 2026-10-25
updated: 2026-10-31
completed: 2026-10-31
priority: medium
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: proxy
goal: correctness
parent: 6979
related: [7150, 4749, 7163]
loc-budget-allow:
  # 2026-10-31 (#7161): +7 lines — the import, the flag, the withdrawal check at
  # the typed-argument site and the one-line withdrawal; the predicate lives in
  # proxy-value-provenance.ts (proxyArgDefeatsRefNarrowing).
  - src/codegen/declarations/param-return-inference.ts
func-budget-allow:
  # 2026-10-31 (#7161): +6 lines in inferParamTypeFromCallSites — the Proxy-arg
  # flag, its 4-line record at the typed-argument site, and its withdrawal.
  - src/codegen/declarations/param-return-inference.ts::inferParamTypeFromCallSites
---

# #7161 — `new Proxy(new C(), {})` becomes wasm null when passed to a one-caller function

Found by the fresh-context review of PR #6915 (#7150, finding 1). Pre-existing
on `origin/main`, on gc native-first, standalone and wasi (host-assisted is
correct):

```js
class C { #v; static has(o) { return #v in o; } }
function t(label, o) {
  console.log(label, o === null);          // "proxyInst true"  (node: false)
  try { console.log(String(C.has(o))); } catch (e) { console.log("threw " + e.name); }
}
t("proxyInst", new Proxy(new C(), {}));    // node: "proxyInst false" / "false"
```

Same for `new Proxy(new Map(), {})`, `new Proxy(new Date(0), {})`,
`Proxy.revocable(new C(), {}).proxy`. Fine for `new Proxy({}, {})`,
`new Proxy([], {})` and a function target. With TWO call sites of `t` the
Proxy arrives intact; at top level `o === null` is false for the same value.
`"x" in o` on that null silently answers `false` instead of throwing (same
shape). Before #7150, `#v in null` returned `false`, which hid the defect.

## Cause (as diagnosed; verify before fixing)

The compiler specialises a function on its single call site's argument types.
A Proxy whose target is a struct-backed value is narrowed to the target's
struct type (or to the parameter's inferred type) and the conversion from the
Proxy carrier to that type yields null instead of keeping the externref. Site:
the single-call-site parameter specialisation
(`grep -rn "single call site\|singleCallSite\|specialis" src/codegen/ src/checker/`)
and the Proxy carrier representation (#4749 standalone Proxy source arm).

## Implementation Plan (Fable, 2026-10-25; implement on Opus)

1. Reproduce the program on the three no-host lanes; dump WAT for `t` and name
   the instruction that turns the Proxy into null (a failed `ref.cast`/
   `br_on_cast` or an `any.convert_extern` on a non-struct carrier).
2. Fix at the specialisation site: when the call-site argument value is (or
   may be) a Proxy carrier, keep the parameter at its dynamic representation
   (externref / anyref) instead of narrowing to the target struct; the brand
   test and `"x" in o` then run on the real value. Do not widen every
   parameter — only arguments whose static type admits a Proxy or whose value
   is a Proxy construction.
3. Tests: `tests/issue-7161-proxy-single-call-site.test.ts` with the program
   above, the Map/Date/revocable variants and the two-call-site control, on the
   three no-host lanes vs node; `"x" in proxy` and `proxy.x` reads inside the
   callee.

Acceptance: node's output on gc native-first, standalone and wasi; host-assisted
gc bytes unchanged; the equivalence gate reports no new regressions.

## Resolution (2026-10-31)

**Cause, confirmed.** `inferParamTypeFromCallSites`
(`src/codegen/declarations/param-return-inference.ts`) reads the call-site
argument's checker type. TS types `new Proxy(t, h)` as `t`'s type, so the site
agreed `o` onto `(ref null $C)` (`$Map`, `$Date` likewise). The argument is a
`$Proxy` carrier; the caller's boundary `ref.test (ref $C)` fails and its
`else` arm emits `ref.null $C`, so the callee got null. With two call sites the
value was nulled the same way when both sites agreed; it only survived when the
sites disagreed (a conflict withdraws the narrowing).

**Fix.** A call site whose argument `tracesToProxyValue` (`new Proxy(…)`,
`Proxy.revocable(…).proxy`, a single-initializer variable or single-return
helper call yielding one) now withdraws a GC-ref narrowing for that parameter,
which then stays `externref`. Scalar narrowings and every non-Proxy argument are
untouched. No classifier, `ref.test` legality or type API was changed.

**Tests.** `tests/equivalence/issue-7161-proxy-single-call-site.test.ts`, gc
native-first / standalone / wasi vs node: 12/12 on this branch, 3/12 on base
(the three passing on base are the controls).

**Not covered (different sites, all pre-existing):**

- A Proxy returned from a helper (`function mk() { return new Proxy(new C(), {}); }`):
  the parameter now stays externref, but `mk`'s own return type is narrowed to
  `$C` and the return nulls the Proxy.
- A Proxy stored in an array literal (`[new Proxy(new C(), {})]`) or an object
  literal field: the element/field store narrows to `$C`.
- A Proxy as `this` of a method call (`p.m()`): the method dispatch casts the
  receiver to `$C`.
- An explicitly annotated `function t(o: C)` called with a Proxy: the typed ABI
  itself is `$C`.
- wasi only: `"x" in p` / `p.x` on an empty-handler Proxy over a class instance
  answer `false` / `undefined` even at top level with no call involved.
