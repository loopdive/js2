# Audit: helper lookups that emit nothing when the helper is missing (2026-11-19)

Head audited: main `89e47482`. Targets: `--target standalone` and `wasi`. No
fixes were made in this audit.

## Question

In some places codegen looks up a host import or an optional helper
(`ctx.funcMap.get(…)`, `ensureLateImport(…)`, `ctx.nativeStrHelpers.get(…)`)
and, when the lookup misses, emits nothing and carries on as if the
operation happened. Where does that give a silent wrong answer on the
no-host lanes?

#7401 is the motivating case. `compileExternPropertyGetFromStack` asked for
the host `Set_get_size`, found nothing on standalone, and left the receiver
standing in for the property.

## Answer

The pattern is rarer than the code shape suggests. Of about 410
guarded-emit sites in the 250 `src/codegen` files that have the shape,
**3 are confirmed** to produce wrong answers today, and 19 more (14 rows below) have the shape
but could not be reached from a program.

Why most sites cannot fire:

- **`ensureLateImport` never returns undefined on standalone/wasi.** It
  routes the name to a native helper (boxing and typeof helpers, the object
  runtime, iterators, `__box_symbol`, the `__new_*` errors), or it registers
  the import and queues a compile error. That clears about 50 sites.
- **The box, unbox, typeof and truthiness helpers are always native**,
  either directly or through `addUnionImports`.
- **The real risk is a bare `ctx.funcMap.get` of a host-only name.** The
  clearest case is `__get_undefined`, whose `ref.null.extern` fallback means
  `null`, not `undefined`, under the standalone undefined singleton.
- **Corpus check (half 1):** a miss-logging run over 7,200 of the 20,311
  test programs in `tests/**` (standalone) found none of 119 half-1
  candidate sites missing. This shows reachability, not proof.

## Confirmed (each re-run on standalone and wasi before writing this note)

