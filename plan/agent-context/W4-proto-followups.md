# W4 — proto-chain follow-ups (named keys on builtin prototypes): PR body + session notes

**Agent**: `ttraenkler/W4-proto-followups` · **Issue**: #4176 (claimed on
`origin/issue-assignments`, branch recorded).
**Branch**: `issue-4176-standalone-proto-named-keys` (pushed to `origin` =
upstream `loopdive/js2`). Stacked on W2's `issue-4163-standalone-proto-chain-live`
(now merged as #4145) + `origin/main` merged in.
**PR**: to be opened by main agent — body below.

---

## PR title

fix(#4176): per-brand proto-property store — named keys on builtin prototypes live through the chain (+76 on the 219-file ES5 lever)

## PR body

Closes #4176. The W2/#4172 residue slice: after #4145 (+95) the remaining 124
failures on the 219-file prototype-chain lever
(`.tmp/levers/W2-prototype-chain.txt`) decompose into ONE dominant mechanism
(~62 files, refuting W2's 15/14/12/8/~75 estimate): **a named key written onto
a builtin's `.prototype` is invisible** (`Function.prototype.value = "x"` /
`Object.prototype.zzz = 1` / `Array.prototype.enumerable = true` — the §8.10.5
inherited-descriptor-field idiom), plus ~15 nested-descriptor
`Object.create({}, {prop: descObj})` files clause A missed.

**Measured, CI-aligned shimmed instrument** (runtime-eval provider shim per
`plan/agent-context/L2-array-exotic-define.md` §2 — #4162 still unfixed):

| 219-file lever list (`--target standalone`) | pass |
| --- | ---: |
| base = origin/main with #4145 (W2) merged | 95 |
| this branch | **171** |

**+76, 0 regressions on the list.** Instrument responsiveness verified by
base-file swap of `declarations.ts` (probes revert to red). Subsystem unit
tests 158/158 (4160 / 2660×4 / 3468 / 3537 / 4055 / 3251×3 / 802×2).
Ratchets: oracle +0, coercion-sites net −1, loc/func growth granted with
per-entry reasons in the issue frontmatter.

Five independent gaps, each probed before fixing:

1. **Top-level `<Builtin>.prototype.<name> = …` compiled to NOTHING** — the
   module-init collection drops statements with no module-global root
   identifier, and `Object`/`Function`/… are builtins (measured: the write was
   absent from `__module_init` WAT). Flag-gated keep-arm in `declarations.ts`
   mirroring the #1719/#2660/#3468 keeps.
2. **#4160's store was integer-only and Object/Array-only.** Generalized:
   per-brand companion table (one `$Object` slot per `BUILTIN_BRAND_TABLE`
   entry, lazily minted), named keys admitted (the integer gate protected
   nothing — refused keys were silent no-ops on the proto singleton), write
   arms accept every builtin brand, and reads consult RECEIVER-aware
   (`__protoidx_brand_off`: vec ⇒ Array, closure ⇒ Function, RegExp/Date/
   Error structs ⇒ their brands, `$NativeProto` ⇒ own brand, boxed-primitive
   wrapper `$Object`s ⇒ String/Number/Boolean via the `[[PrimitiveValue]]`
   slot's box type, default ⇒ Object; chain depth 2 → Object.prototype).
   New consult sites: `__closure_prop_get`/`__vec_prop_get` miss tails,
   `__extern_has` non-`$Object` bag-miss + its finalize vec arm's named-key
   miss, and the `$Object` terminal-walk misses.
3. **The #2372 descriptor-struct reify severed carriers** — a vec/Date/RegExp
   descriptor argument was copied field-by-field into a fresh `$Object`,
   losing carrier-bag own fields AND inherited companion keys. Such carriers
   now pass through as externref; `__obj_define_from_desc` reads them
   directly (its §10.1.6 gate already accepts any object since #3246).
4. **Clause A one hop deeper** — property values inside an object-literal
   argument of a builtin `Object.*`/`Reflect.*` call are dynamic consumers
   (`Object.create({}, {prop: new Con()})`).
5. **Pre-scan + cycle fix** — new `protoNamedDirty` flag, deliberately
   separate from `protoIndexDirty` so `String.prototype.foo = …` (the
   polyfill idiom) reserves the store WITHOUT disabling the HOF hole
   visit-skip / typed element lanes. Brand table extracted to dependency-free
   `builtin-brands.ts` (pre-scan → native-proto import closed an ESM cycle:
   TDZ crash in `collections-brand.ts`).

**Scope guard**: every runtime emission is behind the store reservation
(`ctx.standalone && (protoIndexDirty || protoNamedDirty)`) — flag-clear
modules keep byte-identical bodies (consult builders return `undefined`).
The two un-flag-gated changes are semantically conservative: the
`__extern_has` arm restructure is behavior-identical when the store is
unreserved, and the reify pass-through only affects vec/Date/RegExp
descriptor arguments (their static struct fields are not descriptor field
names; equivalence + subsystem suites green).

🤖 Generated with [Claude Code](https://claude.com/claude-code)

---

## Session notes (for the next agent on this lever)

- **W2's residue framing was wrong** (sixth lever of six this campaign): the
  "accessed !== true" cluster is NOT accessor invocation — it is `enumerable`
  read as an INHERITED field on the descriptor object; the "override-of-
  inherited define" cluster is the `set` variant of the same thing; the
  "Object.prototype named-key" 12 was really ~62 across every builtin proto.
  One mechanism, one fix.
- Instrument: `.tmp/w4-probe.mts` + `.tmp/w2-run.mjs`/`w2-child.mts` (copied
  from W2/L2, TEST262_ROOT=/home/user/js2/test262 required — this worktree's
  submodule is partial). Rebuild `scripts/compiler-bundle.mjs` + refusal
  provider before every measurement. JSONLs: `.tmp/w4-baseline.jsonl` (95),
  `.tmp/w4-after3.jsonl` (171).
- Probes: pA1 (Function.prototype.value), pA2 (Array.prototype.enumerable),
  pA3 (W2's probe2 — Object.prototype.zzz), pB2 (nested Object.create
  descriptor), pC1/pC2/pC3 (vec/Date/erased receivers). All green except the
  `in`-operator static folds noted below.
- **Residue (46 fail + 2 CE) — different mechanisms, scoped out**:
  `x.toString()` → "[object Array]" tags (3), `String.hasOwnProperty(
  'prototype')` (3), `Number.prototype` primitive-value asserts (4), filter
  borrow lengths (3), `__get_builtin` CEs (2), dynamic-code (2), TypeError
  arms on defineProperties 7-6-a-16x/17x (4, ArraySetLength-adjacent — maybe
  W5 territory), illegal casts (2), singletons.
- **Known gaps left deliberately**: `in` on statically-typed vec/Date
  receivers (static fold answers false; also the erased-receiver `in` path —
  reads are what the tests assert); Math/JSON namespace own-props;
  Error-subclass 3-level chain; for-in over inherited companion keys.
- **Trap that cost 2h**: `compileToWat(source)` IGNORES options — it dumps a
  HOST-mode module. Use `compile(src, {target:"standalone", emitWat:true})`
  and read `.wat`, or every standalone diagnostic is fiction.
- **Trap**: importing anything heavy from `array-holes.ts` (the pre-scan)
  creates an ESM cycle that crashes module init under tsx with a misleading
  TDZ error in `collections-brand.ts`. Dependency-free constants go in
  `builtin-brands.ts`.
