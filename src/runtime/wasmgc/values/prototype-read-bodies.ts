// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../../../wasm/model/instructions.js";
export interface PrototypeHasResources {
  readonly objectTypeIdx: number;
  readonly companionIdx: number;
  readonly objFindIdx: number;
  readonly brandBase: number;
  readonly brandCount: number;
  readonly objectOffset: number;
}
export interface PrototypeReadResources extends PrototypeHasResources {
  readonly propEntryTypeIdx: number;
  readonly callAccessorGetIdx: number;
  readonly entryFlagsField: number;
  readonly entryGetterField: number;
  readonly entryValueField: number;
  readonly accessorFlag: number;
  readonly anyStr: number;
  readonly flattenIdx: number | undefined;
  readonly equalsIdx: number | undefined;
}
export type PrototypeReadRequest =
  | { readonly kind: "constructor-literal" }
  | { readonly kind: "parent-links" }
  | { readonly kind: "undefined" };
export type PrototypeReadResponse =
  | {
      readonly kind: "constructor-literal";
      readonly materialization:
        | { readonly kind: "global"; readonly globalIdx: number }
        | { readonly kind: "callable"; readonly funcIdx: number };
    }
  | { readonly kind: "parent-links"; readonly links: readonly (readonly [number, number])[] }
  | { readonly kind: "undefined"; readonly globalIdx: number | undefined };
export type PrototypeReadRecipe = Generator<PrototypeReadRequest, Instr[], PrototypeReadResponse>;
function* constructorLiteral(): PrototypeReadRecipe {
  const response = yield { kind: "constructor-literal" };
  if (response.kind !== "constructor-literal") throw new Error("prototype read expected constructor literal");
  const value = response.materialization;
  return value.kind === "global"
    ? [{ op: "global.get", index: value.globalIdx }]
    : [{ op: "call", funcIdx: value.funcIdx }];
}
function* undefinedValue(): PrototypeReadRecipe {
  const response = yield { kind: "undefined" };
  if (response.kind !== "undefined") throw new Error("prototype read expected undefined binding");
  return response.globalIdx === undefined
    ? [{ op: "ref.null.extern" }]
    : [{ op: "global.get", index: response.globalIdx }, { op: "extern.convert_any" }];
}
function* parentLinks(): Generator<
  PrototypeReadRequest,
  readonly (readonly [number, number])[],
  PrototypeReadResponse
> {
  const response = yield { kind: "parent-links" };
  if (response.kind !== "parent-links") throw new Error("prototype read expected parent links");
  return response.links;
}
function* constructorGuard(
  deps: PrototypeReadResources,
  keyParam: number,
): Generator<PrototypeReadRequest, Instr[] | undefined, PrototypeReadResponse> {
  const anyStr = deps.anyStr;
  const flattenIdx = deps.flattenIdx;
  const equalsIdx = deps.equalsIdx;
  if (anyStr < 0 || flattenIdx === undefined || equalsIdx === undefined) return undefined;
  return [
    { op: "local.get", index: keyParam },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: anyStr },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: keyParam },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: anyStr },
        { op: "call", funcIdx: flattenIdx },
        ...(yield* constructorLiteral()),
        { op: "call", funcIdx: equalsIdx },
        { op: "i32.eqz" },
      ],
      // A non-string key (symbol / already-normalised index) can never be
      // `constructor`, so the fallthrough stays available.
      else: [{ op: "i32.const", value: 1 }],
    },
  ];
}

