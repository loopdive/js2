// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../../../wasm/model/instructions.js";
export type PrototypeSingletonRequest = { readonly kind: "parent" | "member-csv" | "name" | "seed-companion" };
export type PrototypeSingletonResponse =
  | { readonly kind: "parent"; readonly instructions: readonly Instr[] | null }
  | { readonly kind: "member-csv" | "name"; readonly instructions: readonly Instr[] }
  | {
      readonly kind: "seed-companion";
      readonly companion: { readonly functionIndex: number; readonly brandOffset: number } | undefined;
    };
/** Construction data only. Native owners must authenticate parent/literal resources separately.
 * Operand objects deliberately retain identity: legacy deferred imports patch them later.
 */
export function* buildPrototypeSingletonRead(
  brand: number,
  structTypeIdx: number,
  globalIdx: number,
): Generator<PrototypeSingletonRequest, Instr[], PrototypeSingletonResponse> {
  const initBody: Instr[] = [
    { op: "i32.const", value: brand },
    { op: "i32.const", value: 0 },
    { op: "ref.null.extern" },
  ];
  const parent = yield { kind: "parent" };
  if (parent.kind !== "parent") throw Error("prototype singleton expected parent");
  if (parent.instructions) initBody.push(...parent.instructions);
  else initBody.push({ op: "ref.null.extern" });
  const csv = yield { kind: "member-csv" };
  if (csv.kind !== "member-csv") throw Error("prototype singleton expected member CSV");
  initBody.push(...csv.instructions);
  const name = yield { kind: "name" };
  if (name.kind !== "name") throw Error("prototype singleton expected name");
  initBody.push(...name.instructions);
  initBody.push(
    { op: "struct.new", typeIdx: structTypeIdx },
    { op: "extern.convert_any" },
    { op: "global.set", index: globalIdx },
  );
  // Publish singleton before its real seeder can reenter through the companion.
  const seed = yield { kind: "seed-companion" };
  if (seed.kind !== "seed-companion") throw Error("prototype singleton expected companion");
  if (seed.companion)
    initBody.push(
      { op: "i32.const", value: seed.companion.brandOffset },
      { op: "i32.const", value: 1 },
      { op: "call", funcIdx: seed.companion.functionIndex },
      { op: "drop" },
    );
  return [
    { op: "global.get", index: globalIdx },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: initBody, else: [] },
    { op: "global.get", index: globalIdx },
  ];
}
