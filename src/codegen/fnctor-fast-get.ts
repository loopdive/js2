// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6973) A short `__extern_get` arm for function-constructor INSTANCES.
 *
 * ## The cost it removes
 *
 * Octane deltablue builds its class tree with the pre-ES6 idiom
 * `Child.prototype = new Inheriter()`, so a constraint's `[[Prototype]]` is
 * another `__fnctor_<F>` STRUCT whose own members live in its `$bag`. Every
 * `c.output()` / `this.strength` read on such a receiver went through the whole
 * generic `__extern_get` ladder — error / Map / vec / string arms,
 * `__wrapper_string_value`, the per-carrier bag arms, the closed-struct field
 * ladder, builtin-fn metadata, the instance-expando consult — and a bag hit
 * then RE-ENTERED `__extern_get` on the bag (`__reflect_get_receiver`), while a
 * miss re-entered it on the struct link (#6944). Measured on deltablue
 * (standalone, after #6971): 304 k `__extern_get` entries per rep for 123 k
 * top-level reads, 65 % of the run inclusive.
 *
 * ## What the arm does
 *
 * `__fnctor_fast_get(recv, key) -> (answered, value)`, for an interned
 * (`$HashedString`) key and a receiver of an eligible fnctor type, walks
 * iteratively — no re-entry, nothing cached:
 *
 * 1. the receiver's own DATA property in its `$bag` → answer;
 * 2. its `[[Prototype]]` link (`fnctorProtoLinkInstrs`: the construction-time
 *    snapshot, else the live per-fnctor global — `__fnctor_proto_start`'s
 *    answer):
 *    - an `$Object` → the `$proto` walk, `__obj_find` per level, DATA hits;
 *    - an eligible fnctor struct → repeat 1–2 on it. A hit in a LINK's bag is
 *      the ladder's answer only if the ladder would have entered that chain
 *      at all (`__fnctor_struct_proto_ok` on the receiver's link), so the walk
 *      keeps following links until it reaches an `$Object` or a dead end
 *      (VERIFY mode) and otherwise asks that predicate itself.
 *
 * Every other case DECLINES and falls through to the unchanged ladder: an
 * accessor or tombstoned entry, the bag-shadow sentinel (a bag entry whose
 * value is the bag marks a deleted declared field), a non-`$Object` bag, a
 * null `$proto` (the implicit Object.prototype terminal and the proto-index
 * companions stay the ladder's), a link with a closed prototype edge, a type
 * the ladder does not model, or a key whose hash equals a field name of the
 * type or `constructor` / `__proto__` (the closed-struct field ladder answers
 * those from physical slots — `constructor` from the `$constructor`
 * back-pointer). A hash collision only declines. Because nothing is cached, a
 * prototype write, an own shadowing write, a delete or a re-link is seen by
 * the very next read.
 *
 * The same answer serves `__method_cache_lookup`, so the `__call_m_*`
 * dispatchers' direct-call arm also covers struct-link methods.
 *
 * ## Why the answer cannot differ from the ladder
 *
 * - Eligibility comes from the facts the ladder is built from: a
 *   `__fnctor_<F>` struct in `fnctorPrototypeObject` with an intrinsic `$bag`
 *   slot, not in a split layout family, no cold tail. Struct types are
 *   canonicalized structurally, so a `ref.test T` can also admit a sibling of
 *   identical structure; a type is eligible only when every such sibling has
 *   the same field NAMES, and the ladder here lists the fnctor types in
 *   `__fnctor_proto_start`'s order, so the first matching arm is the same one.
 * - For such a receiver the arms after this one that can fire are the
 *   per-carrier bag arm and `__instance_prop_get` (both the `$bag`), the
 *   deleted-field check (the sentinel — declined), the field ladder (excluded
 *   keys — declined) and the fnctor `[[Prototype]]` hop / walk reproduced
 *   above. Arms unshifted in FRONT of this one still run first for the
 *   receiver; for a link, where the ladder re-enters `__extern_get`, the only
 *   prefix arm that can claim a fnctor instance is the closed prototype-edge
 *   table, which the walk consults itself.
 *
 * The helper consumes `Reflect.get`'s one-shot explicit receiver only when it
 * commits to an answer (a DATA answer does not depend on it); a decline leaves
 * it for the ladder.
 */
import type { FuncHandle, Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { fnctorProtoLinkInstrs } from "./fnctor-identity-fields.js";
import { coldOwnFieldsFor } from "./fnctor-cold-tail.js";
import { INSTANCE_BAG_FIELD } from "../runtime/wasmgc/values/closure-layouts.js";
import { nativeStringLiteralHash } from "../runtime/wasmgc/values/string-literal-bodies.js";

const EQ_HEAP_TYPE = -19;
/** `$PropEntry` flag bits mirrored from object-runtime.ts (FLAG_ACCESSOR | FLAG_TOMBSTONE). */
const ENTRY_DECLINE_FLAGS = 0x08 | 0x80;
const PROP_ENTRY_VALUE = 1;
const PROP_ENTRY_FLAGS = 2;
const OBJECT_PROTO = 0;
const HASHED_STRING_HASH = 3;

/**
 * One arm of the receiver ladder. The ladder lists EVERY fnctor type in
 * `fnctorPrototypeObject` order — the order `__fnctor_proto_start` tests them —
 * so that when two types share one canonical Wasm type, the first `ref.test`
 * that matches here is the one that matches there. `fast` is unset for a type
 * this arm declines.
 */
interface LadderArm {
  readonly typeIdx: number;
  readonly fnctorName: string;
  readonly protoGlobalIdx: number;
  readonly fast?: { readonly bagIdx: number; readonly excludedHashes: readonly number[] };
}

/** Canonical-type key of a final, supertype-less struct; undefined for anything else. */
function fieldSignature(def: unknown): string | undefined {
  const d = def as { kind: string; fields?: { type: ValType; mutable: boolean }[]; superTypeIdx?: number };
  if (d.kind === "struct" && d.superTypeIdx === undefined && d.fields) {
    return JSON.stringify(d.fields.map((f) => [f.type, f.mutable]));
  }
  const s = def as { kind: string; superType?: number | null; final?: boolean; type?: unknown };
  if (s.kind === "sub" && s.superType === null && s.final && s.type) return fieldSignature(s.type);
  return undefined;
}

function fieldNamesOf(def: unknown): string | undefined {
  const d = def as { kind: string; fields?: { name: string }[] };
  return d.kind === "struct" && d.fields ? d.fields.map((f) => f.name).join(",") : undefined;
}

/**
 * Build the ladder (see the module note for the eligibility argument). A type
 * is fast only when every type sharing its canonical structure has the same
 * field NAMES, so a `ref.test` that also admits a structurally identical
 * sibling still reads a `$bag` and excludes the same keys.
 */
function buildLadder(ctx: CodegenContext): LadderArm[] {
  const familyTypes = new Set<number>();
  for (const info of ctx.fnctorLayoutInfo?.values() ?? []) {
    familyTypes.add(info.baseTypeIdx);
    familyTypes.add(info.residTypeIdx);
    for (const layout of info.layouts) familyTypes.add(layout.typeIdx);
  }
  const members = new Map<string, number[]>();
  ctx.mod.types.forEach((def, idx) => {
    const sig = fieldSignature(def);
    if (sig === undefined) return;
    const list = members.get(sig);
    if (list) list.push(idx);
    else members.set(sig, [idx]);
  });
  const structNamesByType = new Map<number, string[]>();
  for (const [structName, idx] of ctx.structMap) {
    const list = structNamesByType.get(idx);
    if (list) list.push(structName);
    else structNamesByType.set(idx, [structName]);
  }
  const memberOk = (idx: number, names: string): boolean => {
    if (familyTypes.has(idx) || fieldNamesOf(ctx.mod.types[idx]) !== names) return false;
    return (structNamesByType.get(idx) ?? []).every(
      (structName) =>
        coldOwnFieldsFor(ctx, structName).length === 0 &&
        (ctx.structFields.get(structName) ?? []).map((f) => f.name).join(",") === names,
    );
  };
  const arms: LadderArm[] = [];
  for (const [fnctorName, protoGlobalIdx] of ctx.fnctorPrototypeObject) {
    const typeIdx = ctx.structMap.get(`__fnctor_${fnctorName}`);
    if (typeIdx === undefined) continue;
    const arm = { typeIdx, fnctorName, protoGlobalIdx };
    const def = ctx.mod.types[typeIdx];
    const sig = fieldSignature(def);
    const names = fieldNamesOf(def);
    if (def?.kind !== "struct" || sig === undefined || names === undefined) {
      arms.push(arm);
      continue;
    }
    const bagIdx = def.fields.findIndex((f) => f?.name === INSTANCE_BAG_FIELD);
    if (bagIdx < 0 || !(members.get(sig) ?? []).every((idx) => memberOk(idx, names))) {
      arms.push(arm);
      continue;
    }
    const excluded = new Set<string>(["constructor", "__proto__", ...def.fields.map((f) => f.name)]);
    arms.push({ ...arm, fast: { bagIdx, excludedHashes: [...new Set([...excluded].map(nativeStringLiteralHash))] } });
  }
  return arms;
}

function globalIndexByName(ctx: CodegenContext, name: string): number | undefined {
  const pos = ctx.mod.globals.findIndex((g) => g.name === name);
  return pos < 0 ? undefined : ctx.numImportGlobals + pos;
}

/**
 * Unshift the arm onto `__extern_get`. Call immediately BEFORE the #3673
 * proto-cache arm is unshifted, so that arm stays the body's prefix (the #4157
 * inline extractor requires it) and this one runs right behind it.
 */
export function unshiftFnctorFastGetArm(ctx: CodegenContext): void {
  if (!ctx.standalone || ctx.hashedStrTypeIdx < 0 || ctx.objectRuntimeTypes === undefined) return;
  const getFn = ctx.mod.functions.find((candidate) => candidate.name === "__extern_get");
  const objFindIdx = ctx.funcMap.get("__obj_find");
  const active = globalIndexByName(ctx, "__reflect_get_receiver_active");
  if (!getFn || objFindIdx === undefined || active === undefined) return;
  const types = buildLadder(ctx);
  if (!types.some((arm) => arm.fast !== undefined)) return;
  const helper = buildHelper(ctx, types, {
    objFindIdx,
    structOkIdx: ctx.funcMap.get("__fnctor_struct_proto_ok"),
    closedProtoHasIdx: ctx.funcMap.get("__closed_proto_has"),
    active,
  });
  getFn.body.unshift(...fastArm(ctx, getFn, helper));
  // (#6973) The `__call_m_<name>_<arity>` dispatchers' round-13 direct-call arm
  // asks `__method_cache_lookup` first and calls the method DIRECTLY on a hit
  // (no `$ObjVec`, no `__extern_method_call` / `__apply_closure`). Its per-key
  // cache only serves a receiver whose link is an `$Object`; answer the rest
  // with this arm before it reports a miss. The dispatcher treats the value
  // exactly like a cache hit — `recv[name]` as `__extern_get` would read it.
  const lookupFn = ctx.mod.functions.find((candidate) => candidate.name === "__method_cache_lookup");
  const last = lookupFn?.body[lookupFn.body.length - 1];
  if (lookupFn && last?.op === "ref.null.extern") {
    lookupFn.body.splice(lookupFn.body.length - 1, 0, ...fastArm(ctx, lookupFn, helper));
  }
}

/**
 * `if (key is $HashedString && recv is not $Object) { answered, v = helper(recv,
 * key); if (answered) return v }` for a function whose params 0/1 are
 * `(recv, key)` and whose result is one externref.
 */
function fastArm(ctx: CodegenContext, fn: WasmFunction, helper: FuncHandle): Instr[] {
  const resultLocal = 2 + fn.locals.length;
  fn.locals.push({ name: "__fnctor_fast_v", type: { kind: "externref" } });
  return [
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: ctx.hashedStrTypeIdx },
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: ctx.objectRuntimeTypes!.objectTypeIdx },
    { op: "i32.eqz" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: helper },
        { op: "local.set", index: resultLocal },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "local.get", index: resultLocal }, { op: "return" }],
        },
      ],
    },
  ];
}