| # | file:line | construct | helper | emitted instead | repro | ours / node |
|---|---|---|---|---|---|---|
| 1 | `src/codegen/property-access.ts:2621` (`compileExternPropertyGetFromStack`) | `s?.size` on a typed `Set \| undefined` / `Map` | `Set_get_size` / `Map_get_size` (host) | nothing: the receiver stands in for the property | `const s: Set<number> \| undefined = new Set([1, 2]); return s?.size ?? -1;` | NaN or invalid Wasm / 2. **Fixed by #7401, PR #7338.** |
| 2 | `src/codegen/index.ts:8084` (`padMissingArg`, used by `__call_next` / `__call_return` in `emitIteratorMethodExport`) | for-of / spread / array destructuring calls a class iterator's `next(v)` / `return(v)` without an argument | `__get_undefined` (host-only) | `ref.null.extern`, so the method sees `v === null`, not `undefined` | `class It{n=0;next(v?:any){this.n++;return{value:v===undefined?1:100,done:this.n>2}}[Symbol.iterator](){return this}} export function main(){let t=0;for(const x of new It())t+=x;return t}` | 200 / 2. Spread and `[a,b]=` give 200 / 2; `return(v)` on `break` gives 2 / 1. **Also wrong on gc** (200). |
| 3 | `src/codegen/expressions/operator-assignment.ts:1520` (else arm around 1545) | `s += <externref>` where the RHS is `unknown`/`any` holding a non-string | `__extern_toString` (looked up, never ensured) | a bare `ref.cast $AnyString`, with no ToString | `function g(): unknown { return 42; } export function main(): number { let s = "a"; s += g() as any; return s.length; }` | trap (illegal cast) / 3. This is [#7300](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7300-string-builder-loop-legacy-traps) item 2, and also #7389's remaining case. |

## Unconfirmed: the shape is wrong, but every reachable program had already registered the helper

| file:line | construct | helper | absent branch would… |
|---|---|---|---|
| `operator-assignment.ts:1497-1508` | `s += <number>` | `number_toString` | drop the number and append null (its comment calls this an "open gap") |
| `operator-assignment.ts:1271`, `:2155` | `str += num`, externref-string arms | `number_toString` | leave an f64 where externref is expected (invalid Wasm) |
| `array-methods.ts:6470` | extra `arguments` slots in an array HOF callback | `__box_number` | read `arguments[i]` as null (it missed in the corpus, but only in callees that never read `arguments`) |
| `index.ts:8090` | dynamic bridge call of a `void` class method | `__get_undefined` | answer `null`, not `undefined` (a wrong `null` was seen, but it comes from the call-site lowering, see below) |
| `index.ts:8114` | bridged method returning `boolean` | `__box_boolean` | box `true` as `1` |
| `index.ts:8509`, `:8513` | the `__call_@@toPrimitive` dispatcher | `__box_number` | leave an f64 for externref (invalid Wasm) |
| `native-construct.ts:444` | `new F()` where F returns an object | `__typeof_object` | ignore the returned object |
| `regex-replace-fn.ts:222`, `:583` | `replace(re, fn)` offset argument | `__box_number` | pass offset as null |
| `statements/nested-declarations.ts:3916`, `:3921` | extra arguments through `arguments` | `__box_number` | read them as null |
| `object-runtime.ts:11574` | array-like with an object `length` | `__to_primitive` and others | use length 0 |
| `object-runtime-proxy.ts:663`, `:1653`; `object-runtime.ts:7454` | Proxy invariants, revoked proxy | `__typeof_object`, `__new_TypeError` | skip the TypeError |
| `object-ops.ts:2604` | Proxy `defineProperty` trap returning falsy non-null | `__is_truthy` | test with `ref.is_null` |
| `object-proto-tostring.ts:358` | `Object.prototype.toString.call(undefined)` | `__typeof_undefined` | skip the Undefined arm |
| `statements/destructuring.ts:515`, `:519` | nested default on an externref value | `__box_number` | store an f64 into an externref local (invalid Wasm) |

**Recommendation for these.** Make the absent branch loud: a compile error,
or an `ensureLateImport` of the native name. That makes "registered earlier
by luck" a checked property rather than a coincidence. It costs one line per
site, and the module bytes only change if a site ever actually misses.

## Wrong answers outside the pattern (found while probing; standalone and wasi; not triaged into issues yet)

| repro | ours / node | first cause found |
|---|---|---|
| `const e: any = new Error("m", { cause: 5 }); return e.cause;` | NaN / 5 (also `"cause" in e` false) | `new-builtin-globals.ts:933-939`: the standalone arm returns before InstallErrorCause, and `options` is evaluated then dropped |
| `const o: any = { x: 1 }; const k = "x"; o[k] += 5; return o[k];` | 1 / 6 (`o[k]++`: 1 / 2) | compound element write on `any` is lost; plain `o[k] = 6` works |
| `new Uint8Array(new ArrayBuffer(8), 2, undefined).length` | 0 / 6 | an explicit `undefined` length is read as 0 |
| `Uint8Array.from([1, 2, 3], undefined)` | trap / length 3 | an undefined mapfn is treated as present |
| `Array.prototype.reduce.call(undefined, f, 0)`, `indexOf.call(undefined, 1)` | no throw / TypeError | RequireObjectCoercible is missing |
| `[1, 2, 3].reduce(function (a) { return a + arguments[2]; }, 0)` | NaN / 3 | wrong `arguments` slot for reduce |
| `filter` on a holey array, summing `arguments[1]` | 6 / 3 | holes are visited |
| `new Set<bigint>()`, `add(1n)` twice | size 3 / 2 | Map/Set bigint keys compare by box identity |
| `class C{[Symbol.toPrimitive]():number{return 42}}`, `+(c as any) + 1` | NaN / 43 | — |
| `o + p` on two `any` objects with `valueOf` | 57 / 12 | — |
| `new (F as any)().a` where F returns `{a: 7}` | NaN / 7 | — |
| `o.m()` on `any` where `m` is a `void` method | `null` / `undefined` | call-site lowering (`call-receiver-method.ts`) |
| `function rd(a: any) { return a.g; }` on a class getter | NaN / 6 | — |
| `function call(o: any) { return o.m(); }`; `yield*` over a class iterator | uncaught Wasm exception / value | — |
| `const { toFixed } = (5 as any)` | not a function / function | — |

Route the optional-call rows separately: `s?.add`, `m?.set` and `s?.has` on
a typed Map/Set are silent no-ops. They are in #7395 (S7's lane).

## Method

- **Workers.** Two Opus subagents worked read-only on a detached
  `origin/main` checkout. The 250 files with the shape were split in half.
  Each worker:
  1. statically scanned for the `if (x !== undefined) <emit>` shape with no
     `else`;
  2. checked reachability: half 1 used a `Map.prototype.get` miss logger
     over 7,200 corpus programs; half 2 used WAT inspection;
  3. ran targeted probes on both targets, about 97 in half 1 and 7 case
     files in half 2, each with node's answer.
- **Lead check.** I re-ran the three confirmed rows and the top four
  outside-pattern rows myself before writing this note.
- **Rejections.** Each rejected site is listed with its reason in the
  workers' reports. Those reports were session scratch:
  `.tmp/audit-half1.md` and `.tmp/audit-half2.md` in the audit worktree.
  Their rejection lists are summarised here:
  - unreachable on standalone/wasi;
  - registered just before the lookup;
  - the absent branch is a correct alternative;
  - a host-only branch.
- **Limits.**
  - The static scan only finds the `if (x !== undefined)` shape.
  - Corpus coverage is about a third of `tests/**`.
  - Half 2 spot-checked rather than probed the class-member "early return
    then generic path" rows.
