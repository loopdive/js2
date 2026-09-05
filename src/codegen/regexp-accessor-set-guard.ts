// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2875 wave-4 lane F) A RUNTIME-keyed write to a NATIVE own property that no
 * assignment may create or overwrite — `re[k] = v` where `k` evaluates to
 * `"global"`, or `strObj[k] = v` where `k` evaluates to `"length"` — must be a
 * silent no-op, not an own data property; and a `delete` of the
 * non-configurable ones must answer `false`.
 *
 * ## The measured defect
 *
 * §22.2.6 makes `source`, `flags`, `global`, `ignoreCase`, `multiline`,
 * `dotAll`, `unicode`, `unicodeSets`, `sticky` and `hasIndices` GETTER-ONLY
 * accessors on `RegExp.prototype`. §10.1.9 OrdinarySetWithOwnDescriptor step 3
 * therefore makes an assignment through an instance a sloppy-mode no-op: no
 * setter runs, and no own property is created to shadow the getter.
 *
 * The STATIC spelling was already right. The runtime-keyed one was not —
 * measured on this branch's base (`--target standalone`, probe
 * `test262/test/probe/f-re-proto3.js`, `var s = /^|^/; var k = "global";`):
 *
 * | expression                    | base            | spec    |
 * | ----------------------------- | --------------- | ------- |
 * | `s.global`                     | `false`         | `false` |
 * | `s.global = "x"; s.global`     | `false`         | `false` |
 * | `s[k]`                         | `undefined`     | `false` |
 * | `s[k] = "x"; s[k]`             | **`"x"`**       | `false` |
 * | `hasOwnProperty(s, k)` after   | **`true`**      | `false` |
 *
 * A `$NativeRegExp` is not a `$Object`, so `__extern_set` routes it to the
 * instance expando side table (`buildInstanceOrVecOrClosurePropSetMissArm`) and
 * the write lands in the bag. #4504's inherited-accessor walk cannot see it: that
 * walk follows `$Object.$proto` links through `$PropEntry` tables, and
 * `RegExp.prototype` in standalone is a `$NativeProto` glue singleton whose
 * getters live in a member CSV, not in a `$PropEntry`.
 *
 * ## Why this matters beyond the spelling
 *
 * test262's `propertyHelper.js` reaches every descriptor through an untyped
 * parameter, so `isWritable(obj, name, verifyProp)` does `obj[name] = newValue`
 * with `name` a VARIABLE. That is exactly the runtime-keyed spelling, which is
 * why `verifyNotWritable(/^|^/, "global", "global", …)` reported the property as
 * writable on a build where the static read was already correct.
 *
 * ## Scope
 *
 * - **Sloppy `__extern_set` only.** Strict `[[Set]]` on a getter-only accessor
 *   must throw a TypeError (§10.1.9.2); `__extern_set_strict` is a separate
 *   function and is deliberately NOT touched here — no row in this lane's set
 *   exercises it, and a wrong throw is catchable and therefore observable.
 * - **Read side untouched.** `s[k]` still answers `undefined` rather than
 *   `false`. That is a second, independent gap (the `$NativeProto` getter is not
 *   consulted by `__extern_get` either); it is not fixed here because the
 *   getter-invocation path is the #2885 reflective core, and because the no-op is
 *   correct on its own — `undefined` is what an absent bag entry has always
 *   answered.
 * - **Demand-gated**: no `$NativeRegExp` struct in the module ⇒ nothing minted,
 *   `__extern_set` byte-identical.
 *
 * ## The String-exotic half (same shape, second predicate)
 *
 * §10.4.3 gives a String WRAPPER an own `length` and own canonical INDEX
 * properties, all `{w:false, e:false, c:false}`. #4232 already taught
 * `hasOwnProperty` about them (`__strexo_hasown`) and gOPD already reports the
 * right triple — but they are DERIVED from the [[StringData]] slot, not table
 * entries, so `__obj_find` missed them and a runtime-keyed write created an own
 * bag entry that shadowed both. Measured on this branch (probe
 * `test262/test/probe/f-misc2.js`, `var si = new String("globglob")`):
 *
 * | query                                   | base        | after   | spec    |
 * | --------------------------------------- | ----------- | ------- | ------- |
 * | `gOPD(si,"length")`                     | `{w:f,e:f,c:f,v:8}` | same | same |
 * | `si.length = "x"; si.length` (static)   | `8`         | `8`     | `8`     |
 * | `isWritable(si,"length")` (harness)     | **`true`**  | `false` | `false` |
 * | `delete si.length`                      | **`true`**  | `false` | `false` |
 *
 * Reusing #4232's predicate is the point: presence, descriptor and mutability
 * then cannot disagree, because all three read the same native.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";
import { standaloneRegExpStructTypeIdx } from "./regexp-standalone.js";
import { STRING_EXOTIC_HASOWN_FN } from "./string-exotic-own-props.js";
import { addFuncType } from "./registry/types.js";

/** §22.2.6 — the getter-only members of `RegExp.prototype`. */
const REGEXP_GETTER_ONLY_MEMBERS: readonly string[] = [
  "source",
  "flags",
  "global",
  "ignoreCase",
  "multiline",
  "dotAll",
  "unicode",
  "unicodeSets",
  "sticky",
  "hasIndices",
];

