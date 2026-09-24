// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6672) `__regexp_exec_carrier(recv, subject) -> externref` — the native
 * `RegExp.prototype.exec` entry point for a RegExp whose static type was erased
 * to `any`/externref (a helper parameter, an object-literal property, an array
 * element). The `exec` twin of `__regexp_test_carrier` (#3507).
 *
 * Before: `rules.block.heading.exec(src)` on an untyped receiver lowered to the
 * closed-method dispatcher `__call_m_exec_1`, which had a `$NativeRegExp` brand
 * arm for `test` only. `exec` fell to the open-`$Object` arm
 * (`__extern_method_call(recv, "exec", …)`), whose `[[Get]]` finds no `exec`
 * on a `$__StandaloneRegExp` struct and answers `undefined` — so every such
 * exec read as "no match". marked's block lexer keeps its rules in exactly that
 * shape, found no rule for `#`, and threw `Infinite loop on byte: 35`.
 *
 * The dispatcher (closed-method-dispatch.ts) `ref.test`s the brand before it
 * calls this helper; the helper repeats the recovery anyway so it stays a
 * well-formed RegExpBuiltinExec when called on its own (a non-RegExp receiver
 * is the standard catchable brand TypeError). The subject is `ToString`ed with
 * the same runtime conversion the typed `.exec` lane uses, then the shared
 * engine body (`emitRegExpBuiltinExecFromLocal`, the one the reflective
 * `RegExp.prototype.exec` closure and the `@@` protocol bodies use) produces
 * the match array or null, including g/y `lastIndex` semantics read from the
 * recovered struct at run time. No host import: standalone only.
 */
import type { ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { ensureRegexSearch } from "./native-regex.js";
import { ensureNativeStringHelpers } from "./native-strings.js";
import {
  emitRegExpBuiltinExecFromLocal,
  ensureRuntimeToStringIdx,
  ensureStandaloneRegExpStruct,
} from "./regexp-standalone.js";
import { addFuncType } from "./registry/types.js";

export const STANDALONE_REGEXP_CARRIER_EXEC_HELPER = "__regexp_exec_carrier";

const EXTERNREF: ValType = { kind: "externref" };

/** Reserve (or fetch) `__regexp_exec_carrier`. Standalone only; call while indices are append-safe. */
export function ensureStandaloneRegExpCarrierExecHelper(ctx: CodegenContext): number | undefined {
  const existing = ctx.funcMap.get(STANDALONE_REGEXP_CARRIER_EXEC_HELPER);
  if (existing !== undefined) return existing;
  if (!ctx.standalone) return undefined;

  ensureNativeStringHelpers(ctx);
  ensureRegexSearch(ctx);
  ensureStandaloneRegExpStruct(ctx);
  // Resolve the ToString provider BEFORE minting: registering it may add a
  // native, and nothing minted here may observe a shifted index.
  if (ensureRuntimeToStringIdx(ctx, null) === undefined) return undefined;

  const typeIdx = addFuncType(ctx, [EXTERNREF, EXTERNREF], [EXTERNREF], "$regexp_carrier_exec_type");
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(STANDALONE_REGEXP_CARRIER_EXEC_HELPER, funcIdx);

  const fctx: FunctionContext = {
    name: STANDALONE_REGEXP_CARRIER_EXEC_HELPER,
    params: [
      { name: "recv", type: EXTERNREF },
      { name: "subject", type: EXTERNREF },
    ],
    locals: [],
    localMap: new Map([
      ["recv", 0],
      ["subject", 1],
    ]),
    returnType: EXTERNREF,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
  // §22.2.6.2 step 3 — S = ? ToString(string), into an externref local that
  // holds a native `$AnyString` (what the engine body's subject cast expects).
  const toStringIdx = ensureRuntimeToStringIdx(ctx, fctx)!;
  const sLocal = allocLocal(fctx, "__exec_subject", EXTERNREF);
  fctx.body.push(
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: toStringIdx },
    { op: "local.set", index: sLocal },
  );
  emitRegExpBuiltinExecFromLocal(ctx, fctx, 0, sLocal);

  pushDefinedFunc(ctx, funcIdx, {
    name: STANDALONE_REGEXP_CARRIER_EXEC_HELPER,
    typeIdx,
    locals: fctx.locals,
    body: fctx.body,
    exported: false,
  });
  return funcIdx;
}
