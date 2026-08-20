// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4560) The boxed / GC-ref element → `$AnyString` arm of the native
 * `Array.prototype.join` fold, extracted from `compileArrayJoinNative`.
 *
 * ## The invalid Wasm this closes
 *
 * The fold's element switch had exactly four arms — boolean, numeric,
 * `externref`, and a terminal `else` that ASSUMED a string ref and emitted
 * `ref.as_non_null`. An array of object literals is none of those: its element
 * type is a `(ref null $__anon_N)` closed struct, so the `else` fired and the
 * fold's `local.set` into the `(ref $AnyString)` result local rejected it —
 * `type error in fallthru[0] (expected (ref null 6), got (ref 80))`. That is a
 * MODULE THAT DOES NOT LOAD, not a wrong answer, so nothing in the program ran:
 *
 * ```js
 * var o = { valueOf: function () { return "+"; } };
 * [o].join();   // CompileError, before this
 * ```
 *
 * (`var o = {}` compiled fine — a property-less literal gets a different
 * element carrier — which is why the shape looked rarer than it is. test262
 * `built-ins/Array/prototype/{toString/S15.4.4.2_A1_T4,
 * toLocaleString/S15.4.4.3_A3_T1}`.)
 *
 * ## Why it reuses the boxed-any path rather than adding a fifth arm
 *
 * `extern.convert_any` is total over every GC ref, so a struct element becomes
 * an ordinary `externref` and then answers to exactly the runtime ToString the
 * `any[]` lane already uses (`__extern_toString` — the same one `String(a[i])`
 * and `` `${a[i]}` `` use). One arm, one ToString, no chance of the two
 * disagreeing about how an object stringifies.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";

/**
 * Is `typeIdx` `$AnyString` or one of its subtypes (`$NativeString`, a rope)?
 *
 * Walks the declared supertype chain rather than comparing against the two
 * known ids, so a string carrier added later keeps the untouched
 * `ref.as_non_null` lowering instead of silently rerouting through ToString.
 * A false negative would still be CORRECT (ToString of a string is that
 * string), just slower — the walk is about byte-identity, not soundness.
 */
export function isAnyStringSubtype(ctx: CodegenContext, typeIdx: number): boolean {
  if (ctx.anyStrTypeIdx < 0 || typeIdx < 0) return false;
  for (let cur = typeIdx, hops = 0; cur >= 0 && hops < 16; hops++) {
    if (cur === ctx.anyStrTypeIdx || cur === ctx.nativeStrTypeIdx) return true;
    const def = ctx.mod.types[cur];
    if (!def || def.kind !== "struct") return false;
    cur = def.superTypeIdx ?? -1;
  }
  return false;
}

/**
 * Element (on the stack) → `(ref $AnyString)` for the boxed-any and non-string
 * GC-ref carriers.
 *
 * `emptyElem` is the hole ∨ null ∨ undefined test from
 * `joinEmptyElementTest` (array-holes.ts) — §23.1.3.18 step 4.b renders all
 * three as the empty string. `convertFromGcRef` prepends the
 * `extern.convert_any` a GC-ref element needs to reach the externref local.
 */
export function buildJoinBoxedElementToString(
  ctx: CodegenContext,
  anyStrTypeIdx: number,
  emptyElem: { elemLocal: number; test: Instr[] },
  externToStrIdx: number,
  convertFromGcRef: boolean,
): Instr[] {
  const anyStrRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const toStrPath: Instr[] = [
    { op: "call", funcIdx: externToStrIdx },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: anyStrTypeIdx },
  ];
  return [
    ...(convertFromGcRef ? ([{ op: "extern.convert_any" }] satisfies Instr[]) : []),
    { op: "local.set", index: emptyElem.elemLocal },
    ...emptyElem.test,
    {
      op: "if",
      blockType: { kind: "val", type: anyStrRef },
      then: [...nativeStringLiteralInstrs(ctx, ""), { op: "ref.cast", typeIdx: anyStrTypeIdx }],
      else: [{ op: "local.get", index: emptyElem.elemLocal }, ...toStrPath],
    },
  ];
}
