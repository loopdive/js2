# IR call-graph-closure census (stride 40, standalone, 2026-11-07)

This is a targeting census, not a change. The question: which **legacy
callees** keep otherwise-claimable units out of the IR through the Step-2
call-graph closure, and which single admission would unblock the most files?

## Method

- **Corpus.** main `b83a8ee0`, the wrapped stride-40 standalone ledger's file
  set: 1,295 test262 files, 1,159 with a selection graph.
- **Instrumentation.** A scratch worktree records the selector's real closure
  inputs at the top of the Step-2 closure in `src/ir/select-identity.ts`: the
  individually claimed set, local callees and callers, the units under the
  standalone legacy-caller rule, and the units with an external call. The
  closure is then replayed offline per file. With nothing admitted, the replay
  reproduces the selector's closure verdict for every function unit. The only
  differences are units the closure keeps that a later stage withdraws
  (`late-preparation-unsupported`, `new-target-threading`, post-claim build
  errors). Those are counted as still legacy.
- **"Admit R".** Treat callee R as individually claimable, with its own
  refusal and external call fixed, and rerun the closure fixpoint.
- **`<module-init>`.** Its edges are approximated by its direct calls to
  top-level function declarations, since `assessModuleInit` is not
  instrumented. Its other own refusals are left as they are.

## (1) Units dropped by the closure — blocking neighbour and its refusal

| files | unit ← blocking neighbour [neighbour's first refusal] |
| ---: | --- |
| 126 | `verifyNotWritable` ← callee `isWritable` [`vardecl-module-binding-alias` «`__isArray(obj) && …`»] |
| 123 | `verifyWritable` ← callee `isWritable` [same] |
| 51 | `makeArrayBuffer` ← callee `makeArray` [`expr-ident-not-in-scope` `Array`] |
| 5 | `assert` ← caller `getInvalidLanguageTags` [`expr-prefix-op-++` `++i`] (standalone caller rule) |
| 2+2+1+1+1 | `thrower`/`assert` ← caller `fn`/`f` [async function / async generator / `param-shape-rejected`] (caller rule) |
| 1 | `f` ← callee `gNonStrict` [`expr-logical-value-family`] |

Most harness blocking is **not** by the closure. `$DONE`, `makeArrayLike`
and the propertyHelper verifiers fail their own per-function selection
first, often on a callee's parameter slot. The closure is the second wall
behind those.

## (2) Transitive: the minimal callee set that lets each unit through Step 2

| files | unit ⇐ {root callee: its refusal} | likely owner |
| ---: | --- | --- |
| 126 | `verifyNotWritable` ⇐ {`isWritable`: `vardecl-module-binding-alias` `__isArray(obj) && …`} | propertyHelper (#7272/#7283) |
| 123 | `verifyWritable` ⇐ {`isWritable`} | propertyHelper (#7272/#7283) |
| 52 | `makeArrayBuffer` (+`$dup0`) ⇐ {`makeArray`: `Array` not in scope (`Array.from`)} | builtin values (#7294) |
| 2+2+1+1+1 | `thrower`/`assert` ⇐ {async callers `fn`/`f`} | async lanes |
| 1 | `f` ⇐ {`gNonStrict`} | — |

The chains found in the earlier briefs fail at per-function selection, not
the closure, so they are listed separately:

- `$DONE` ⇐ `__consolePrintHandle__` ⇐ {`msg` slot (#7277), `print`
  script-var callable (#7287)} (#7297/#7298);
- `makeArrayLike` ⇐ `makeArray` ⇐ `Array.from` (#7294) (#7299).

## (3) Top single admissions by value

**Files left with ≤ 1 legacy unit** if only that callee were admitted (the
remaining unit shown):

| files ≤1 | files =0 | units moved | admit only… [its own refusal] | what is left |
| ---: | ---: | ---: | --- | --- |
| **66** | 0 | 69 | `formatPropertyName` (`temporalHelpers.js`) [`param-shape-rejected`: default param `objectName = ""`] | `<module-init>` `vardecl-module-storage-unrepresentable` (`ASCII_IDENTIFIER = /…/`) ×66 |
| **12** | 0 | 15 | `isConstructor` [`Reflect` not in scope: `Reflect.construct`] | `<module-init>`: `String` ×4 / `Object` ×3 as identifiers, … |
| 5 | 3 | 6 | `f` (test-local) [`param-shape-rejected`] | `<module-init>` call-graph-closure ×2, … |
| 2 | 0 | 2 | `callbackfn` [`new Boolean` / `instanceof Boolean` / `arr` not in scope] (four small groups) | `<module-init>` |
| 2 | 0 | 2–3 | `g` / `f` [`stmt-list-empty`, `param-type-not-resolvable`, helper-internal] | `<module-init>` |

**Units moved** (the callee plus everything it unblocks; no file reaches ≤1
because these are harness helpers in large harnesses):

| units | admit only… [own refusal] | likely owner |
| ---: | --- | --- |
| 377 | `isWritable` [`vardecl-module-binding-alias` `__isArray(obj) && …`] | propertyHelper (#7272/#7283) |
| 139 | `__consolePrintHandle__` [`msg` slot] | #7277 (+ #7287 for `print`) |
| 130 | `verifyCallableProperty` [`expr-logical-value-family` `options && options.verifyProperty…`] | propertyHelper |
| 126 | `verifyAccessorProperty` [`param-type-unresolved(desc)`] | propertyHelper / #7277 slots |
| 125 | `verifyEqualTo` [`value` f64 slot] | #7277 slots |
| 103 | `makeArray` [`Array` not in scope] | #7294 |
| 74 / 71 | `compareArray` / `assert` [`assert` not in scope] | harness binding refs (after #7278) |
| 72 | `Test262Error` [`return-type-unresolved(lattice=dynamic)`] | — |
| 51 / 51 | `isFloatTypedArrayConstructor` [`indexOf` element family] / `floatTypedArrayConstructorPrecision` [`Float16Array`] | — |
| 48 | `ctorArgFactoryMatchesSome` [`++i` prefix op] | — |

## Reading

- **By files:** `formatPropertyName`'s default parameter is the one
  admission that brings many files (66, all Temporal) to a single remaining
  legacy unit. The `<module-init>` regex-literal storage is what is left.
  `isConstructor` (`Reflect.construct`) is next with 12.
- **By units:** `isWritable` (377), with its siblings `verifyCallableProperty`
  / `verifyAccessorProperty` / `verifyEqualTo` (~380 more). It moves the
  most units, but no file reaches ≤1, because typed-array and propertyHelper
  files carry 13–25 legacy units.
- The "likely owner" column is my mapping from the lead's brief. It is not
  checked against the claim ref.
