// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
export const fnctorGuardReceiptText = readFileSync(
  new URL("../fixtures/issue-3518-object-runtime-fnctor-guard-forward.json", import.meta.url),
  "utf8",
);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
export function authenticateFnctorGuardReceipt(text = fnctorGuardReceiptText): { before: string; after: string } {
  if (sha(text) !== "b9c87ca1143d86401d5bfaed02fd7a4fb5c7b2495cd002ea4e34eb348cae873a")
    throw new Error("fnctor guard receipt digest mismatch");
  const record = JSON.parse(text) as {
    schema: number;
    kind: string;
    path: string;
    before: string;
    after: string;
    beforeSha256: string;
    afterSha256: string;
  };
  if (
    record.schema !== 1 ||
    record.kind !== "fnctor-prototype-guard-forward" ||
    record.path !== "src/codegen/object-runtime.ts" ||
    !record.before ||
    !record.after ||
    record.before === record.after ||
    sha(record.before) !== record.beforeSha256 ||
    sha(record.after) !== record.afterSha256
  )
    throw new Error("fnctor guard provenance mismatch");
  return record;
}
/** One exact committed change, outside the immutable 35e main-composition API. */
export function applyFnctorGuardForward(source: string, inverse: boolean): string {
  const record = authenticateFnctorGuardReceipt();
  const from = inverse ? record.after : record.before;
  const start = source.indexOf(from);
  if (start < 0 || source.indexOf(from, start + 1) !== -1) throw new Error("fnctor guard span missing or duplicated");
  return source.slice(0, start) + (inverse ? record.before : record.after) + source.slice(start + from.length);
}