const GUARD_FN = "__regexp_getter_only_set";

/**
 * Register `__regexp_getter_only_set(obj externref, key externref) -> i32`:
 * 1 when `obj` is a `$NativeRegExp` and `key` is one of the §22.2.6 getter-only
 * member names, else 0.
 *
 * Returns the funcIdx, or `undefined` when a prerequisite is missing (no RegExp
 * struct in this module, no native-string subsystem) — declining is always safe.
 */
function registerRegExpGetterOnlySet(ctx: CodegenContext): number | undefined {
  if (!ctx.standalone) return undefined;
  const existing = ctx.funcMap.get(GUARD_FN);
  if (existing !== undefined) return existing;
  const reTypeIdx = standaloneRegExpStructTypeIdx(ctx);
  if (reTypeIdx === undefined) return undefined;
  const anyStr = ctx.anyStrTypeIdx;
  const natStr = ctx.nativeStrTypeIdx;
  if (anyStr < 0 || natStr < 0) return undefined;
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const equalsIdx = ctx.nativeStrHelpers.get("__str_equals");
  if (flattenIdx === undefined || equalsIdx === undefined) return undefined;

  // params: 0 obj, 1 key · local 2: the flattened key
  const L_KEY = 2;
  const locals: { name: string; type: ValType }[] = [{ name: "fkey", type: { kind: "ref_null", typeIdx: natStr } }];
  const returnZero: Instr[] = [{ op: "i32.const", value: 0 }, { op: "return" }];

  const body: Instr[] = [
    // The receiver must be a `$NativeRegExp`.
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: reTypeIdx },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: returnZero },
    // A non-string key (symbol, boxed number) names none of these members.
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: anyStr },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: returnZero },
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: anyStr },
    { op: "call", funcIdx: flattenIdx },
    { op: "local.set", index: L_KEY },
  ];
  for (const member of REGEXP_GETTER_ONLY_MEMBERS) {
    body.push(
      { op: "local.get", index: L_KEY },
      { op: "ref.as_non_null" },
      ...nativeStringLiteralInstrs(ctx, member),
      { op: "call", funcIdx: equalsIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 1 }, { op: "return" }],
      },
    );
  }
  body.push({ op: "i32.const", value: 0 });

  const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(GUARD_FN, funcIdx);
  pushDefinedFunc(ctx, funcIdx, { name: GUARD_FN, typeIdx, locals, body, exported: false });
  return funcIdx;
}

/** Prologue: `if (<pred>(obj, key)) return <result?>;` at the front of a body. */
function unshiftPredicateGuard(ctx: CodegenContext, fnName: string, predIdx: number, result: number | undefined): void {
  const fn = ctx.mod.functions.find((candidate) => candidate.name === fnName);
  if (!fn) return;
  const then: Instr[] =
    result === undefined ? [{ op: "return" }] : [{ op: "i32.const", value: result }, { op: "return" }];
  fn.body.unshift(
    { op: "local.get", index: 0 },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: predIdx },
    { op: "if", blockType: { kind: "empty" }, then },
  );
}

/**
 * Finalize splice: make the sloppy `__extern_set` return early on a native own
 * property that no assignment may create or overwrite, and `__delete_property`
 * return `false` on a non-configurable one.
 *
 * Two predicates, one shape:
 *
 * - `__regexp_getter_only_set` — §22.2.6 getter-only members of a
 *   `$NativeRegExp` (this module).
 * - `__strexo_hasown` — §10.4.3 String-exotic own properties (`length` and the
 *   canonical indices) of a String WRAPPER (string-exotic-own-props.ts, #4232).
 *   Every one of them is `{w:false, c:false}`, so a write is a sloppy no-op and
 *   a delete answers `false`. Reusing that predicate is the point: presence and
 *   mutability then cannot disagree — `hasOwnProperty` already answers `true`
 *   from the same native, and gOPD already reports `{w:false,e:false,c:false}`,
 *   while the runtime-keyed write created an own bag entry that shadowed both.
 *
 * Runs at finalize, and LAST among the `__extern_set` prologue passes, so these
 * guards are the body's first instructions — the write must not reach the
 * declared-field ladder or the expando bag. Minting here is append-only and the
 * `call`s are baked in the same pass, so no previously-resolved funcIdx moves.
 */
export function unshiftRegExpAccessorSetGuard(ctx: CodegenContext): void {
  const strExoIdx = ctx.funcMap.get(STRING_EXOTIC_HASOWN_FN);
  if (strExoIdx !== undefined) {
    unshiftPredicateGuard(ctx, "__extern_set", strExoIdx, undefined);
    // §10.1.10 OrdinaryDelete step 4 — a non-configurable own property answers
    // `false`; the operator's own lowering turns that into the `delete` result.
    unshiftPredicateGuard(ctx, "__delete_property", strExoIdx, 0);
  }
  const funcIdx = registerRegExpGetterOnlySet(ctx);
  if (funcIdx === undefined) return;
  unshiftPredicateGuard(ctx, "__extern_set", funcIdx, undefined);
}
