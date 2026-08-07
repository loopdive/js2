# W5 — descriptor-family residue (2026-08-06)

**Agent**: `ttraenkler/W5-descriptor-residue` (senior-dev, opus).
**Issue**: #4180. **Branch**: `issue-4180-descriptor-struct-reify` (pushed to
`origin`). **Lever**: `.tmp/levers/W5-descriptor-family.txt`, 558 files.

---

## PR body (copy verbatim)

### Title

`fix(#4180): stop fabricating a descriptor from a struct's internal wasm fields`

### Body

`emitDescriptorStructReify` (`src/codegen/object-ops.ts`, #2372) turns a typed
WasmGC descriptor struct into a fresh `$Object` by copying the struct's **wasm
fields**, and hands that to `__obj_define_from_desc`. It fires for **any**
descriptor argument that compiled to a named struct with ≥ 1 field.

That is correct for the case it was written for — a descriptor object literal
(`var d = {value: 1}`) that the checker closed into a struct whose fields *are*
the descriptor's own properties. It is silently wrong for every other struct,
because it transcribes the **internal representation** and throws the object's
real own properties away.

```js
var arrObj = [];
arrObj.enumerable = true;          // lands in the #3537 vec bag
arrObj.value = 42;
Object.defineProperty(obj, "property", arrObj);
obj.property;                      // => undefined   (spec: 42)
```

The emitted `__module_init` literally does

```wat
call $__new_plain_object                        ;; descObj
__extern_set(descObj, "length", arrObj.length)
__extern_set(descObj, "data",   arrObj.data)
call $__obj_define_from_desc
```

ToPropertyDescriptor finds no `value`/`enumerable`, CompletePropertyDescriptor
fills in `undefined` + all-false. No refusal, no diagnostic. Same for
`new Date()` (`{timestamp}`) and subviews (`{length, data, byteOffset}`).

#### The fix

`isDescriptorTranscribableStruct` (`src/codegen/property-descriptor-shape.ts`)
gates the transcription:

- object-literal structs (`__anon_*`) **always** transcribe — their fields are
  their own properties by construction, including `{foo: 1}`, which must yield
  an empty-but-valid descriptor rather than a TypeError;
- any other struct transcribes only if it carries at least one of the six
  §6.2.5.6 field names (a fnctor instance with `this.value = …` is a real
  carrier — unchanged);
- everything else passes through as an externref, so the runtime applier runs
  ToPropertyDescriptor over the actual object.

A **plausible-descriptor** test rather than a builtin-representation denylist: a
denylist must track every struct the compiler ever mints (`__vec_*`,
`__subview_*`, `__Date`, `__StandaloneRegExp`, error/box structs, …) and fails
**open** when it falls behind — the wrong direction for a helper whose failure
mode is a silent wrong answer.

Pass-through is safe on both gates it must clear: `__obj_define_from_desc`'s
Type check has been `typeof === "object" || "function"` since **#3246** (not a
`ref.test $Object`), and `__typeof_object` answers 1 for any non-null
non-primitive. It is also strictly safer on a **null** struct ref: the
transcription read each field under `ref.as_non_null` and would trap, whereas
the applier treats a null descriptor as a lenient empty-descriptor no-op.

#### Measured

Instrument: L2's CI-aligned scoped runner with the `js2wasm:runtime-eval`
provider shim (**#4162** — `tests/test262-runner.ts` does not supply the
namespace `scripts/test262-worker.mjs` does; without the shim every
`propertyHelper.js` test dies at instantiate). 558-file lever list,
`--target standalone`.

| | pass |
| --- | ---: |
| base | **92 / 558** |
| this branch | **104 / 558** |

**+12, 0 regressions on the list** —
`built-ins/Object/defineProperty/15.2.3.6-3-{34,39,87,92,140,145,166,171,219,224,249,254}.js`,
the Array and Date `'Attributes'` carriers.

Instrument responsiveness verified in **both** directions: with the two source
files swapped back to their `origin/main` copies those twelve score **0 / 12**;
restored, **12 / 12**. (File-copy A/B — never `git stash`.)

#### What this refutes (the more useful half)

The lever was framed as descriptor-**reader** gaps. The reader is fine. The same
array whose descriptor read as empty already reports its expando through
`Object.getOwnPropertyNames`, `Object.keys` **and**
`Object.getOwnPropertyDescriptor`:

```
read=101  gopn=zz  keys=zz  gopd=101/true      own=false  in=false  forin=(empty)
```

The descriptor path never asked them — it had substituted its own answer at
**compile time**. The carrier-bag arm in `__desc_has_own` that the reader
framing implies would have measured **+0**.

Reusable discriminator: make the same value reach the call site as an
**externref** instead of a typed struct (`var c = esc([]); c.value = 3;
Object.defineProperty(o, "p", c)`) — it works. If a value behaves differently
based only on its static representation, the defect is in the static lane.

