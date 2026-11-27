// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The property-descriptor word every `js.object.define-*` contract and the realm's descriptor bodies share, as an
 * exact integer f64: the W/E/C values in bits 0..2, their presence in 3..5, a value's presence in 7, a getter's and a
 * setter's presence in 8 and 9. The one table both the IR (which writes words) and the runtime (which reads them) take.
 */
export const DESCRIPTOR_WORD = Object.freeze({
  writable: 1,
  enumerable: 2,
  configurable: 4,
  writableSpecified: 8,
  enumerableSpecified: 16,
  configurableSpecified: 32,
  hasValue: 128,
  getterSpecified: 256,
  setterSpecified: 512,
});

/**
 * A data descriptor with every field present and true: CreateDataProperty's word (§7.3.5), and the bits a data
 * define may carry at all.
 */
export const FULL_DATA_DESCRIPTOR =
  DESCRIPTOR_WORD.writable |
  DESCRIPTOR_WORD.enumerable |
  DESCRIPTOR_WORD.configurable |
  DESCRIPTOR_WORD.writableSpecified |
  DESCRIPTOR_WORD.enumerableSpecified |
  DESCRIPTOR_WORD.configurableSpecified |
  DESCRIPTOR_WORD.hasValue;