function buildProbe(
  deps: PrototypeHasResources,
  offset: { local: number } | { constant: number },
  mode: "has" | "get",
): Instr[] {
  const cLocal = mode === "has" ? 2 : 3;
  return [
    "local" in offset ? { op: "local.get", index: offset.local } : { op: "i32.const", value: offset.constant },
    { op: "i32.const", value: 0 },
    { op: "call", funcIdx: deps.companionIdx },
    { op: "local.set", index: cLocal },
    { op: "local.get", index: cLocal },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: cLocal },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: deps.objectTypeIdx },
        { op: "local.get", index: mode === "has" ? 0 : 1 },
        { op: "call", funcIdx: deps.objFindIdx },
        ...(mode === "has"
          ? ([
              { op: "ref.is_null" },
              { op: "i32.eqz" },
              { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
            ] satisfies Instr[])
          : ([{ op: "local.set", index: 4 }] satisfies Instr[])),
      ],
    },
  ];
}
function buildParentProbes(
  deps: PrototypeHasResources,
  links: readonly (readonly [number, number])[],
  mode: "has" | "get",
): Instr[] {
  const arms: Instr[] = [];
  for (const [brand, parentBrand] of [...links].sort((a, b) => a[0] - b[0])) {
    const off = brand - deps.brandBase;
    const parentOff = parentBrand - deps.brandBase;
    if (off < 0 || off >= deps.brandCount || parentOff < 0 || parentOff >= deps.brandCount) continue;
    if (parentOff === deps.objectOffset) continue;
    arms.push(
      ...(mode === "get" ? ([{ op: "local.get", index: 4 }, { op: "ref.is_null" }] satisfies Instr[]) : []),
      { op: "local.get", index: mode === "get" ? 2 : 1 },
      { op: "i32.const", value: off },
      { op: "i32.eq" },
      ...(mode === "get" ? ([{ op: "i32.and" }] satisfies Instr[]) : []),
      { op: "if", blockType: { kind: "empty" }, then: buildProbe(deps, { constant: parentOff }, mode) },
    );
  }
  return arms;
}
export function* buildPrototypeHasBody(deps: PrototypeHasResources): PrototypeReadRecipe {
  return [
    ...buildProbe(deps, { local: 1 }, "has"),
    ...buildParentProbes(deps, yield* parentLinks(), "has"),
    { op: "local.get", index: 1 },
    { op: "i32.const", value: deps.objectOffset },
    { op: "i32.ne" },
    { op: "if", blockType: { kind: "empty" }, then: buildProbe(deps, { constant: deps.objectOffset }, "has") },
    { op: "i32.const", value: 0 },
  ];
}
export function* buildPrototypeGetBody(deps: PrototypeReadResources): PrototypeReadRecipe {
  // (#4491 T10) …and never for `constructor`, which every builtin prototype owns.
  const notConstructor = yield* constructorGuard(deps, 1);
  return [
    // firstOff companion first (the receiver's own proto brand)…
    ...buildProbe(deps, { local: 2 }, "get"),
    // (#5194 step 1) …then the declared PARENT level, when nothing was found
    // there and the receiver's brand declares one (§23.2.7 view prototypes).
    ...buildParentProbes(deps, yield* parentLinks(), "get"),
    // …then Object.prototype's when nothing was found and firstOff differs.
    { op: "local.get", index: 4 },
    { op: "ref.is_null" },
    { op: "local.get", index: 2 },
    { op: "i32.const", value: deps.objectOffset },
    { op: "i32.ne" },
    { op: "i32.and" },
    ...(notConstructor === undefined ? [] : [...notConstructor, { op: "i32.and" } satisfies Instr]),
    { op: "if", blockType: { kind: "empty" }, then: buildProbe(deps, { constant: deps.objectOffset }, "get") },
    // No entry anywhere → undefined miss.
    { op: "local.get", index: 4 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...(yield* undefinedValue()), { op: "return" }],
    },
    // Accessor entry → invoke the getter with the ORIGINAL receiver
    // (§6.2.5.5 step 8 — Receiver is the object the Get started on).
    { op: "local.get", index: 4 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: deps.propEntryTypeIdx, fieldIdx: deps.entryFlagsField },
    { op: "i32.const", value: deps.accessorFlag },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 4 },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: deps.propEntryTypeIdx, fieldIdx: deps.entryGetterField },
        { op: "extern.convert_any" },
        { op: "local.tee", index: 5 },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...(yield* undefinedValue()), { op: "return" }],
        },
        { op: "local.get", index: 0 },
        { op: "local.get", index: 5 },
        { op: "call", funcIdx: deps.callAccessorGetIdx },
        { op: "return" },
      ],
    },
    // Data entry → its value.
    { op: "local.get", index: 4 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: deps.propEntryTypeIdx, fieldIdx: deps.entryValueField },
    { op: "extern.convert_any" },
  ];
}
