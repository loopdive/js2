---
id: 6856
title: "standalone: a TS class overriding `get(k: any)` on a Map subclass makes every `Map#get(...) === <number>` fold to false"
status: ready
sprint: current
created: 2026-10-05
updated: 2026-10-05
priority: medium
horizon: s
feasibility: medium
task_type: bug
area: compiler
goal: standalone-mode
---

## Problem

Found while fixing
[#6754](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6754-standalone-map-subclass-struct-layout).
This is a separate defect. It reproduces identically on `upstream/main`
b6324ee6d1, where no subclass has a field.

```ts
class M extends Map<any, any> {
  constructor() { super(); }
  get(k: any) { return super.get(k); }
}
export function t2(): number { const m = new Map<any, any>(); m.set("a", 5); return m.get("a") === 5 ? 1 : 0; }
export function t3(): number { const m = new M(); m.set("a", 5); const v = m.get("a"); return v + 1; }
```

`--target standalone`: `t2` returns 0 and `t3` returns `NaN`. Node returns 1 and
6. The WAT for `t2` compiles the comparison to a constant `i32.const 0`. The
plain `Map` receiver's `get` result is statically folded to "not equal",
apparently because the method-name resolution finds the TS override. The same
source as JS (`allowJs`) answers correctly once #6754's `super.get` fix is in.

## Acceptance

Both functions return the Node answers on the standalone lane. Add a
regression test that fails on the parent commit.
