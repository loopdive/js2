// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 A11) The WRITE twin of `class-proto-lookup.ts`'s read arm: a runtime-
 * keyed class SETTER is reached by an assignment.
 *
 * `class C { static set [yield](v) {} }` (inside a generator), `static set
 * [x in o](v)`, `set [k](v)` — a member whose key is known only at
 * ClassDefinitionEvaluation lives on the class's static sidecar `$Object` or
 * its prototype `$Object` (#5195), never on the `$C` struct. `__extern_get`,
 * `__extern_has` and `__extern_method_call` already delegate there through
 * `__class_proto_lookup`; `__extern_set` did not, so `C.second = v` wrote an
 * own expando on the class struct and the setter never ran
 * (`class/accessor-name-static-computed-yield-expr.js`).
 *
 * §10.1.9.2 OrdinarySetWithOwnDescriptor, restricted to the one answer this
 * arm owns: when the receiver has no own property and the first object up the
 * delegate's chain that has one holds an ACCESSOR with a setter, call it with
 * the ORIGINAL receiver. Every other outcome — an own property, a data
 * property up the chain, a getter-only accessor, nothing at all — falls
 * through to the unmodified `__extern_set` body, so it keeps its previous
 * answer. The chain walk stops before the object whose prototype is null
 * (`Object.prototype`): its `__proto__` accessor must not be driven with a
 * class struct receiver.
 *
 * Emitted only in a module that declares a runtime-keyed class SETTER (and so
 * has the read arm too); every other module keeps its bytes.
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";

const SETTER_LOOKUP = "__class_proto_setter";

/** `(target, key) -> setter | null`: the accessor setter a class-chain write reaches. */
function mintSetterLookup(ctx: CodegenContext): number | undefined {
  const gopd = ctx.funcMap.get("__getOwnPropertyDescriptor");
  const getProto = ctx.funcMap.get("__getPrototypeOf");
  const has = ctx.funcMap.get("__extern_has");
  const get = ctx.funcMap.get("__extern_get");
  const isUndef = ctx.funcMap.get("__extern_is_undefined");
  if ([gopd, getProto, has, get, isUndef].some((idx) => idx === undefined)) return undefined;
  for (const key of ["get", "set"]) addStringConstantGlobal(ctx, key);
  // params 0=target 1=key; locals 2=o 3=parent 4=desc 5=setter
  const absent = (l: number): Instr[] => [
    { op: "local.get", index: l },
    { op: "ref.is_null" },
    { op: "local.get", index: l },
    { op: "call", funcIdx: isUndef! },
    { op: "i32.or" },
  ];
  const hasField = (name: string): Instr[] => [
    { op: "local.get", index: 4 },
    ...stringConstantExternrefInstrs(ctx, name),
    { op: "call", funcIdx: has! },
  ];
  const miss = (): Instr[] => [{ op: "ref.null.extern" }, { op: "return" }];
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "local.set", index: 2 },
    {
      op: "loop",
      blockType: { kind: "empty" },
      body: [
        { op: "local.get", index: 2 },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: gopd! },
        { op: "local.set", index: 4 },
        ...absent(4),
        {
          op: "if",
          blockType: { kind: "empty" },
          // Not here: step up — but never onto the chain's terminal (the
          // object whose own [[Prototype]] is null, i.e. Object.prototype).
          then: [
            { op: "local.get", index: 2 },
            { op: "call", funcIdx: getProto! },
            { op: "local.set", index: 3 },
            ...absent(3),
            { op: "if", blockType: { kind: "empty" }, then: miss() },
            { op: "local.get", index: 3 },
            { op: "call", funcIdx: getProto! },
            { op: "local.set", index: 5 },
            ...absent(5),
            { op: "if", blockType: { kind: "empty" }, then: miss() },
            { op: "local.get", index: 3 },
            { op: "local.set", index: 2 },
            { op: "br", depth: 1 },
          ],
        },
        // Found. Only an accessor with a setter is this arm's answer.
        ...hasField("set"),
        ...hasField("get"),
        { op: "i32.or" },
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "empty" }, then: miss() },
        { op: "local.get", index: 4 },
        ...stringConstantExternrefInstrs(ctx, "set"),
        { op: "call", funcIdx: get! },
        { op: "local.set", index: 5 },
        ...absent(5),
        { op: "if", blockType: { kind: "empty" }, then: miss() },
        { op: "local.get", index: 5 },
        { op: "return" },
      ],
    },
    { op: "ref.null.extern" },
  ];
  const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
  const funcIdx = mintDefinedFunc(ctx);
  const ext = { kind: "externref" } as const;
  pushDefinedFunc(ctx, funcIdx, {
    name: SETTER_LOOKUP,
    typeIdx,
    locals: [
      { name: "o", type: ext },
      { name: "parent", type: ext },
      { name: "desc", type: ext },
      { name: "setter", type: ext },
    ],
    body,
    exported: false,
  });
  ctx.funcMap.set(SETTER_LOOKUP, funcIdx);
  return funcIdx;
}

/**
 * Prepend the setter-delegating arm to `__extern_set(receiver, key, value)`.
 * `lookupIdx` is `__class_proto_lookup`, `hasOwnIdx` `__hasOwnProperty`.
 */
export function prependClassProtoWriteArm(ctx: CodegenContext, lookupIdx: number, hasOwnIdx: number): void {
  // Only a module that DECLARES a runtime-keyed setter can need the arm. The
  // lookup itself also exists for the #5383 S2h read demand, which records no
  // setter; those modules keep their `__extern_set` bytes.
  if (![...ctx.classDynamicMembers.values()].some((members) => members.some((m) => m.kind === "set"))) return;
  const externSetFn = ctx.mod.functions.find((candidate) => candidate.name === "__extern_set");
  const callSetter = ctx.funcMap.get("__call_accessor_set");
  if (!externSetFn || callSetter === undefined) return;
  const setterLookup = mintSetterLookup(ctx);
  if (setterLookup === undefined) return;
  const target = 3 + externSetFn.locals.length;
  externSetFn.locals.push({ name: "__class_proto_target", type: { kind: "externref" } });
  const setter = 3 + externSetFn.locals.length;
  externSetFn.locals.push({ name: "__class_proto_setter", type: { kind: "externref" } });
  externSetFn.body.unshift(
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: lookupIdx },
    { op: "local.tee", index: target },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: hasOwnIdx },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: target },
            { op: "local.get", index: 1 },
            { op: "call", funcIdx: setterLookup },
            { op: "local.tee", index: setter },
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 0 },
                { op: "local.get", index: setter },
                { op: "local.get", index: 2 },
                { op: "call", funcIdx: callSetter },
                { op: "return" },
              ],
            },
          ],
        },
      ],
    },
  );
}
