// (#3116) __vec_set_elem / __vec_set_len — array-exotic [[DefineOwnProperty]]
// write-back exports for the JS-host runtime.
//
// Root cause these fix: `Object.defineProperty(arr, "0", {value: v})` (and the
// plural `defineProperties`) on a STATICALLY-typed array receiver reaches the
// runtime's opaque-struct arm, which could only store `v` in the host-side
// sidecar — but element/length READS compile to direct WasmGC vec accesses
// (struct.get / array.get / __vec_get), which never consult the sidecar. So the
// define was invisible to every subsequent read (the `15.2.3.6-4-*` /
// `15.2.3.7-6-a-*` test262 cluster). These exports let the runtime write the
// VALUE into the vec itself (attributes stay in the sidecar), restoring
// read/write path consistency for both the static and dynamic read lanes.
//
// Mirrors the __vec_push/__vec_pop per-vec-type ref.test dispatch and grow
// discipline (newCap = max((idx+1)*2, 4), array.new_default + array.copy +
// struct.set). Unsupported element kinds return the -1 sentinel so the runtime
// falls back to its previous sidecar-only behaviour. Emission is gated (by the
// caller in `_emitVecAccessExportsInner`) on a defineProperty import being
// present so modules that never define properties stay byte-identical.
import type { FuncHandle, Instr, LocalDef, ValType, WasmFunction } from "../ir/types.js";
import { HOLE_F64_BITS } from "./value-tags.js"; // (#6482 r4)
import type { CodegenContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { PROGRAM_ABI_CALLABLE_ROLE } from "./program-abi-planning.js";
import { addFuncType, getArrTypeIdxFromVec } from "./registry/types.js";
import {
  nativeStrVecElemTypeIdx,
  VEC_HOST_BRIDGE_ROLE,
  type VecHostBridgeWritebackKind,
  vecHostBridgeWritebackOrdinal,
} from "./vec-access-exports.js";

/**
 * (#3520 W1-E) Allocate one write-back helper and give it its structural
 * Program ABI owner.
 *
 * Two things are deliberate here.
 *
 * **Stable handle, not a live index.** The pair used to mint
 * `ctx.numImportFuncs + mod.functions.length` and bake that number into
 * `mod.exports` and `funcMap`. `emitVecAccessExports` runs at
 * `src/codegen/index.ts:11111`, and `addUnionImports` runs at `:11153` — i.e.
 * imports can still land AFTER these functions exist, which is exactly the
 * chased-live-index regime `func-space.ts` documents as unsound (#3909). The
 * bridge helpers next door already mint stable handles; these now do too.
 *
 * **Observation cannot fire `planning-sealed`.** `observeEntrySourceSupports`
 * throws once retained planning has run, and retained planning happens inside
 * `eliminateDeadLayoutAndPlanProgramAbi` — `src/codegen/index.ts:11397` in the
 * main flow and `:6751` in the compile-project flow, both strictly after the
 * `emitVecAccessExports` call that reaches this emitter (`:11111` / `:5991`).
 */
function defineWritebackHelper(
  ctx: CodegenContext,
  kind: VecHostBridgeWritebackKind,
  name: string,
  typeIdx: number,
  locals: LocalDef[],
  body: Instr[],
): void {
  const func: WasmFunction = { name, typeIdx, locals, body, exported: true };
  const funcIdx: FuncHandle = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, func);
  ctx.mod.exports.push({ name, desc: { kind: "func", index: funcIdx } });
  ctx.funcMap.set(name, funcIdx);
  ctx.programAbiCallables?.observeEntrySourceSupports([
    {
      role: VEC_HOST_BRIDGE_ROLE,
      roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.vecHostBridge,
      derivedOrdinal: vecHostBridgeWritebackOrdinal(kind),
      displayName: name,
      funcIdx,
    },
  ]);
}

/**
 * Emit the two write-back exports. `mutEntries` is the caller's filtered
 * (elem-kind-supported) vec-type list; `unboxNumIdx` the `__unbox_number`
 * funcIdx (defined whenever a non-externref elem kind is in `mutEntries`).
 */
