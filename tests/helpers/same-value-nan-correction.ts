// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";

export const sameValueNaNPath = "src/runtime/wasmgc/values/object-same-value-body.ts";
const beforeHash = "ab29f1bc725f56fc8e33c66818ee103fc316faa0c11077a9b5a20e08fde00ebb";
const afterHash = "32b7cba6e06b3a56112c2662133ee29affc4cc39a68090639bebb5401bac88c2";
const correction =
  '        // Every NaN payload/sign denotes the same Number value for SameValue.\n        ...[0, 1].flatMap((index): Instr[] => [\n          { op: "local.get", index },\n          { op: "call", funcIdx: unboxNumIdx },\n          { op: "local.get", index },\n          { op: "call", funcIdx: unboxNumIdx },\n          { op: "f64.ne" },\n        ]),\n        { op: "i32.and" },\n        { op: "i32.or" },\n';
const anchor = '        { op: "i64.eq" },\n      ],\n      else: elseArm,\n    },\n  ];\n  const nullArm';
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
/** Exact semantic successor; historical receipts remain immutable. */
export function applySameValueNaNCorrection(source: string, inverse: boolean): string {
  if (hash(source) !== (inverse ? afterHash : beforeHash)) throw Error("SameValue NaN source mismatch");
  const from = inverse ? anchor.replace("      ],", correction + "      ],") : anchor;
  const to = inverse ? anchor : anchor.replace("      ],", correction + "      ],");
  if (source.split(from).length !== 2) throw Error("SameValue NaN span mismatch");
  const result = source.replace(from, () => to);
  if (hash(result) !== (inverse ? beforeHash : afterHash)) throw Error("SameValue NaN retained source mismatch");
  return result;
}
export function beforeSameValueNaNCorrection(path: string, source: string): string {
  if (path !== sameValueNaNPath || hash(source) === beforeHash) return source;
  const before = applySameValueNaNCorrection(source, true);
  if (applySameValueNaNCorrection(before, false) !== source) throw Error("SameValue NaN replay mismatch");
  return before;
}
