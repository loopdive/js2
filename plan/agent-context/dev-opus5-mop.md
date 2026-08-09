# dev-opus5-mop — context summary (2026-07-24)

**Model:** Opus 5. **Task:** #2984 slice (standalone gOPD-on-builtin descriptor MOP), frontier-tier.
**Delivered:** branch `issue-2984-ctor-carrier-own-props` on the **fork** (`ttraenkler/js2`), SHA `4176d4b`.
PR could not be opened — GitHub `POST /pulls` was 500-ing repo-wide; the tech lead owns the retry.

> **Landed since (status as of 2026-07-26).** The 500 cleared and this work
> merged as PR **#3574** (`feat(#2984): seed builtin-ctor $Object carrier with
> length/name/prototype own props`). The handoff line above is historical — no
> retry is owed. The axis correction and measurements below still stand.

## 1. The axis correction — the load-bearing insight

`plan/issues/2984-standalone-gopd-on-builtin-descriptor-mop.md` describes a **gOPD**
problem. That framing is right for the seven
slices already landed, all of which fix the **SYNTACTIC** axis: a call site whose receiver
expression the compiler can resolve at compile time (`gOPD(Math, "abs")`,
`gOPD(Date.prototype, "getTime")`).

But the dominant remaining test262 cluster does not use that axis at all. test262's
`propertyHelper.js verifyProperty(obj, key, desc)` takes its receiver as an **untyped
harness parameter**, so every descriptor query it makes is a RUNTIME one:
`Function.prototype.call.bind(Object.prototype.hasOwnProperty)(obj, key)`,
`Object.getOwnPropertyDescriptor(obj, key)`, `for (k in obj)`, `obj[key] = v`,
`delete obj[key]`. No syntactic synthesis can fire there.

Also: the dominant failure message is `Test262Error: obj should have an own property <k>`,
which is `propertyHelper.js:63` — an assert on **`hasOwnProperty`**, not on gOPD. The
issue's own title mis-names the predicate.

## 2. The probe that exposes it (reuse this)

Route the receiver through an `any`-typed indirection, exactly as the harness does:

```js
function ho(a, b) {
  return Object.prototype.hasOwnProperty.call(a, b);
}
function gg(a, b) {
  return Object.getOwnPropertyDescriptor(a, b);
}
```

Measured on `origin/main` @ `bb5b414a05b6d0`, standalone lane, real `runTest262File`:

| receiver kind                                                     | `ho(X,k)` | why                                       |
| ----------------------------------------------------------------- | --------- | ----------------------------------------- |
| native METHOD/STATIC closure (`Math.abs`, `Array.prototype.flat`) | **true**  | #2896 `__builtinfn_*` reflective natives  |
| builtin CTOR (`WeakMap`, `Map`, `RangeError`)                     | false     | #3006/#2907 carrier is an EMPTY `$Object` |
| native proto (`Date.prototype`, `String.prototype`)               | false     | `$NativeProto`, not `$Object`             |
| builtin namespace (`Math`, `Reflect`)                             | false     | carrier is an empty `$Object`             |
| plain object literal                                              | false     | lowers to a typed struct                  |

The DIRECT (syntactic) form of each of those answers correctly. That split is the whole story.

## 3. The mechanism I shipped

`$Object` **already honours per-property attributes** on every dynamic path — verified on
main with an `Object.defineProperty(Math,"zz",{value:1,writable:false,enumerable:false,
configurable:true})` witness (runtime `hasOwnProperty` true, gOPD triple correct, `for-in`
skips it, `verifyProperty` passes end-to-end for both configurable polarities). So the ctor
carriers were simply **empty**; nothing about the MOP was missing.

Fix = seed the carrier at materialization time via the existing native
`__defineProperty_value`:
`src/codegen/builtin-ctor-own-props.ts` → `pushBuiltinCtorOwnPropSeed()`, called from
`emitBuiltinConstructorIdentity` (#3006) and `emitBuiltinNamespaceObject` (#2907) in
`builtin-static-globals.ts`. Installs `length` §20.2.4.1 `{w:F,e:F,c:T}`, `name` §20.2.4.2
`{w:F,e:F,c:T}`, `prototype` `{w:F,e:F,c:F}` (value = the `$NativeProto` from
`emitLazyNativeProtoGet`, so `desc.value === X.prototype`). Pattern copied from
`emitGeneratorPrototypeSingleton` (#3236 S1). `ctx.standalone`-gated; `prove-emit-identity`
IDENTICAL across all 60 (file,target).

`emitBuiltinConstructorIdentity` had to be restructured to the initBody + local +
`ctx.liveBodies` swap pattern (#2182) because `__box_number` is a late import.

## 4. The A/B wrong-expectation control — REUSE THIS METHOD

Do not trust a test262 fail→pass flip as evidence a descriptor is correct. Build a control
set of **deliberately wrong** expectations and require them to FAIL; then re-run the whole
set with the change force-disabled behind a temporary env switch, so you can tell
"my change did this" from "this was already broken".

Doing that here found that **`verifyProperty` is VACUOUS past its a1 gate on the standalone
lane, on main, today**: wrong `value` / `writable` / `enumerable` / `configurable` all still
report `pass`. The decisive control was `verifyProperty(Math.abs,"name",{…writable:TRUE})` —
an UNTOUCHED #2896 path — which passes with the seed disabled too, proving the vacuity is
pre-existing and independent of the change. Mechanism: `verifyProperty` accumulates into
`failures` via `__push`/`__join` = `Function.prototype.call.bind(Array.prototype.push|join)`
— the **uncurryThis** family — which misbehaves standalone, so `failures.length` stays 0 and
the final `assert(false, …)` never fires. Only the a1 assert is live.

Therefore the slice is cited as **"+49 rows, a1-gate-earned"**, never as
"+49 conforming descriptors". The descriptors themselves ARE right — proven separately by
`tests/issue-2984-ctor-carrier-own-props.test.ts`, which reads each attribute/value with
independent `===` (numeric `length`, object-identity `prototype`), not through the harness.

## 5. Three verdict-oracle holes that inflate the standalone floor (NOT fixed; escalated)

1. A test whose ONLY statement is `throw new Test262Error("HELLO")` reports **pass** on the
   standalone lane — a bare top-level `throw` statement is silently dropped.
   (`assert.sameValue(1,2)` correctly fails, so it is specific to the top-level throw.)
2. `assert.sameValue("" + true, "SHOWME")` **passes** — dynamic-string `sameValue`
   false-positives. Any test discriminating only on a string compare can pass vacuously.
3. The `verifyProperty` `__push`/`__join` vacuity in §4 — the uncurryThis half of the PH
   wall. 4,735 test262 files call `verifyProperty`; only 1,190 pass standalone.

Same class as `reference_standalone_floor_inflated_by_exception_swallow` / the F1
honest-floor work (#3523).

## 6. Measurement caveat that bit me — READ THIS BEFORE DIFFING A SWEEP

I first diffed a 2,137-file local sweep against the committed standalone baseline JSONL and
read "0 regressions, +118 improvements". **That comparison is contaminated.** The baseline is
produced by the sharded CI worker (`scripts/test262-worker.mjs`); a local
`runTest262File` run differs on things unrelated to any code change — e.g. `L:N ` error-prefix
formatting, and a large `standalone target emitted host imports: env::X` (#2961) population
that does not reproduce locally. 611 rows showed a changed error signature purely from that.

**The only sound control is local-vs-local**: run the sweep twice in the same process shape,
once with the change force-disabled behind a temporary env switch, and diff those two.

## 7. Next slice on this axis (measured, priority order)

Remaining `hasOwnProperty`-miss rows under `test/built-ins/`, by receiver kind:

- **native-proto 199** — `Array.prototype` 41, `TypedArrayPrototype` 25, `String.prototype`
  16, `Iterator.prototype` 11, `RegExp.prototype` 9, `ArrayBuffer.prototype` 9 …
- **namespace 62** — `Math` 45, `Reflect` 13, `JSON` 4
- **global (`this`) 48**
- **TypedArray ctors 27** — these have NO `$Object` carrier at all
  (`typeof id(Uint16Array) !== "object"`), so they need a carrier before they can be seeded.

**Prerequisite for the namespace/proto families:** their descriptors are mostly
`{writable:true, …}`, and `verifyProperty`'s `isWritable` requires the write to actually
succeed and be observable. A dynamic `o[k] = v` currently **bypasses the `$PropEntry`
non-writable flag** (`__extern_set` does not consult flags) — pinned as a KNOWN GAP test in
my suite. Fixing the store path is therefore a prerequisite for flipping those families for
the RIGHT reason, unlike the `{writable:false}` ctor triple this slice did.

## 8. Housekeeping / gotchas for whoever picks this up

- Probe files go in `.tmp/`, never in the `test262` submodule (I briefly wrote 20 there —
  cleaned).
- The scoped standalone runner + one-fact probe generator I used are in `.tmp/run-sa.mts`,
  `.tmp/gen-facts.mjs`, `.tmp/gen-controls.mjs` in the worktree
  `/workspace/.claude/worktrees/agent-a44fa4cd522db23a6` (ephemeral — re-create if gone).
  Pattern: one fact per file, `assert(!!(<expr>), "F00N")`, verdict `pass` == fact true.
  Runner-message rendering is unreliable ("non-stringifiable payload"), so the per-file
  pass/fail verdict is the exfiltration channel, not the error text.
- `#2984` frontmatter is `status: done` per the self-merge lifecycle rule, but the issue is
  `horizon: xl` and the residual above is real — a successor issue is needed. A RESIDUAL
  banner is at the top of the issue file.