export function emitVecDefineWritebackExports(
  ctx: CodegenContext,
  mutEntries: Array<[string, number]>,
  unboxNumIdx: number | undefined,
): void {
  // __vec_set_elem(externref vec, i32 idx, externref value) -> i32 (1 = ok, -1 = unsupported)
  {
    const setElemTypeIdx = addFuncType(
      ctx,
      [{ kind: "externref" }, { kind: "i32" }, { kind: "externref" }],
      [{ kind: "i32" }],
      "$__vec_set_elem_type",
    );
    // params: 0 = vec (externref), 1 = idx (i32), 2 = value (externref)
    const locals: { name: string; type: ValType }[] = [{ name: "__any", type: { kind: "anyref" } }];
    const body: Instr[] = [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: 3 }];
    let current: Instr[] = [{ op: "i32.const", value: -1 }, { op: "return" }];
    for (let i = mutEntries.length - 1; i >= 0; i--) {
      const [elemKey, vecTypeIdx] = mutEntries[i]!;
      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      if (arrTypeIdx < 0) continue;
      const base = 3 + locals.length; // 3 params + locals so far
      const vecL = base;
      const dataL = base + 1;
      const lenL = base + 2;
      const ncapL = base + 3;
      const ndataL = base + 4;
      locals.push(
        { name: `__vse_vec_${vecTypeIdx}`, type: { kind: "ref_null", typeIdx: vecTypeIdx } },
        { name: `__vse_data_${vecTypeIdx}`, type: { kind: "ref_null", typeIdx: arrTypeIdx } },
        { name: `__vse_len_${vecTypeIdx}`, type: { kind: "i32" } },
        { name: `__vse_ncap_${vecTypeIdx}`, type: { kind: "i32" } },
        { name: `__vse_ndata_${vecTypeIdx}`, type: { kind: "ref_null", typeIdx: arrTypeIdx } },
      );
      // value unboxing per element kind (value param is local 2)
      const strElemIdx = nativeStrVecElemTypeIdx(ctx, vecTypeIdx);
      // (#4531) Struct-ref element: mirror the __vec_push arm — recover the
      // typed element from the externref value; the guard in `thenBranch`
      // proves the ref.test first, so the cast cannot trap.
      const setArrDef = ctx.mod.types[arrTypeIdx];
      const structElemTypeIdx =
        elemKey === "structref" &&
        setArrDef?.kind === "array" &&
        (setArrDef.element.kind === "ref" || setArrDef.element.kind === "ref_null")
          ? setArrDef.element.typeIdx
          : -1;
      const valueInstrs: Instr[] =
        elemKey === "externref"
          ? [{ op: "local.get", index: 2 }]
          : elemKey === "f64"
            ? [
                { op: "local.get", index: 2 },
                { op: "call", funcIdx: unboxNumIdx! },
              ]
            : elemKey === "i32"
              ? [{ op: "local.get", index: 2 }, { op: "call", funcIdx: unboxNumIdx! }, { op: "i32.trunc_sat_f64_s" }]
              : elemKey === "structref"
                ? [
                    { op: "local.get", index: 2 },
                    { op: "any.convert_extern" },
                    { op: "ref.cast", typeIdx: structElemTypeIdx },
                  ]
                : // (#3311) native-string carrier: recover the `$AnyString` ref element.
                  [
                    { op: "local.get", index: 2 },
                    { op: "any.convert_extern" },
                    { op: "ref.cast", typeIdx: strElemIdx },
                  ];
      const thenBranch: Instr[] = [
        // (#4531) An incompatible value must NOT trap the cast in `valueInstrs`
        // — answer the -1 unsupported sentinel so the runtime keeps its legacy
        // sidecar fallback for that define.
        ...(elemKey === "structref"
          ? ([
              { op: "local.get", index: 2 },
              { op: "any.convert_extern" },
              { op: "ref.test", typeIdx: structElemTypeIdx },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "i32.const", value: -1 }, { op: "return" }],
              },
            ] satisfies Instr[])
          : []),
        { op: "local.get", index: 3 },
        { op: "ref.cast", typeIdx: vecTypeIdx },
        { op: "local.set", index: vecL },
        // len
        { op: "local.get", index: vecL },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
        { op: "local.set", index: lenL },
        // data + capacity check: cap < idx+1 ?
        { op: "local.get", index: vecL },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
        { op: "local.tee", index: dataL },
        { op: "array.len" },
        { op: "local.get", index: 1 },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "i32.lt_s" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // ncap = max((idx+1)*2, 4)
            { op: "local.get", index: 1 },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "i32.const", value: 1 },
            { op: "i32.shl" },
            { op: "i32.const", value: 4 },
            { op: "local.get", index: 1 },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "i32.const", value: 1 },
            { op: "i32.shl" },
            { op: "i32.const", value: 4 },
            { op: "i32.gt_s" },
            { op: "select" },
            { op: "local.set", index: ncapL },
            // ndata = array.new_default(ncap); copy old len; vec.data = ndata
            { op: "local.get", index: ncapL },
            { op: "array.new_default", typeIdx: arrTypeIdx },
            { op: "local.set", index: ndataL },
            { op: "local.get", index: ndataL },
            { op: "i32.const", value: 0 },
            { op: "local.get", index: dataL },
            { op: "i32.const", value: 0 },
            { op: "local.get", index: lenL },
            { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx },
            { op: "local.get", index: vecL },
            { op: "local.get", index: ndataL },
            { op: "ref.as_non_null" },
            { op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 1 },
            { op: "local.get", index: ndataL },
            { op: "local.set", index: dataL },
          ],
        },
        // data[idx] = value
        { op: "local.get", index: dataL },
        { op: "local.get", index: 1 },
        ...valueInstrs,
        { op: "array.set", typeIdx: arrTypeIdx },
        // vec.length = max(len, idx+1)
        { op: "local.get", index: lenL },
        { op: "local.get", index: 1 },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "i32.lt_s" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: vecL },
            { op: "local.get", index: 1 },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 },
          ],
        },
        { op: "i32.const", value: 1 },
        { op: "return" },
      ];
      current = [
        { op: "local.get", index: 3 },
        { op: "ref.test", typeIdx: vecTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: thenBranch,
          else: current,
        },
      ];
    }
    // Every dispatch arm returns, but the nested empty-block `if` shape does
    // not communicate that fact to the stack-balance verifier. Make the
    // impossible fallthrough explicit instead of letting the safety net append
    // a lossy default result.
    body.push(...current, { op: "unreachable" });
    defineWritebackHelper(ctx, "setElem", "__vec_set_elem", setElemTypeIdx, locals, body);
  }

  // (#6482 r4) The f64 absence-marker fill for a length change. Returns
  // undefined for a carrier that has no marker (ref/packed/i32 kinds), which
  // leaves those arms byte-identical.
  //
  // SHRINK ONLY, and that restriction is load-bearing. This export is also the
  // replay path for a host mirror (`registerVecMirror`): an append arrives as
  // `__vec_set_elem(i, v)` followed by `__vec_set_len(i + 1)`, so the element
  // is ALREADY in the slot when the length store runs. Filling the grown tail
  // here erased it — a plain `[0, 1]` literal came back with index 1 absent.
  // A grow needs no fill anyway: the shrink that orphaned those slots marked
  // them on its way down.
  const holeFillArm = (
    vecTypeIdx: number,
    arrTypeIdx: number,
    vecL: number,
    dataL: number,
    lenL: number,
  ): Instr[] | undefined => {
    const arrDef = ctx.mod.types[arrTypeIdx];
    if (arrDef === undefined || arrDef.kind !== "array") return undefined;
    if ((arrDef.element as ValType).kind !== "f64") return undefined;
    return [
      // oldLen > newLen? Only then does this store orphan anything.
      { op: "local.get", index: lenL },
      { op: "local.get", index: 1 },
      { op: "i32.gt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // data (re-read: the grow above may have replaced it)
          { op: "local.get", index: vecL },
          { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
          { op: "local.set", index: dataL },
          // fill [newLen, array.len) with the absence marker
          { op: "local.get", index: 1 },
          { op: "local.set", index: lenL },
          { op: "local.get", index: dataL },
          { op: "local.get", index: lenL },
          { op: "i64.const", value: HOLE_F64_BITS },
          { op: "f64.reinterpret_i64" },
          // count = arrayLen - start, clamped by the array itself
          { op: "local.get", index: dataL },
          { op: "array.len" },
          { op: "local.get", index: lenL },
          { op: "i32.sub" },
          { op: "array.fill", typeIdx: arrTypeIdx },
        ],
      },
    ];
  };

  // __vec_set_len(externref vec, i32 newLen) -> i32 (1 = ok, -1 = unsupported)
  {
    const setLenTypeIdx = addFuncType(
      ctx,
      [{ kind: "externref" }, { kind: "i32" }],
      [{ kind: "i32" }],
      "$__vec_set_len_type",
    );
    // params: 0 = vec (externref), 1 = newLen (i32)
    const locals: { name: string; type: ValType }[] = [{ name: "__any", type: { kind: "anyref" } }];
    const body: Instr[] = [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: 2 }];
    let current: Instr[] = [{ op: "i32.const", value: -1 }, { op: "return" }];
    for (let i = mutEntries.length - 1; i >= 0; i--) {
      const [, vecTypeIdx] = mutEntries[i]!;
      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      if (arrTypeIdx < 0) continue;
      const base = 2 + locals.length; // 2 params + locals so far
      const vecL = base;
      const dataL = base + 1;
      const lenL = base + 2;
      const ndataL = base + 3;
      locals.push(
        { name: `__vsl_vec_${vecTypeIdx}`, type: { kind: "ref_null", typeIdx: vecTypeIdx } },
        { name: `__vsl_data_${vecTypeIdx}`, type: { kind: "ref_null", typeIdx: arrTypeIdx } },
        { name: `__vsl_len_${vecTypeIdx}`, type: { kind: "i32" } },
        { name: `__vsl_ndata_${vecTypeIdx}`, type: { kind: "ref_null", typeIdx: arrTypeIdx } },
      );
      const thenBranch: Instr[] = [
        { op: "local.get", index: 2 },
        { op: "ref.cast", typeIdx: vecTypeIdx },
        { op: "local.set", index: vecL },
        // old len
        { op: "local.get", index: vecL },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
        { op: "local.set", index: lenL },
        // grow data when cap < newLen (allocation bound is enforced host-side)
        { op: "local.get", index: vecL },
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
        { op: "local.tee", index: dataL },
        { op: "array.len" },
        { op: "local.get", index: 1 },
        { op: "i32.lt_s" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 1 },
            { op: "array.new_default", typeIdx: arrTypeIdx },
            { op: "local.set", index: ndataL },
            { op: "local.get", index: ndataL },
            { op: "i32.const", value: 0 },
            { op: "local.get", index: dataL },
            { op: "i32.const", value: 0 },
            { op: "local.get", index: lenL },
            { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx },
            { op: "local.get", index: vecL },
            { op: "local.get", index: ndataL },
            { op: "ref.as_non_null" },
            { op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 1 },
          ],
        },
        // (#6482 r4) Maintain the ABSENCE marker across a length change, for
        // the f64 carrier that can hold one.
        //
        // §10.4.2.1 ArraySetLength: shrinking DELETES the dropped elements and
        // growing creates HOLES — neither leaves a value behind. The backing
        // store did not agree: a shrink left the old element in its slot and a
        // grow `array.new_default`-ed to 0.0, so after `[0,1]; length = 1;
        // length = 10` the host read slot 1 back as the original `1`, and after
        // `[0, , 2]; length = 5` it read slots 3-4 as `0`. Both then answered
        // `hasOwnProperty` TRUE for an index that is not an own property
        // (15.2.3.7-6-a-161/162, 15.2.3.6-4-159).
        //
        // The fill is SHRINK-ONLY — see `holeFillArm`: this export is also the
        // host-mirror replay path, where an append arrives as `set_elem(i)` then
        // `set_len(i + 1)`, so filling a grown tail would erase the element just
        // written. A grow needs no fill: the shrink that orphaned those slots
        // marked them on its way down. `__vec_get` already maps the marker to
        // `undefined`, so reads are unchanged; only own-ness stops lying.
        ...(holeFillArm(vecTypeIdx, arrTypeIdx, vecL, dataL, lenL) ?? []),
        // vec.length = newLen
        { op: "local.get", index: vecL },
        { op: "local.get", index: 1 },
        { op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 },
        { op: "i32.const", value: 1 },
        { op: "return" },
      ];
      current = [
        { op: "local.get", index: 2 },
        { op: "ref.test", typeIdx: vecTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: thenBranch,
          else: current,
        },
      ];
    }
    // See __vec_set_elem above: all arms return and this marks the impossible
    // fallthrough explicitly for the stack-balance verifier.
    body.push(...current, { op: "unreachable" });
    defineWritebackHelper(ctx, "setLen", "__vec_set_len", setLenTypeIdx, locals, body);
  }
}
