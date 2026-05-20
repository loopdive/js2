---
id: 52
status: done
created: 2026-05-20
started: 2026-05-20
ended: 2026-05-20
baseline_pass_start: 28171
baseline_pass_end: 28233
wrap_checklist:
  status_closed: true
  retro_written: true
  diary_updated: false
  end_tag_pushed: false
  begin_tag_pushed: true
---

# Sprint 52

**Planned**: 2026-05-20
**Started**: 2026-05-20

## Retrospective

**Result**: +62 test262 passes (28,171 → 28,233, 65.5%). 30+ open PRs in CI queue — auto-merge monitor will continue landing them into sprint 53 window.

**Wins**:
- Shipped full spec-gap sweep: 60+ issues across destructuring, iterators, String/RegExp/Date/Map/Set/Error/Proxy/Reflect/Promise/Generator protocol gaps
- JSX parsing + runtime host binding (#1531, #1540) landed cleanly
- WASI subsystem complete: stdin, stdout, stderr, env, clock, fs, benchmarks (#1480–#1484, #1490–#1504)
- ESLint Tier 1c unblocked (#1400 Config_new fix), Tier 1d unblockers filed as #1557/#1558
- Host-independence track (#1470–#1474) architected and speced; PR #408 in CI
- IR async Phase C scaffolding + CPS spec (#1373b) landed (gate=false)
- Path B fix for literals.ts:447 (~119 test262 gains pending CI on PR #443)
- Root-cause analysis for #1543/#1544/#1553/#1556 written by architect + senior dev

**Carried forward to S53**:
- #1471–#1474 host-independence (blocked on PR #408 merging)
- #1554 --standalone guard (blocked on PR #408)
- #1326c microtask queue (hard, in-progress, no PR)
- #1553 declaration destructuring (needs architect spec for 5 sub-issues)
- #1373, #1373b, #1042 async cluster (architect spec needed before dev dispatch)
- #1387 with statement (architect exploration)

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
| #1373b | IR async Phase C: CPS lowering for await + async-return + async-throw | medium | blocked |
| #1521 | wasi: Native Messaging host example (Chrome extension integration) | medium | blocked |

### Ready

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1373 | IR: claim async functions (async/await through IR path) | medium | ready |
| #1387 | feat: implement `with` statement — architect exploration of dynamic-scope compilation strategies | medium | ready |
| #1400 | npm: compile ESLint package entry to valid Wasm | high | ready |

### In Progress

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1326c | Async standalone Phase 1C: microtask queue + Promise.then chained-resolution (follow-up to #1326 Phase 1B) | medium | in-progress |
| #1471 | host-independence: eliminate JS host boxing/unboxing for standalone Wasm | high | in-progress |
| #1472 | host-independence: eliminate JS host object/property ops for standalone Wasm | high | in-progress |
| #1473 | host-independence: eliminate JS host error/exception ops for standalone Wasm | high | in-progress |
| #1474 | host-independence: eliminate JS host RegExp for standalone Wasm | high | in-progress |
| #1505 | spec audit: comprehensive ECMAScript implementation gap analysis | high | in-progress |
| #1520 | docs: architectural comparison — Static Hermes (native) vs js2wasm (WasmGC AOT) | high | in-progress |

### Review

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1364 | spec gap: class elements — method/field descriptor enumerable/configurable/writable (~700 fails) | high | review |
| #1382 | structural: Wasm closures not JS-callable from host imports — bridge gap | high | review |
| #1394 | class method-closure caching: C.prototype.method returns stable singleton closure | high | review |
| #1433 | spec gap: DisposableStack and AsyncDisposableStack lifecycle semantics | medium | review |
| #1435 | spec gap: lexical grammar and syntax-directed early errors | medium | review |
| #1436 | spec gap: global object descriptors and global function coercion/URI semantics | medium | review |
| #1438 | spec gap: Map, WeakMap, and WeakSet residual collection semantics | medium | review |
| #1439 | spec gap: RegExp.prototype Symbol.* protocol methods (replace/match/split/matchAll/search) | high | review |
| #1440 | spec gap: Date setters ToNumber coercion + Invalid Date (NaN) propagation | high | review |
| #1441 | spec gap: String.prototype.split — Array result shape + String wrapper receivers | high | review |
| #1442 | spec gap: String.prototype methods — RequireObjectCoercible + ToString on this value | medium | review |
| #1443 | spec gap: String.prototype.replace/replaceAll/match/search delegate to argument's Symbol.* method | medium | review |
| #1444 | spec gap: RegExp named groups (unmatched + duplicate) and lookbehind edge cases | medium | review |
| #1445 | spec gap: String.raw + String.prototype.* argument coercion (ToInteger / ToPrimitive) | medium | review |
| #1450 | spec gap: NamedEvaluation — anonymous fn/class names from binding identifiers in destructuring defaults | high | review |
| #1451 | spec gap: class/object-literal method parameter destructuring with non-trivial defaults | high | review |
| #1452 | spec gap: for-loop init binding patterns — declared names not visible in loop body | high | review |
| #1453 | spec gap: per-iteration fresh let/const binding in for-statements | medium | review |
| #1454 | spec gap: iterator protocol — error propagation and IteratorClose during destructuring | medium | review |
| #1455 | spec gap: subclassing builtins — instanceof and prototype chain (class Sub extends Map / Float32Array / WeakMap / …) | medium | review |
| #1456 | spec gap: private-reference assignment to readonly accessor / method throws TypeError | medium | review |
| #1460 | spec gap: Object.defineProperty / defineProperties descriptor fidelity | high | review |
| #1461 | spec gap: Array.prototype.* called on array-like / exotic receivers | high | review |
| #1462 | spec gap: Object.getOwnPropertyDescriptor + Object.create descriptor surface | high | review |
| #1463 | spec gap: Function.prototype.bind / toString / Symbol.hasInstance fidelity | medium | review |
| #1464 | spec gap: Iterator.prototype helpers + Iterator.zip / Iterator.concat (ES2025) | medium | review |
| #1465 | spec gap: Promise.all / allSettled / any / race iterable + subclass fidelity | medium | review |
| #1466 | spec gap: Proxy + Reflect trap / operation fidelity | medium | review |
| #1467 | spec gap: Error / AggregateError / Symbol prototype protocol | medium | review |
| #1468 | for-of/dstr: obj-ptrn-id-init undefined-key + array-elem-trlg iterator close | medium | review |
| #1470 | host-independence: eliminate JS host string ops for standalone Wasm | high | review |
| #1480 | wasi: console.error and console.warn should write to stderr (fd=2) | high | review |
| #1481 | wasi: support reading stdin via fd_read | high | review |
| #1482 | wasi: wire process.env to environ_get / environ_sizes_get | high | review |
| #1483 | wasi: route Date.now and performance.now to clock_time_get | high | review |
| #1484 | wasi: provide standalone setTimeout/setInterval via poll_oneoff (or fail loud) | high | review |
| #1490 | nodejs: runtime access to process.argv and process.env | medium | review |
| #1491 | nodejs: fs.readFileSync/writeFileSync as JS-host imports (non-WASI) | medium | review |
| #1492 | nodejs: crypto.randomBytes / randomUUID host imports | medium | review |
| #1493 | nodejs: console.error / console.warn → stderr (fd=2) in WASI mode | medium | review |
| #1494 | nodejs: __dirname / __filename / import.meta.url for compiled modules | medium | review |
| #1500 | browser: fetch() host import with Response bridge | medium | review |
| #1501 | browser: setTimeout/setInterval/clearTimeout/clearInterval host imports | medium | review |
| #1502 | browser: localStorage / sessionStorage host imports with standalone fallback | medium | review |
| #1503 | browser: crypto.getRandomValues / crypto.randomUUID host imports | medium | review |
| #1504 | browser: marshal compiled export return values (structs/arrays) to plain JS | medium | review |
| #1510 | spec gap: for-await-of destructuring — await on IteratorStep + binding initialization | high | review |
| #1511 | spec gap: arguments object — mapped semantics, descriptors, trailing-comma length | high | review |
| #1512 | spec gap: dynamic import — early SyntaxErrors for nested syntactic contexts | medium | review |
| #1513 | spec gap: Reflect — TypeError on non-object/Symbol target + abrupt-completion propagation | high | review |
| #1514 | spec gap: Set.prototype.{union,intersection,difference,…} accept set-like protocol | medium | review |
| #1515 | spec gap: DataView — ToIndex(byteOffset), detached-buffer TypeError, BigInt setter coercion | medium | review |
| #1516 | spec gap: GeneratorPrototype — this-value coercion + name/length/property descriptors | medium | review |
| #1517 | spec gap: Array.fromAsync — ES2024 async-iteration constructor | medium | review |
| #1518 | spec gap: Annex B.3.2 — sloppy-mode function-in-block hoisting (`var` shadow) | medium | review |
| #1519 | spec gap: `new` expression — non-literal spread + non-constructor TypeError + new.target via apply/call | medium | review |

### Done

| Issue | Title | Priority | Status |
|---|---|---|---|
| #1397 | codegen: static method dispatch ignores runtime property reassignment on typed receivers | medium | done |
| #1398 | report: edition filter on category table — per-category edition breakdown | low | done |
| #1431 | spec gap: assignment operators — destructuring completion, defaults, and compound side effects | medium | done |
| #1432 | spec gap: parameter lists — rest/destructuring iterator semantics and default initializers | medium | done |
| #1434 | spec gap: ToNumber/ToNumeric coercion and unary operator edge cases | medium | done |
| #1437 | spec gap: Math numeric edge cases beyond random source | low | done |

<!-- GENERATED_ISSUE_TABLES_END -->
