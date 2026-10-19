// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6978) The `regexp` host accelerator: the JS host's RegExp engine runs the
 * matches of the native regime's RegExp objects.
 *
 * Only the matching ENGINE is swapped. Every RegExp surface of the regime
 * (`exec`, `test`, `match`, `matchAll`, `replace`, `split`, `search`, the
 * Symbol protocol, `lastIndex`, the `$NativeRegExp` object model) stays native
 * and reaches the engine through one function, `__regex_search(prog, …, caps)`.
 * Under the accelerator that function becomes a thin wrapper:
 *
 *   1. every `$NativeRegExp` the module creates registers its compiled program
 *      array with the host together with its source and flag bits
 *      (`__regexp_host_register`, keyed by array identity in a host WeakMap);
 *   2. `__regex_search` asks the host to run the registered pattern on the
 *      subject from the start index (`__regexp_host_exec`), handing the
 *      subject over once per subject (`__regexp_host_subject`) and reading the
 *      capture boundaries back slot by slot (`__regexp_host_capture`);
 *   3. a program the host does not know (not registered, e.g. the poisoned
 *      out-of-subset placeholder) runs on the native VM — the native provider
 *      is the fallback, so a missed registration costs speed, never semantics.
 *
 * The imports are registered up front by the import collector (no late-import
 * index shift can strand a caller's cached function index), and only when the
 * source can create a RegExp. Without them nothing is wrapped.
 */
import { ts } from "../../ts-api.js";
import type { Instr, ValType } from "../../ir/types.js";
import { hasHostAccelerator } from "../../target-profile.js";
import type { CodegenContext } from "../context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "../func-space.js";
import { ensureNativeStringExternBridge, hostStringBridgeUsable } from "../native-strings.js";
import { addImport } from "../registry/imports.js";
import { addFuncType } from "../registry/types.js";

const REGISTER = "__regexp_host_register";
const EXEC = "__regexp_host_exec";
const SUBJECT = "__regexp_host_subject";
const CAPTURE = "__regexp_host_capture";
const REGISTER_STRUCT = "__regexp_host_register_struct";

// `$NativeRegExp` field indices (regexp-standalone.ts RE_FIELD_*); repeated
// here so this helper does not import the RegExp god-file.
const RE_FIELD_FLAGS = 0;
const RE_FIELD_PROG = 2;
const RE_FIELD_SOURCE = 4;

const used = new WeakSet<CodegenContext>();

/** The `regexp` accelerator under the native regime (needs the string bridge). */
export function hostRegExpAccelerated(ctx: CodegenContext): boolean {
  return hasHostAccelerator(ctx.targetProfile, "regexp") && hostStringBridgeUsable(ctx);
}

/** Collector visit: remember that the source can create a RegExp. */
export function noteHostRegExpSource(ctx: CodegenContext, node: ts.Node): void {
  if (used.has(ctx)) return;
  if (node.kind === ts.SyntaxKind.RegularExpressionLiteral || (ts.isIdentifier(node) && node.text === "RegExp")) {
    if (hostRegExpAccelerated(ctx)) used.add(ctx);
  }
}

/** Collector finalize: register the engine imports and the string bridge's imports up front. */
export function registerHostRegExpImports(ctx: CodegenContext): void {
  if (!used.has(ctx)) return;
  const ext: ValType = { kind: "externref" };
  const i32: ValType = { kind: "i32" };
  const imports: ReadonlyArray<readonly [string, ValType[], ValType[]]> = [
    ["__str_from_mem", [i32, i32], [ext]],
    ["__str_to_mem", [ext, i32], []],
    ["__str_extern_len", [ext], [i32]],
    [REGISTER, [ext, ext, i32], []],
    [EXEC, [ext, ext, i32, i32, i32, i32], [i32]],
    [SUBJECT, [ext, i32, i32, ext], []],
    [CAPTURE, [i32], [i32]],
  ];
  for (const [name, params, results] of imports) {
    if (ctx.funcMap.has(name)) continue;
    addImport(ctx, "env", name, { kind: "func", typeIdx: addFuncType(ctx, params, results) });
  }
}

function engineImportsReady(ctx: CodegenContext): boolean {
  return hostRegExpAccelerated(ctx) && [REGISTER, EXEC, SUBJECT, CAPTURE].every((name) => ctx.funcMap.has(name));
}

function strToExternIdx(ctx: CodegenContext): number | undefined {
  ensureNativeStringExternBridge(ctx);
  return ctx.funcMap.get("__str_to_extern");
}

/**
 * Wrap the native `__regex_search` (index `nativeIdx`, type `typeIdx`) so a
 * registered program runs on the host engine. Returns the index callers must
 * use: the wrapper when the accelerator is active, otherwise `nativeIdx`.
 */
export function wrapRegexSearchForHost(
  ctx: CodegenContext,
  nativeIdx: number,
  typeIdx: number,
  capsArrayTypeIdx: number,
): number {
  if (!engineImportsReady(ctx)) return nativeIdx;
  const toExtern = strToExternIdx(ctx);
  if (toExtern === undefined) return nativeIdx;
  const [PROG, , NSLOTS, SDATA, SOFF, SLEN, START, STICKY, CAPS] = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const R = 9;
  const K = 10;
  const exec: Instr[] = [
    { op: "local.get", index: PROG },
    { op: "extern.convert_any" },
    { op: "local.get", index: SDATA },
    { op: "extern.convert_any" },
    { op: "local.get", index: SOFF },
    { op: "local.get", index: SLEN },
    { op: "local.get", index: START },
    { op: "local.get", index: STICKY },
    { op: "call", funcIdx: ctx.funcMap.get(EXEC)! },
    { op: "local.set", index: R },
  ];
  const body: Instr[] = [
    ...exec,
    // -2: the host does not hold this subject yet — hand it over once, retry.
    { op: "local.get", index: R },
    { op: "i32.const", value: -2 },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: SDATA },
        { op: "extern.convert_any" },
        { op: "local.get", index: SOFF },
        { op: "local.get", index: SLEN },
        { op: "local.get", index: SLEN },
        { op: "local.get", index: SOFF },
        { op: "local.get", index: SDATA },
        { op: "struct.new", typeIdx: ctx.nativeStrTypeIdx },
        { op: "call", funcIdx: toExtern },
        { op: "call", funcIdx: ctx.funcMap.get(SUBJECT)! },
        ...exec.map((instr) => ({ ...instr })),
      ],
    },
    // -1 (or any other negative answer): unregistered program — the native VM
    // is the fallback.
    { op: "local.get", index: R },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...[0, 1, 2, 3, 4, 5, 6, 7, 8].map((index): Instr => ({ op: "local.get", index })),
        { op: "call", funcIdx: nativeIdx },
        { op: "return" },
      ],
    },
    // 1: copy every capture slot (unmatched groups and scratch slots read -1).
    { op: "local.get", index: R },
    { op: "i32.const", value: 1 },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 0 },
        { op: "local.set", index: K },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: K },
                { op: "local.get", index: NSLOTS },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                { op: "local.get", index: CAPS },
                { op: "local.get", index: K },
                { op: "local.get", index: K },
                { op: "call", funcIdx: ctx.funcMap.get(CAPTURE)! },
                { op: "array.set", typeIdx: capsArrayTypeIdx },
                { op: "local.get", index: K },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: K },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ],
    },
    { op: "local.get", index: R },
  ];
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__regex_search_host",
    typeIdx,
    locals: [
      { name: "r", type: { kind: "i32" } },
      { name: "k", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  });
  ctx.nativeRegexHelpers.set("__regex_search_native", nativeIdx);
  ctx.nativeRegexHelpers.set("__regex_search", funcIdx);
  return funcIdx;
}

/**
 * Instructions that register the `$NativeRegExp` on top of the stack with the
 * host engine and leave it on the stack (empty when the accelerator is off).
 */
export function hostRegExpRegisterInstrs(ctx: CodegenContext, structTypeIdx: number): Instr[] {
  if (!engineImportsReady(ctx)) return [];
  const existing = ctx.nativeRegexHelpers.get(REGISTER_STRUCT);
  if (existing !== undefined) return [{ op: "call", funcIdx: existing }];
  const toExtern = strToExternIdx(ctx);
  if (toExtern === undefined) return [];
  const reRef: ValType = { kind: "ref", typeIdx: structTypeIdx };
  const funcIdx = mintDefinedFunc(ctx);
  ctx.nativeRegexHelpers.set(REGISTER_STRUCT, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: REGISTER_STRUCT,
    typeIdx: addFuncType(ctx, [reRef], [reRef]),
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_PROG },
      { op: "extern.convert_any" },
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_SOURCE },
      { op: "call", funcIdx: toExtern },
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_FLAGS },
      { op: "call", funcIdx: ctx.funcMap.get(REGISTER)! },
      { op: "local.get", index: 0 },
    ],
    exported: false,
  });
  return [{ op: "call", funcIdx }];
}