interface HelperDeps {
  readonly objFindIdx: FuncHandle;
  readonly structOkIdx: FuncHandle | undefined;
  readonly closedProtoHasIdx: FuncHandle | undefined;
  readonly active: number;
}

/**
 * Struct links walked past the receiver before handing the termination
 * question back to `__fnctor_struct_proto_ok` (whose own bound is 16 hops).
 */
const MAX_STRUCT_LEVELS = 8;

/**
 * `__obj_find_h(o, key, kh, h)`: `__obj_find(o, key)` for an interned key whose
 * hash `h` is known. The probe sequence is `__obj_find`'s; a slot is decided
 * locally only when the answer is certain — the stored key IS `kh` (a match),
 * or is a `$HashedString` whose computed hash differs (not a match). Any other
 * occupied live slot restarts the lookup in `__obj_find` itself, so the result
 * is that helper's by construction.
 */
function buildFindH(ctx: CodegenContext, objFindIdx: FuncHandle): FuncHandle {
  const HSTR = ctx.hashedStrTypeIdx;
  const { objectTypeIdx: OBJ, propEntryTypeIdx: PE, propMapTypeIdx: MAP } = ctx.objectRuntimeTypes!;
  // params: 0 o, 1 key, 2 kh, 3 h ; locals: 4 arr, 5 mask, 6 i, 7 e, 8 k, 9 kk
  const delegate: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: objFindIdx },
    { op: "return" },
  ];
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: OBJ, fieldIdx: 1 },
    { op: "local.tee", index: 4 },
    { op: "array.len" },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "local.set", index: 5 },
    { op: "local.get", index: 3 },
    { op: "i32.const", value: 0x7fffffff },
    { op: "i32.and" },
    { op: "local.get", index: 5 },
    { op: "i32.and" },
    { op: "local.set", index: 6 },
    {
      op: "loop",
      blockType: { kind: "empty" },
      body: [
        { op: "local.get", index: 4 },
        { op: "local.get", index: 6 },
        { op: "array.get", typeIdx: MAP },
        { op: "local.tee", index: 7 },
        { op: "ref.is_null" },
        { op: "if", blockType: { kind: "empty" }, then: [{ op: "ref.null", typeIdx: PE }, { op: "return" }] },
        { op: "local.get", index: 7 },
        { op: "struct.get", typeIdx: PE, fieldIdx: PROP_ENTRY_FLAGS },
        { op: "i32.const", value: 0x80 }, // FLAG_TOMBSTONE: skipped, probe continues
        { op: "i32.and" },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 7 },
            { op: "struct.get", typeIdx: PE, fieldIdx: 0 },
            { op: "local.tee", index: 8 },
            { op: "ref.test", typeIdx: HSTR },
            { op: "i32.eqz" },
            { op: "if", blockType: { kind: "empty" }, then: delegate },
            { op: "local.get", index: 8 },
            { op: "ref.cast", typeIdx: HSTR },
            { op: "local.tee", index: 9 },
            { op: "local.get", index: 2 },
            { op: "ref.eq" },
            { op: "if", blockType: { kind: "empty" }, then: [{ op: "local.get", index: 7 }, { op: "return" }] },
            { op: "local.get", index: 9 },
            { op: "struct.get", typeIdx: HSTR, fieldIdx: HASHED_STRING_HASH },
            { op: "local.tee", index: 10 },
            { op: "i32.eqz" },
            { op: "local.get", index: 10 },
            { op: "local.get", index: 3 },
            { op: "i32.eq" },
            { op: "i32.or" },
            { op: "if", blockType: { kind: "empty" }, then: delegate },
          ],
        },
        { op: "local.get", index: 6 },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "local.get", index: 5 },
        { op: "i32.and" },
        { op: "local.set", index: 6 },
        { op: "br", depth: 0 },
      ],
    },
    { op: "ref.null", typeIdx: PE },
  ];
  const typeIdx = addFuncType(
    ctx,
    [{ kind: "ref_null", typeIdx: OBJ }, { kind: "externref" }, { kind: "ref_null", typeIdx: HSTR }, { kind: "i32" }],
    [{ kind: "ref_null", typeIdx: PE }],
  );
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__obj_find_h",
    typeIdx,
    locals: [
      { name: "arr", type: { kind: "ref_null", typeIdx: MAP } },
      { name: "mask", type: { kind: "i32" } },
      { name: "i", type: { kind: "i32" } },
      { name: "e", type: { kind: "ref_null", typeIdx: PE } },
      { name: "k", type: { kind: "anyref" } },
      { name: "kk", type: { kind: "ref_null", typeIdx: HSTR } },
      { name: "kh2", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}

// `__fnctor_fast_get` locals (params: 0 recv, 1 key).
const ANY = 2;
const H = 3;
const BAG = 4;
const O = 5;
const E = 6;
const LINK = 7;
const V = 8;
const SNAP = 9;
const CUR = 10;
const LEVEL = 11;
const KH = 12;
const VERIFY = 13;
const FOUND = 14;
const LINK1 = 15;
const decline = (): Instr[] => [{ op: "i32.const", value: 0 }, { op: "ref.null.extern" }, { op: "return" }];
const declineIf = (): Instr => ({ op: "if", blockType: { kind: "empty" }, then: decline() });

/** The receiver ladder over `types`, in `__fnctor_proto_start`'s order. */
function ladderArms(ctx: CodegenContext, types: readonly LadderArm[]): Instr[] {
  // The receiver ladder: an eligible type sets BAG / LINK and leaves the inner
  // block (`br 1` from inside its `if`); any other fnctor type leaves the outer
  // one (`br 2`), which is the "not modelled" exit.
  const typeArms: Instr[] = [];
  for (const t of types) {
    if (t.fast === undefined) {
      typeArms.push({ op: "local.get", index: ANY }, { op: "ref.test", typeIdx: t.typeIdx }, { op: "br_if", depth: 1 });
      continue;
    }
    const excluded: Instr[] = [];
    for (const hash of t.fast.excludedHashes) {
      excluded.push({ op: "local.get", index: H }, { op: "i32.const", value: hash }, { op: "i32.eq" }, declineIf());
    }
    typeArms.push(
      { op: "local.get", index: ANY },
      { op: "ref.test", typeIdx: t.typeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...excluded,
          { op: "local.get", index: ANY },
          { op: "ref.cast", typeIdx: t.typeIdx },
          { op: "struct.get", typeIdx: t.typeIdx, fieldIdx: t.fast.bagIdx },
          { op: "local.set", index: BAG },
          ...fnctorProtoLinkInstrs(ctx, t.fnctorName, t.typeIdx, t.protoGlobalIdx, SNAP, [
            { op: "local.get", index: ANY },
            { op: "ref.cast", typeIdx: t.typeIdx },
          ]),
          { op: "local.set", index: LINK },
          { op: "br", depth: 1 },
        ],
      },
    );
  }
  return typeArms;
}

