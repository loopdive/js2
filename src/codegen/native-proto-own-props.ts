// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4248) OWN properties of a BUILTIN PROTOTYPE object under `--target
 * standalone` — `Number.prototype.hasOwnProperty("toString")` and friends.
 *
 * ## The gap
 *
 * In standalone a builtin `.prototype` evaluates to the `$NativeProto` glue
 * singleton (native-proto.ts) — a struct that is NOT a `$Object`. Its member
 * set lives in the `$memberCsv` field, which is a native string, not a
 * `$PropEntry` table. `__hasOwnProperty` casts its receiver to `$Object`, so a
 * `$NativeProto` receiver fell through the `ref.test` and answered `false` for
 * every one of its OWN methods:
 *
 * ```js
 * Number.prototype.hasOwnProperty("toString")   // was false, must be true
 * Object.prototype.hasOwnProperty.call(Number.prototype, "valueOf")  // idem
 * ```
 *
 * The second spelling is what makes this worth more than the seven Sputnik
 * `S15.7.4_A3.*` files it looks like: `propertyHelper.js`'s `verifyProperty`
 * OPENS with exactly that call, so every `built-ins/<Wrapper>/prototype/<m>/
 * prop-desc.js` died on it — with the message "toString should be an own
 * property", which names the member but not the receiver kind, and reads like a
 * descriptor bug rather than a receiver-shape one. The descriptor synthesis
 * behind it (#2885 Site-2) was already correct: `gOPD(Number.prototype,
 * "toString").value === Number.prototype.toString` held on the same build.
 *
 * ## Why a hybrid seeded-member ladder and CSV scan
 *
 * Immutable and unseeded members stay on the brand-agnostic `$memberCsv` scan:
 * one native, constant-size path that automatically covers glue registered
 * later. Seeded DATA methods are different because their companion entry can
 * be replaced or deleted. A demand-gated per-brand/member ladder recognizes
 * only those materialized mutable keys before the CSV shortcut and asks the
 * companion for the authoritative own-property answer. This keeps the common
 * immutable path compact without letting the CSV resurrect deleted methods.
 *
 * ## `constructor` is own, unconditionally, and is NOT in the CSV
 *
 * ES5 gives every builtin prototype an own `constructor` (§15.7.4.1 for Number,
 * §15.6.4.1 for Boolean, §15.5.4.1 for String, …). The glue CSVs list METHODS
 * only, and the `$ctor` field is still null in the S1 `$NativeProto` (the
 * `.constructor` VALUE is answered by a static fold / #4223's carrier, not by
 * that field). So presence is answered from the spec, not from `$ctor` — a
 * `ref.is_null` test on `$ctor` would answer `false` for every prototype in the
 * corpus.
 *
 * ## Consult-only, and builtin-only
 *
 * The arm answers `1` and returns, or falls through to the untouched original
 * body. It never answers `0` authoritatively, so a prototype carrying an
 * ordinary expando still finds it through the existing path. It also declines
 * on `$isClass != 0`: a user CLASS proto is a `$NativeProto` façade over the
 * class's own machinery (#2101), whose own-property question is answered
 * elsewhere, and widening it here would change behaviour no test asked for.
 *
 * ## Demand gate
 *
 * `ctx.nativeProtoTypeIdx === undefined` ⇒ the module never materialized a
 * builtin prototype at all ⇒ nothing is minted and no body is touched. That is
 * the whole gate, and it is exact rather than heuristic: the struct type is
 * registered by the same call that builds the singleton. #4232 §5's lesson —
 * an unconditional carrier pull-in is a cost regression that reads as a
 * semantic one — applies to carriers that materialize CLOSURES; this native
 * materializes nothing and is reachable only through a receiver the module
 * must already be able to produce.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { seededNativeProtoDataMembersByBrand } from "./native-proto.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";
import { addFuncType } from "./registry/types.js";

/** `$NativeProto` field indices — the reader-visible contract (native-proto.ts). */
const NP_BRAND = 0;
const NP_IS_CLASS = 1;
const NP_MEMBER_CSV = 4;
/** `$NativeString` layout: (len i32, off i32, data (array i16)). */
const STR_LEN = 0;
const STR_OFF = 1;
const STR_DATA = 2;
/** The CSV delimiter the glue joins member names with. */
const COMMA = 0x2c;

export const NATIVE_PROTO_HASOWN_FN = "__nproto_hasown";

/**
 * Register `__nproto_hasown(obj externref, key externref) -> i32`: 1 when `key`
 * names an OWN property of a BUILTIN prototype object `obj`, else 0.
 *
 * Returns the funcIdx, or `undefined` when the module has no `$NativeProto`
 * (the demand gate) or the native-string subsystem is absent.
 */
export function registerNativeProtoHasOwn(ctx: CodegenContext): number | undefined {
  if (!ctx.standalone) return undefined;
  const existing = ctx.funcMap.get(NATIVE_PROTO_HASOWN_FN);
  if (existing !== undefined) return existing;
  const protoTypeIdx = ctx.nativeProtoTypeIdx;
  if (protoTypeIdx === undefined) return undefined;
  const anyStr = ctx.anyStrTypeIdx;
  const natStr = ctx.nativeStrTypeIdx;
  const dataIdx = ctx.nativeStrDataTypeIdx;
  if (anyStr < 0 || natStr < 0 || dataIdx < 0) return undefined;
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const equalsIdx = ctx.nativeStrHelpers.get("__str_equals");
  if (flattenIdx === undefined || equalsIdx === undefined) return undefined;
  const seededDataMembers = seededNativeProtoDataMembersByBrand(ctx);
  const protoOwnRecvIdx = ctx.funcMap.get("__protoidx_own_recv");
  const objectHasOwnIdx = ctx.funcMap.get("__object_hasOwn");

  // params: 0 obj, 1 key
  const L_ANY = 2;
  const L_KEY = 3;
  const L_CSV = 4;
  const L_KLEN = 5;
  const L_N = 6;
  const L_I = 7;
  const L_START = 8;
  const L_J = 9;
  const L_C = 10;
  const locals: { name: string; type: ValType }[] = [
    { name: "any", type: { kind: "anyref" } },
    { name: "fkey", type: { kind: "ref_null", typeIdx: natStr } },
    { name: "fcsv", type: { kind: "ref_null", typeIdx: natStr } },
    { name: "klen", type: { kind: "i32" } },
    { name: "n", type: { kind: "i32" } },
    { name: "i", type: { kind: "i32" } },
    { name: "start", type: { kind: "i32" } },
    { name: "j", type: { kind: "i32" } },
    { name: "c", type: { kind: "i32" } },
  ];

  const returnZero: Instr[] = [{ op: "i32.const", value: 0 }, { op: "return" }];
  /** `<flat>.data[<flat>.off + <index expr>]` as an unsigned char code. */
  const charAt = (strLocal: number, indexExpr: Instr[]): Instr[] => [
    { op: "local.get", index: strLocal },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: natStr, fieldIdx: STR_DATA },
    { op: "local.get", index: strLocal },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: natStr, fieldIdx: STR_OFF },
    ...indexExpr,
    { op: "i32.add" },
    { op: "array.get_u", typeIdx: dataIdx },
  ];

  const body: Instr[] = [
    // The receiver must be a `$NativeProto` …
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: L_ANY },
    { op: "ref.test", typeIdx: protoTypeIdx },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: returnZero },
    // … for a BUILTIN, not a user class (see the module note).
    { op: "local.get", index: L_ANY },
    { op: "ref.cast", typeIdx: protoTypeIdx },
    { op: "struct.get", typeIdx: protoTypeIdx, fieldIdx: NP_IS_CLASS },
    { op: "if", blockType: { kind: "empty" }, then: returnZero },
    // A non-string key (symbol, boxed number) names no member of a prototype.
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: anyStr },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: returnZero },
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: anyStr },
    { op: "call", funcIdx: flattenIdx },
    { op: "local.tee", index: L_KEY },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: natStr, fieldIdx: STR_LEN },
    { op: "local.set", index: L_KLEN },
    // A seeded DATA method is no longer an immutable CSV fact: its companion
    // entry is the real own property and can be replaced or deleted. Resolve
    // those keys through the companion before the historical CSV shortcut.
    // Accessors and `constructor` deliberately fall through because neither is
    // seeded yet and their existing synthesized paths remain authoritative.
    ...(protoOwnRecvIdx === undefined || objectHasOwnIdx === undefined
      ? []
      : [...seededDataMembers.entries()].flatMap(([brand, members]) => [
          { op: "local.get", index: L_ANY } as Instr,
          { op: "ref.cast", typeIdx: protoTypeIdx } as Instr,
          { op: "struct.get", typeIdx: protoTypeIdx, fieldIdx: NP_BRAND } as Instr,
          { op: "i32.const", value: brand } as Instr,
          { op: "i32.eq" } as Instr,
          {
            op: "if",
            blockType: { kind: "empty" },
            then: members.flatMap((member) => [
              { op: "local.get", index: L_KEY } as Instr,
              { op: "ref.as_non_null" } as Instr,
              ...nativeStringLiteralInstrs(ctx, member),
              { op: "call", funcIdx: equalsIdx } as Instr,
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: 0 },
                  { op: "call", funcIdx: protoOwnRecvIdx },
                  { op: "local.get", index: 1 },
                  { op: "call", funcIdx: objectHasOwnIdx },
                  { op: "return" },
                ],
              } as Instr,
            ]),
          } as Instr,
        ])),
    // ES5 §15.x.4.1 — `constructor` is an own property of every builtin proto.
    { op: "local.get", index: L_KEY },
    { op: "ref.as_non_null" },
    ...nativeStringLiteralInstrs(ctx, "constructor"),
    { op: "call", funcIdx: equalsIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 1 }, { op: "return" }],
    },
    // The advertised member set. `$memberCsv` is always a native string for a
    // glue-built proto; anything else means a shape this arm does not own.
    { op: "local.get", index: L_ANY },
    { op: "ref.cast", typeIdx: protoTypeIdx },
    { op: "struct.get", typeIdx: protoTypeIdx, fieldIdx: NP_MEMBER_CSV },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: anyStr },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: returnZero },
    { op: "local.get", index: L_ANY },
    { op: "ref.cast", typeIdx: protoTypeIdx },
    { op: "struct.get", typeIdx: protoTypeIdx, fieldIdx: NP_MEMBER_CSV },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: anyStr },
    { op: "call", funcIdx: flattenIdx },
    { op: "local.tee", index: L_CSV },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: natStr, fieldIdx: STR_LEN },
    { op: "local.set", index: L_N },
    // Token scan. `i` runs to `n` INCLUSIVE and the end-of-string position is
    // treated as a delimiter, so the last token needs no special case.
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_I },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_START },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: L_I },
            { op: "local.get", index: L_N },
            { op: "i32.gt_s" },
            { op: "br_if", depth: 1 },
            // c = i < n ? csv[i] : ','
            { op: "local.get", index: L_I },
            { op: "local.get", index: L_N },
            { op: "i32.lt_s" },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "i32" } },
              then: charAt(L_CSV, [{ op: "local.get", index: L_I }]),
              else: [{ op: "i32.const", value: COMMA }],
            },
            { op: "local.set", index: L_C },
            { op: "local.get", index: L_C },
            { op: "i32.const", value: COMMA },
            { op: "i32.eq" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                // Token [start, i) — compare only when the lengths match.
                { op: "local.get", index: L_I },
                { op: "local.get", index: L_START },
                { op: "i32.sub" },
                { op: "local.get", index: L_KLEN },
                { op: "i32.eq" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "i32.const", value: 0 },
                    { op: "local.set", index: L_J },
                    {
                      op: "block",
                      blockType: { kind: "empty" },
                      body: [
                        {
                          op: "loop",
                          blockType: { kind: "empty" },
                          body: [
                            { op: "local.get", index: L_J },
                            { op: "local.get", index: L_KLEN },
                            { op: "i32.ge_s" },
                            // Ran off the end with every unit equal → a hit.
                            {
                              op: "if",
                              blockType: { kind: "empty" },
                              then: [{ op: "i32.const", value: 1 }, { op: "return" }],
                            },
                            ...charAt(L_CSV, [
                              { op: "local.get", index: L_START },
                              { op: "local.get", index: L_J },
                              { op: "i32.add" },
                            ]),
                            ...charAt(L_KEY, [{ op: "local.get", index: L_J }]),
                            { op: "i32.ne" },
                            { op: "br_if", depth: 2 },
                            { op: "local.get", index: L_J },
                            { op: "i32.const", value: 1 },
                            { op: "i32.add" },
                            { op: "local.set", index: L_J },
                            { op: "br", depth: 0 },
                          ],
                        },
                      ],
                    },
                  ],
                },
                { op: "local.get", index: L_I },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_START },
              ],
            },
            { op: "local.get", index: L_I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "i32.const", value: 0 },
  ];

  const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(NATIVE_PROTO_HASOWN_FN, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: NATIVE_PROTO_HASOWN_FN,
    typeIdx,
    locals,
    body,
    exported: false,
  });
  return funcIdx;
}

/**
 * Finalize splice: teach the standalone own-property predicates about builtin
 * prototype receivers.
 *
 * Runs at finalize (not from `ensureObjectRuntime`) because `$NativeProto` is
 * registered lazily, on the first builtin-prototype materialization — which is
 * during BODY compilation, long after the object runtime is emitted. Minting
 * here is append-only and the `call` is baked in the same pass, so no
 * previously-resolved funcIdx moves.
 */
export function unshiftNativeProtoHasOwnArms(ctx: CodegenContext): void {
  const funcIdx = registerNativeProtoHasOwn(ctx);
  if (funcIdx === undefined) return;
  for (const name of ["__hasOwnProperty", "__object_hasOwn", "__propertyIsEnumerable"]) {
    const fn = ctx.mod.functions.find((candidate) => candidate.name === name);
    if (!fn) continue;
    fn.body.unshift(
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // §15.x.4 — every builtin prototype member is `{ DontEnum }`, so the
          // enumerability predicate answers 0 where presence answers 1.
          { op: "i32.const", value: name === "__propertyIsEnumerable" ? 0 : 1 },
          { op: "return" },
        ],
      },
    );
  }
}
