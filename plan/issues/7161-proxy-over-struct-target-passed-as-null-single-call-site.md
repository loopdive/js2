---
id: 7161
title: "Native-first, standalone, wasi: a Proxy over a struct-backed target arrives as null inside a single-call-site function"
status: ready
sprint: current
created: 2026-10-25
updated: 2026-10-25
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