function buildHelper(ctx: CodegenContext, types: readonly LadderArm[], d: HelperDeps): FuncHandle {
  const HSTR = ctx.hashedStrTypeIdx;
  const { objectTypeIdx: OBJ, propEntryTypeIdx: PE } = ctx.objectRuntimeTypes!;
  const findH = buildFindH(ctx, d.objFindIdx);
  const ext: ValType = { kind: "externref" };
  // Commit: consume Reflect.get's one-shot receiver (a DATA answer does not
  // depend on it), then answer `1, value`.
  const answer = (value: Instr[]): Instr[] => [
    { op: "i32.const", value: 0 },
    { op: "global.set", index: d.active },
    { op: "i32.const", value: 1 },
    ...value,
    { op: "return" },
  ];
  const answerFound = (): Instr[] => answer([{ op: "local.get", index: FOUND }, { op: "extern.convert_any" }]);
  // The chain from the receiver's link failed to terminate within this walk's
  // bound, or reached a type the ladder below does not model: ask the exact
  // predicate the ladder asks, and answer the found value only if it agrees.
  const verifyByPredicate = (): Instr[] =>
    d.structOkIdx === undefined
      ? decline()
      : [
          { op: "local.get", index: LINK1 },
          { op: "call", funcIdx: d.structOkIdx },
          { op: "i32.eqz" },
          declineIf(),
          ...answerFound(),
        ];
  const find = (objectRef: Instr[]): Instr[] => [
    ...objectRef,
    { op: "local.get", index: 1 },
    { op: "local.get", index: KH },
    { op: "local.get", index: H },
    { op: "call", funcIdx: findH },
    { op: "local.tee", index: E },
  ];
  // Entry in local E is a live DATA entry, else decline.
  const requireData: Instr[] = [
    { op: "local.get", index: E },
    { op: "struct.get", typeIdx: PE, fieldIdx: PROP_ENTRY_FLAGS },
    { op: "i32.const", value: ENTRY_DECLINE_FLAGS },
    { op: "i32.and" },
    declineIf(),
  ];
  const typeArms = ladderArms(ctx, types);
  // Own DATA property of CUR in its bag → V (and fall through), else nothing.
  const bagLookup: Instr[] = [
    { op: "local.get", index: BAG },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: BAG },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: OBJ },
        { op: "i32.eqz" },
        declineIf(),
        ...find([{ op: "local.get", index: BAG }, { op: "any.convert_extern" }, { op: "ref.cast", typeIdx: OBJ }]),
        { op: "ref.is_null" },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...requireData,
            { op: "local.get", index: E },
            { op: "struct.get", typeIdx: PE, fieldIdx: PROP_ENTRY_VALUE },
            { op: "local.tee", index: V },
            // Bag-shadow sentinel (value === the bag): a deleted declared field.
            { op: "ref.test", typeIdx: EQ_HEAP_TYPE },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "i32" } },
              then: [
                { op: "local.get", index: V },
                { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
                { op: "local.get", index: BAG },
                { op: "any.convert_extern" },
                { op: "ref.cast", typeIdx: EQ_HEAP_TYPE },
                { op: "ref.eq" },
              ],
              else: [{ op: "i32.const", value: 0 }],
            },
            declineIf(),
            // Level 0 is the receiver itself: answer. A deeper hit is only the
            // ladder's answer once the chain from the receiver's link is known
            // to terminate — keep walking links in VERIFY mode.
            { op: "local.get", index: LEVEL },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: answer([{ op: "local.get", index: V }, { op: "extern.convert_any" }]),
            },
            { op: "local.get", index: V },
            { op: "local.set", index: FOUND },
            { op: "i32.const", value: 1 },
            { op: "local.set", index: VERIFY },
          ],
        },
      ],
    },
  ];
  // The `$proto` walk from an `$Object` link: DATA hits only; a null `$proto`
  // (the implicit Object.prototype terminal) declines.
  const objectWalk: Instr[] = [
    { op: "local.get", index: LINK },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: OBJ },
    { op: "local.set", index: O },
    {
      op: "loop",
      blockType: { kind: "empty" },
      body: [
        ...find([{ op: "local.get", index: O }]),
        { op: "ref.is_null" },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...requireData,
            ...answer([
              { op: "local.get", index: E },
              { op: "struct.get", typeIdx: PE, fieldIdx: PROP_ENTRY_VALUE },
              { op: "extern.convert_any" },
            ]),
          ],
        },
        { op: "local.get", index: O },
        { op: "struct.get", typeIdx: OBJ, fieldIdx: OBJECT_PROTO },
        { op: "local.tee", index: O },
        { op: "ref.is_null" },
        declineIf(),
        { op: "br", depth: 0 },
      ],
    },
  ];
  // One iteration: CUR is the receiver (LEVEL 0) or its LEVEL-th struct link.
  const iteration: Instr[] = [
    { op: "local.get", index: CUR },
    { op: "any.convert_extern" },
    { op: "local.set", index: ANY },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        { op: "block", blockType: { kind: "empty" }, body: [...typeArms, { op: "br", depth: 1 }] },
        // ── an eligible type: BAG / LINK set ──
        { op: "local.get", index: VERIFY },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // VERIFY: only the termination of the struct chain matters now.
            { op: "local.get", index: LINK },
            { op: "ref.is_null" },
            { op: "if", blockType: { kind: "empty" }, then: answerFound() },
            { op: "local.get", index: LINK },
            { op: "any.convert_extern" },
            { op: "ref.test", typeIdx: OBJ },
            { op: "if", blockType: { kind: "empty" }, then: answerFound() },
          ],
          else: [
            // The closed prototype-edge table (`Object.setPrototypeOf` on an
            // expando carrier) overrides the struct's own link. `__extern_get`
            // consults it in a prefix arm — for the receiver before this arm
            // runs, for a link when the ladder re-enters on it — but
            // `__method_cache_lookup` does not, so ask at every level. Every
            // other prefix arm tests a non-fnctor carrier type.
            ...(d.closedProtoHasIdx === undefined
              ? []
              : ([
                  { op: "local.get", index: CUR },
                  { op: "call", funcIdx: d.closedProtoHasIdx },
                  declineIf(),
                ] satisfies Instr[])),
            // `__fnctor_struct_proto_ok(link)` is 0 when the receiver's link
            // itself has no [[Prototype]]; the ladder then never enters it.
            { op: "local.get", index: LEVEL },
            { op: "i32.const", value: 1 },
            { op: "i32.eq" },
            { op: "local.get", index: LINK },
            { op: "ref.is_null" },
            { op: "i32.and" },
            declineIf(),
            ...bagLookup,
            { op: "local.get", index: VERIFY },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: LINK },
                { op: "ref.is_null" },
                { op: "if", blockType: { kind: "empty" }, then: answerFound() },
                { op: "local.get", index: LINK },
                { op: "any.convert_extern" },
                { op: "ref.test", typeIdx: OBJ },
                { op: "if", blockType: { kind: "empty" }, then: answerFound() },
              ],
              else: [
                { op: "local.get", index: LINK },
                { op: "ref.is_null" },
                declineIf(),
                { op: "local.get", index: LINK },
                { op: "any.convert_extern" },
                { op: "ref.test", typeIdx: OBJ },
                { op: "if", blockType: { kind: "empty" }, then: [...objectWalk, ...decline()] },
              ],
            },
          ],
        },
        // ── LINK is a struct: step to it ──
        { op: "local.get", index: LEVEL },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: LINK },
            { op: "local.set", index: LINK1 },
          ],
        },
        { op: "local.get", index: LEVEL },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "local.tee", index: LEVEL },
        { op: "i32.const", value: MAX_STRUCT_LEVELS },
        { op: "i32.gt_u" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "local.get", index: VERIFY }, { op: "i32.eqz" }, declineIf(), ...verifyByPredicate()],
        },
        { op: "local.get", index: LINK },
        { op: "local.set", index: CUR },
        { op: "br", depth: 1 },
      ],
    },
    // ── not modelled by the ladder ──
    { op: "local.get", index: VERIFY },
    { op: "i32.eqz" },
    declineIf(),
    ...verifyByPredicate(),
  ];
  const body: Instr[] = [
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: HSTR },
    { op: "local.tee", index: KH },
    { op: "struct.get", typeIdx: HSTR, fieldIdx: HASHED_STRING_HASH },
    { op: "local.tee", index: H },
    { op: "i32.eqz" },
    declineIf(),
    { op: "local.get", index: 0 },
    { op: "local.set", index: CUR },
    { op: "loop", blockType: { kind: "empty" }, body: iteration },
    ...decline(),
  ];
  const typeIdx = addFuncType(ctx, [ext, ext], [{ kind: "i32" }, ext]);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__fnctor_fast_get",
    typeIdx,
    locals: [
      { name: "any", type: { kind: "anyref" } },
      { name: "h", type: { kind: "i32" } },
      { name: "bag", type: ext },
      { name: "o", type: { kind: "ref_null", typeIdx: OBJ } },
      { name: "e", type: { kind: "ref_null", typeIdx: PE } },
      { name: "link", type: ext },
      { name: "v", type: { kind: "anyref" } },
      { name: "snap", type: ext },
      { name: "cur", type: ext },
      { name: "level", type: { kind: "i32" } },
      { name: "kh", type: { kind: "ref_null", typeIdx: HSTR } },
      { name: "verify", type: { kind: "i32" } },
      { name: "found", type: { kind: "anyref" } },
      { name: "link1", type: ext },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}