#### Gates

`check:oracle-ratchet` +0/+0 · `check:func-budget` OK · `check:coercion-sites`
OK · `check:loc-budget` +10 on `object-ops.ts`, **granted** with a per-entry
reason in the issue frontmatter (the gate must be consulted at the reify
decision; all 58 lines of logic went to the subsystem module).
`tests/issue-4180.test.ts` (8 cases, incl. the "literal still transcribes"
guards). Equivalence gate: green.

---

## Findings for the next wave (measured, do not re-derive)

### Baseline sizing correction

The lever list was cut as 558 *failures*, but **92 already pass** on current
main — six PRs landed between the cut and the measurement. The real residue is
**466**.

### Carrier matrix, straight-line module-global shape (the real test262 spelling)

| carrier | store+read | `hasOwn` | `in` | `defineProperty` before | after |
| --- | :-: | :-: | :-: | :-: | :-: |
| plain object / function / RegExp / wrappers / Arguments | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Array** | ✓ | ✗ | ✗ | **✗** | **✓** |
| **Date** | ✓ | ✗ | ✗ | **✗** | **✓** |
| Error | ✗ | ✗ | ✗ | ✗ | ✗ |
| Math / JSON | ✗ compile refusal | — | — | ✗ | ✗ |

### Mechanism census of the 466 remaining (from `description:` frontmatter, not error strings)

| fails | mechanism |
| ---: | --- |
| 100 | misc |
| 69 | array index-named define (#3251 S2/S3 territory) |
| 46 | `ES5 Attributes` census |
| 44 | **`-1` "of prototype object" variants** (cuts across the carrier rows) |
| 33 | Arguments (mostly Arguments *receiver*, not carrier) |
| 32 | inherited-property (30 already pass) |
| 27 | Error carrier |
| 24 | TypeError arms |
| 23 | JSON carrier · 23 Math carrier |
| 13 | `[SITE-PROPS-BAG-NOT-AUTHORITATIVE]` refusals |

### Three named next slices, with why they are NOT in this PR

1. **`hasOwnProperty` / `in` / `for-in` on a statically typed array** bypass the
   runtime helpers that already consult the bag (`__hasOwnProperty` has the
   #4010 S3 vec-prologue bag fallback and it is correct — the static lane never
   calls it). Real, separate, adjacent to #4159. This is a *routing* question in
   the typed lane with a different blast radius from a descriptor gate.

2. **The 44 `-1` "of prototype object" files** (Object 12; 4 each for Function /
   RegExp / Array / Number / Boolean / Date / Error / String).
   `RegExp.prototype.value = "RegExp"; new RegExp()` and
   `Object.prototype.zz = 1; ({}).zz` both read `undefined`. Nearest substrate
   is #4160 `proto-index-store.ts`, gated to **canonical non-negative integer
   keys** and to only two companions (`%Object.prototype%`,
   `%Array.prototype%`). **Widening it is not a one-line gate removal**:
   `protoIndexDirty` (array-holes.ts) is a PRE-SCAN flag whose whole job is to
   keep the substrate — and its read-fallback splices into
   `__extern_get`/`__extern_has`/the vec and closed-struct arms — out of clean
   modules. Widening the pre-scan turns it on for far more modules, the exact
   unscoped-widening shape that cost #2660 S2 a measured **−40** on the
   standalone floor. Worth doing; worth measuring on its own.

3. **The 13 plural-path refusals.** The obvious move — a vec arm in
   `closurePropertiesBagArm` — is the arm **#4047 measured at +6 and reverted**
   (a `Properties` MAP needs a COMPLETE own-key source; a bag is not one).
   13 files does not justify re-litigating it.

### Instrument

`.tmp/w5-child.mts` + `.tmp/w5-run.mjs` in the worktree
`/home/user/js2/.claude/worktrees/agent-abfad154ece71c9ed/` (L2's harness,
renamed; `W5_ERR_SLICE` env widens the captured error text, `.tmp/w5-probe.mjs`
runs a single absolute-path probe file). ~25 min for 558 files at 4 workers on
this 4-core box. Per-file JSONL: `.tmp/w5-before.jsonl`, `.tmp/w5-after.jsonl`.
Census scripts: `.tmp/w5-desc.mjs`, `.tmp/w5-carrier.mjs`, `.tmp/w5-xtab.mjs`,
`.tmp/w5-body.mjs`, `.tmp/w5-proto.mjs`.

**Worktree note**: `test262/` and `node_modules/` in this worktree are symlinks
into `/home/user/js2/`; without them `runTest262File` dies with ENOENT on
`test262/harness/assert.js` and reports **`harness_error` for all 558** — which
reads as a plausible instrument result if you are not looking. `.tmp/link-test262.mjs`
recreates them.
