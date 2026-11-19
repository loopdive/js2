---
id: 7414
title: "Tracking: 15 wrong answers (most also on gc) found during the missing-helper audit (one row per bug)"
status: ready
sprint: current
created: 2026-11-19
updated: 2026-11-19
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7413, 7395, 7389, 7300]
---

# #7414: wrong answers found during the missing-helper audit

These turned up while probing for the "missing helper → emit nothing"
pattern (`plan/log/missing-helper-silent-emit-audit-2026-11-19.md`). They
have **other causes**: a miss-logging trace showed no helper lookup failing
for them.

Each row is a separate bug, so a lane can take one row and file it as its
own issue when it starts. Context:

- Measured on main `89e47482`, `--target standalone`, `wasi` and `gc` (the
  JS environment). Each repro below was re-run with exactly the source shown,
  on 2026-11-19.
- "Suspected site" is a first lead, not a verified root cause.
- **P** marks the five to take first.

| # | P | construct | repro (`export function main(): number { … }` unless shown) | ours (standalone, wasi / gc) | node | suspected site |
|---|---|---|---|---|---|---|
| 1 | **P** | `Error` options `cause` | `const e: any = new Error("m", { cause: 5 } as any); return e.cause;` | NaN / NaN | 5; true | `src/codegen/expressions/new-builtin-globals.ts:933-939`: the standalone `isWasiErrorName` arm returns before InstallErrorCause, so `options` is evaluated and then dropped |
| 2 | **P** | compound assignment to a computed member of an `any` object | `const o: any = { x: 1 }; const k = "x"; o[k] += 5; return o[k];` | 1 / 1 (`o[k]++`: 1) | 6 (`o[k]++`: 2) | the compound element write is lost; plain `o[k] = 6` works. Possibly a sidecar-vs-struct write split |
| 3 | **P** | TypedArray constructor with an explicit `undefined` length | `return new Uint8Array(new ArrayBuffer(8), 2, undefined).length;` | 0 / 0 | 6 | an explicit `undefined` length is read as 0 (§23.2.5.1.3 step: length `undefined` → buffer length − offset) |
| 4 | **P** | `Set`/`Map` with bigint keys | `const s = new Set<bigint>(); s.add(1n); s.add(1n); return s.size;` | 2 / 2 | 1 | keys compare by box identity, not SameValueZero. Map bigint keys likewise |
| 5 | **P** | `Symbol.toPrimitive` on a class | `class C { [Symbol.toPrimitive](): number { return 42; } } const c: any = new C(); return +c + 1;` | NaN / NaN | 43 | the `__call_@@toPrimitive` dispatcher result path (`src/codegen/index.ts:8509`); not a missing helper |
| 6 |  | `TypedArray.from` with an `undefined` mapfn | `return Uint8Array.from([1, 2, 3], undefined as any).length;` | trap / trap | 3 | an `undefined` mapfn is treated as present |
| 7 |  | `Array.prototype` method `.call(undefined)` | `try { Array.prototype.reduce.call(undefined as any, (a: any) => a, 0); return 0; } catch { return 1; }` (also `indexOf.call`) | 0 / 0 (no throw) | 1 (TypeError) | RequireObjectCoercible missing in this lowering |
| 8 |  | `arguments` in a `reduce` callback | `return [1, 2, 3].reduce(function (a: number) { return a + (arguments[2] as any); }, 0);` | NaN / NaN | 3 | wrong `arguments` slot order for reduce's (acc, value, index, array) |
| 9 |  | `filter` over a holey array | `const a: any[] = new Array(4); a[1] = 1; a[2] = 2; let t = 0; a.filter(function () { t += arguments[1]; return true; }); return t;` | 6 / 6 | 3 | holes are visited (§23.1.3.8 HasProperty skip) |
| 10 |  | `+` on two `any` objects with `valueOf` | `const o: any = { valueOf() { return 5; } }; const p: any = { valueOf() { return 7; } }; return o + p;` | 57 / 57 | 12 | ToPrimitive with the default hint, then string concatenation instead of numeric addition |
| 11 |  | `new F()` where `F` returns an object | `function F(this: any): any { return { a: 7 }; } return new (F as any)().a;` | **not reproduced**: 7 / 7 with this repro. The worker saw NaN with a different shape; unconfirmed | 7 | the returned object is used through a struct cast of the result (`native-construct.ts`) |
| 12 |  | dynamic call of a `void` method | `class C { m(): void {} } const o: any = new C(); return o.m() === undefined ? 1 : 2;` | 2 / 2 (null) | 1 | call-site lowering answers `ref.null.extern` (likely `call-receiver-method.ts`) |
| 13 |  | dynamic read of a class getter | `class C { get g() { return 6; } } function rd(a: any) { return a.g; } return rd(new C());` | NaN / 6 (gc correct) | 6 | — |
| 14 |  | dynamic method call through `any`; `yield*` over a class iterator | `function call(o: any) { return o.m(); }` with `class C { m() { return 3; } }`, then `call(new C())`; and `function* g() { yield* new It(); }` | uncaught Wasm exception / 3 (gc correct) | 3; the iterated values | — |
| 15 |  | destructuring a method off a boxed primitive | `const { toFixed } = (5 as any); return typeof toFixed === "function" ? 1 : 0;` | 0 / 0 | 1 | — |

**Not in this list, tracked elsewhere:**

- optional method calls on a typed Map/Set (`s?.add`, `m?.set`, `s?.has`)
  → #7395;
- `s += <any non-string>` traps → #7300 item 2 / #7389;
- the omitted iterator `next(v)` argument → #7413.

## Acceptance (per row, when taken)

- A test pins node's answer on gc, standalone and wasi.
- Byte identity on a sample: only the affected programs may change.
- The row is struck through here with a link to the fixing PR.
