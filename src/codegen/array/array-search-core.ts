// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6912) The AST-free core of `Array.prototype.{indexOf,lastIndexOf,includes}`
 * over an externref array-LIKE receiver, shared by the two lowerings that
 * reach it:
 *
 *   - the direct borrow `Array.prototype.indexOf.call(obj, x, from)`
 *     (`compileArrayLikePrototypeSearch`, array-prototype-borrow.ts), which
 *     compiles its operands from the AST and then hands the locals here, and
 *   - the member as a callable VALUE (`var f = Array.prototype.indexOf;
 *     obj.indexOf = f`), whose native-proto closure unpacks its operands from
 *     the packed variadic argument vector (array-search-proto-value.ts).
 *
 * Both run the same fromIndex clamp and the same HasProperty-gated scan, so
 * the two spellings cannot drift. The instruction sequences are the ones the
 * direct borrow emitted before the extraction (byte-identical there).
 */
import type { Instr } from "../../ir/types.js";

/** Default start when fromIndex is absent: 0 forward, len-1 for lastIndexOf. */
export function arraySearchDefaultStartInstrs(isLast: boolean, iTmp: number, lenTmp: number): Instr[] {
  const start: Instr[] = isLast
    ? [{ op: "local.get", index: lenTmp }, { op: "f64.const", value: 1 }, { op: "f64.sub" }]
    : [{ op: "f64.const", value: 0 }];
  return [...start, { op: "local.set", index: iTmp }];
}

/**
 * ToIntegerOrInfinity + the §23.1.3.{16,17,20} start clamp of the f64
 * fromIndex on the stack, leaving the start index in `iTmp`.
 *
 * Forward (indexOf/includes): negative n → max(len + n, 0); n >= len exits the
 * loop. Backward (lastIndexOf): negative n → len + n (may stay < 0 → -1);
 * otherwise min(n, len - 1). NaN → 0; ±Infinity are kept (f64.trunc).
 */
export function arraySearchFromIndexClampInstrs(isLast: boolean, iTmp: number, lenTmp: number): Instr[] {
  const out: Instr[] = [
    // NaN → 0 per ToIntegerOrInfinity. f64.ne(x, x) detects NaN.
    { op: "local.tee", index: iTmp },
    { op: "local.get", index: iTmp },
    { op: "f64.ne" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "f64.const", value: 0 },
        { op: "local.set", index: iTmp },
      ],
    },
    { op: "local.get", index: iTmp },
    { op: "f64.trunc" },
    { op: "local.set", index: iTmp },
  ];
  if (isLast) {
    out.push(
      { op: "local.get", index: iTmp },
      { op: "f64.const", value: 0 },
      { op: "f64.lt" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: lenTmp },
          { op: "local.get", index: iTmp },
          { op: "f64.add" },
          { op: "local.set", index: iTmp },
        ],
        else: [
          // n >= 0: k = min(n, len - 1)
          { op: "local.get", index: iTmp },
          { op: "local.get", index: lenTmp },
          { op: "f64.const", value: 1 },
          { op: "f64.sub" },
          { op: "f64.gt" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: lenTmp },
              { op: "f64.const", value: 1 },
              { op: "f64.sub" },
              { op: "local.set", index: iTmp },
            ],
          },
        ],
      },
    );
  } else {
    out.push(
      { op: "local.get", index: iTmp },
      { op: "f64.const", value: 0 },
      { op: "f64.lt" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: lenTmp },
          { op: "local.get", index: iTmp },
          { op: "f64.add" },
          { op: "local.tee", index: iTmp },
          { op: "f64.const", value: 0 },
          { op: "f64.lt" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "f64.const", value: 0 },
              { op: "local.set", index: iTmp },
            ],
          },
        ],
      },
    );
  }
  return out;
}

export interface ArraySearchLoop {
  readonly isLast: boolean;
  readonly isIncludes: boolean;
  readonly receiverTmp: number;
  readonly lenTmp: number;
  readonly searchTmp: number;
  /** f64 loop index, already holding the clamped start. */
  readonly iTmp: number;
  /** i32 (includes) / f64 (indexOf, lastIndexOf) result, already defaulted. */
  readonly resTmp: number;
  /** funcIdx resolved AFTER every late-import-adding operand compile. */
  readonly getIdx: number;
  readonly hasIdx: number;
  readonly cmp: number;
}

/**
 * The scan: forward (i++) or backward (i--) over f64 indices. indexOf /
 * lastIndexOf gate each index on HasProperty (holes are skipped, §23.1.3.17
 * step 9.a); includes uses Get on every index. On a match the result local is
 * written and the outer block exits. Ends with the result local on the stack
 * (i32 for includes, f64 otherwise).
 */
export function arraySearchLoopInstrs(s: ArraySearchLoop): Instr[] {
  const loopExit: Instr[] = s.isLast
    ? [{ op: "local.get", index: s.iTmp }, { op: "f64.const", value: 0 }, { op: "f64.lt" }, { op: "br_if", depth: 1 }]
    : [
        { op: "local.get", index: s.iTmp },
        { op: "local.get", index: s.lenTmp },
        { op: "f64.ge" },
        { op: "br_if", depth: 1 },
      ];
  const hasIdxCheck: Instr[] = [
    { op: "local.get", index: s.receiverTmp },
    { op: "local.get", index: s.iTmp },
    { op: "call", funcIdx: s.hasIdx },
  ];
  const compareInstrs: Instr[] = [
    { op: "local.get", index: s.receiverTmp },
    { op: "local.get", index: s.iTmp },
    { op: "call", funcIdx: s.getIdx },
    { op: "local.get", index: s.searchTmp },
    { op: "call", funcIdx: s.cmp },
  ];
  // Escape depth from inside the gated `if` body: if (1) → loop (2) → block.
  const onMatchInstrs = (depth: number): Instr[] =>
    s.isIncludes
      ? [
          { op: "i32.const", value: 1 },
          { op: "local.set", index: s.resTmp },
          { op: "br", depth },
        ]
      : [
          { op: "local.get", index: s.iTmp },
          { op: "local.set", index: s.resTmp },
          { op: "br", depth },
        ];
  const stepInstr: Instr[] = [
    { op: "local.get", index: s.iTmp },
    { op: "f64.const", value: 1 },
    s.isLast ? { op: "f64.sub" } : { op: "f64.add" },
    { op: "local.set", index: s.iTmp },
    { op: "br", depth: 0 },
  ];
  const iterationCore: Instr[] = s.isIncludes
    ? [...compareInstrs, { op: "if", blockType: { kind: "empty" }, then: onMatchInstrs(2) }]
    : [
        ...hasIdxCheck,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...compareInstrs, { op: "if", blockType: { kind: "empty" }, then: onMatchInstrs(3) }],
        },
      ];
  return [
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [{ op: "loop", blockType: { kind: "empty" }, body: [...loopExit, ...iterationCore, ...stepInstr] }],
    },
    { op: "local.get", index: s.resTmp },
  ];
}
