import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/** Wire the identity-keyed vec prototype store into existing native helpers. */
export function wireVecPrototypeHelpers(ctx: CodegenContext): void {
  const idx = (name: string) => ctx.funcMap.get(name);
  const isVec = idx("__is_vec_prop_carrier");
  const has = idx("__vec_proto_has");
  const get = idx("__vec_proto_get");
  const set = idx("__vec_proto_set");
  const getProto = idx("__getPrototypeOf");
  const isExtensible = idx("__object_isExtensible");
  const status = idx("__object_setPrototypeOf_status");
  if ([isVec, has, get, set, getProto, isExtensible, status].some((v) => v === undefined)) return;
  const find = (name: string) => ctx.mod.functions.find((fn) => fn.name === name);
  const eq = (a: number, b: number): Instr[] => [
    { op: "local.get", index: a },
    { op: "any.convert_extern" },
    { op: "ref.cast_null", typeIdx: -19 },
    { op: "local.get", index: b },
    { op: "any.convert_extern" },
    { op: "ref.cast_null", typeIdx: -19 },
    { op: "ref.eq" },
  ];
  const answer = (value: number): Instr[] => [{ op: "i32.const", value }, { op: "return" }];
  const guard = (then: Instr[]): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: isVec! },
    { op: "if", blockType: { kind: "empty" }, then },
  ];
  const reader = find("__getPrototypeOf");
  reader?.body.unshift(
    ...guard([
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: has! },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 0 }, { op: "call", funcIdx: get! }, { op: "return" }],
      },
    ]),
  );
  const checker = find("__object_setPrototypeOf_status");
  if (checker) {
    const p = 2 + checker.locals.length;
    checker.locals.push({ name: "vecPrototype", type: { kind: "externref" } });
    checker.body.unshift(
      ...guard([
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: getProto! },
        { op: "local.set", index: p },
        ...eq(1, p),
        { op: "if", blockType: { kind: "empty" }, then: answer(1) },
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: isExtensible! },
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "empty" }, then: answer(0) },
        { op: "local.get", index: 1 },
        { op: "local.set", index: p },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: p },
                { op: "ref.is_null" },
                { op: "br_if", depth: 1 },
                ...eq(0, p),
                { op: "if", blockType: { kind: "empty" }, then: answer(0) },
                { op: "local.get", index: p },
                { op: "call", funcIdx: getProto! },
                { op: "local.set", index: p },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        ...answer(1),
      ]),
    );
  }
  find("__object_setPrototypeOf")?.body.unshift(
    ...guard([
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: status! },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: set! },
        ],
      },
      { op: "local.get", index: 0 },
      { op: "return" },
    ]),
  );
}
