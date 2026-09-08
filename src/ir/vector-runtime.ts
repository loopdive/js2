/** Compatibility bindings; the complete vector identity implementation lives in core. */
export {
  IR_VEC_ELEM_SET_PREFIX,
  IR_VEC_NEW_SIZED_PREFIX,
  IR_HOLEY_ARRAY_NEW,
  IR_HOLEY_ARRAY_ELEM_SET,
  irVectorRuntimeElementKind,
  irVecElemSetSymbol,
  irVecNewSizedSymbol,
  parseIrVectorRuntimeElement,
} from "./core/vector-runtime.js";
export type { IrVectorRuntimeElementKind } from "./core/vector-runtime.js";
