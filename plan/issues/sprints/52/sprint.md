---
id: 52
status: active
created: 2026-05-20
started: 2026-05-20
wrap_checklist:
  status_closed: false
  retro_written: false
  diary_updated: false
  end_tag_pushed: false
  begin_tag_pushed: true
---

# Sprint 52

**Planned**: 2026-05-20
**Started**: 2026-05-20

## Theme

> **Spec-completeness continuation + wasm closure bridge** — carry forward 16 unstarted S51 issues covering spec gaps, IR async groundwork, wasm-callable closures, and method closure caching; merge the 10 pending compiler PRs (#341–350) from the branch audit.

## Carried over from S51 (ready/blocked)

#1326c microtask queue standalone, #1373 IR async function, #1373b IR async CPS (blocked on #1373),
#1382 wasm closure bridge, #1387 with statement, #1392 benchmark hang, #1394 method closure caching,
#1396 forof-dstr externref default, #1400 ESLint valid wasm,
#1431 assignment operators dstr, #1432 param list rest dstr, #1433 DisposableStack lifecycle,
#1434 ToNumber/ToNumeric coercion, #1435 lexical early errors, #1436 global object/functions,
#1437 Math numeric edge cases, #1438 Map/WeakMap/WeakSet residuals

## New in S52

- Merge audit PRs: #341 #342 #343 #344 #345 #346 #347 #348 #349 #350
- #1364 class descriptor escalation (unblock #1334 first)

<!-- GENERATED_ISSUE_TABLES_START -->
## Issue Tables

_Generated from issue files. Update issue `status`, then rerun `node scripts/sync-sprint-issue-tables.mjs`._

### Blocked

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1364 | spec gap: class elements — method/field descriptor enumerable/configurable/writable (~700 fails) | high | blocked |
| #1373b | IR async Phase C: CPS lowering for await + async-return + async-throw | medium | blocked |

### Ready

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1326c | Async standalone Phase 1C: microtask queue + Promise.then chained-resolution (follow-up to #1326 Phase 1B) | medium | ready |
| #1373 | IR: claim async functions (async/await through IR path) | medium | ready |
| #1382 | structural: Wasm closures not JS-callable from host imports — bridge gap | high | ready |
| #1387 | feat: implement `with` statement — architect exploration of dynamic-scope compilation strategies | medium | ready |
| #1394 | class method-closure caching: C.prototype.method returns stable singleton closure | high | ready |
| #1400 | npm: compile ESLint package entry to valid Wasm | high | ready |
| #1435 | spec gap: lexical grammar and syntax-directed early errors | medium | ready |
| #1436 | spec gap: global object descriptors and global function coercion/URI semantics | medium | ready |
| #1439 | spec gap: RegExp.prototype Symbol.* protocol methods (replace/match/split/matchAll/search) | high | ready |
| #1440 | spec gap: Date setters ToNumber coercion + Invalid Date (NaN) propagation | high | ready |
| #1441 | spec gap: String.prototype.split — Array result shape + String wrapper receivers | high | ready |
| #1442 | spec gap: String.prototype methods — RequireObjectCoercible + ToString on this value | medium | ready |
| #1443 | spec gap: String.prototype.replace/replaceAll/match/search delegate to argument's Symbol.* method | medium | ready |
| #1444 | spec gap: RegExp named groups (unmatched + duplicate) and lookbehind edge cases | medium | ready |
| #1445 | spec gap: String.raw + String.prototype.* argument coercion (ToInteger / ToPrimitive) | medium | ready |
| #1450 | spec gap: NamedEvaluation — anonymous fn/class names from binding identifiers in destructuring defaults | high | ready |
| #1451 | spec gap: class/object-literal method parameter destructuring with non-trivial defaults | high | ready |
| #1452 | spec gap: for-loop init binding patterns — declared names not visible in loop body | high | ready |
| #1453 | spec gap: per-iteration fresh let/const binding in for-statements | medium | ready |
| #1454 | spec gap: iterator protocol — error propagation and IteratorClose during destructuring | medium | ready |
| #1455 | spec gap: subclassing builtins — instanceof and prototype chain (class Sub extends Map / Float32Array / WeakMap / …) | medium | ready |
| #1456 | spec gap: private-reference assignment to readonly accessor / method throws TypeError | medium | ready |
| #1460 | spec gap: Object.defineProperty / defineProperties descriptor fidelity | high | ready |
| #1461 | spec gap: Array.prototype.* called on array-like / exotic receivers | high | ready |
| #1462 | spec gap: Object.getOwnPropertyDescriptor + Object.create descriptor surface | high | ready |
| #1463 | spec gap: Function.prototype.bind / toString / Symbol.hasInstance fidelity | medium | ready |
| #1464 | spec gap: Iterator.prototype helpers + Iterator.zip / Iterator.concat (ES2025) | medium | ready |
| #1465 | spec gap: Promise.all / allSettled / any / race iterable + subclass fidelity | medium | ready |
| #1466 | spec gap: Proxy + Reflect trap / operation fidelity | medium | ready |
| #1467 | spec gap: Error / AggregateError / Symbol prototype protocol | medium | ready |
| #1468 | for-of/dstr: obj-ptrn-id-init undefined-key + array-elem-trlg iterator close | medium | ready |
| #1470 | host-independence: eliminate JS host string ops for standalone Wasm | high | ready |
| #1471 | host-independence: eliminate JS host boxing/unboxing for standalone Wasm | high | ready |
| #1472 | host-independence: eliminate JS host object/property ops for standalone Wasm | high | ready |
| #1473 | host-independence: eliminate JS host error/exception ops for standalone Wasm | high | ready |
| #1474 | host-independence: eliminate JS host RegExp for standalone Wasm | high | ready |
| #1480 | wasi: console.error and console.warn should write to stderr (fd=2) | high | ready |
| #1481 | wasi: support reading stdin via fd_read | high | ready |
| #1482 | wasi: wire process.env to environ_get / environ_sizes_get | high | ready |
| #1483 | wasi: route Date.now and performance.now to clock_time_get | high | ready |
| #1484 | wasi: provide standalone setTimeout/setInterval via poll_oneoff (or fail loud) | high | ready |
| #1490 | nodejs: runtime access to process.argv and process.env | medium | ready |
| #1491 | nodejs: fs.readFileSync/writeFileSync as JS-host imports (non-WASI) | medium | ready |
| #1492 | nodejs: crypto.randomBytes / randomUUID host imports | medium | ready |
| #1493 | nodejs: console.error / console.warn → stderr (fd=2) in WASI mode | medium | ready |
| #1494 | nodejs: __dirname / __filename / import.meta.url for compiled modules | medium | ready |
| #1500 | browser: fetch() host import with Response bridge | medium | ready |
| #1501 | browser: setTimeout/setInterval/clearTimeout/clearInterval host imports | medium | ready |
| #1502 | browser: localStorage / sessionStorage host imports with standalone fallback | medium | ready |
| #1503 | browser: crypto.getRandomValues / crypto.randomUUID host imports | medium | ready |
| #1504 | browser: marshal compiled export return values (structs/arrays) to plain JS | medium | ready |

### In Progress

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1431 | spec gap: assignment operators — destructuring completion, defaults, and compound side effects | medium | in-progress |
| #1433 | spec gap: DisposableStack and AsyncDisposableStack lifecycle semantics | medium | in-progress |
| #1438 | spec gap: Map, WeakMap, and WeakSet residual collection semantics | medium | in-progress |

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1397 | codegen: static method dispatch ignores runtime property reassignment on typed receivers | medium | done |
| #1398 | report: edition filter on category table — per-category edition breakdown | low | done |
| #1432 | spec gap: parameter lists — rest/destructuring iterator semantics and default initializers | medium | done |
| #1434 | spec gap: ToNumber/ToNumeric coercion and unary operator edge cases | medium | done |
| #1437 | spec gap: Math numeric edge cases beyond random source | low | done |

<!-- GENERATED_ISSUE_TABLES_END -->
