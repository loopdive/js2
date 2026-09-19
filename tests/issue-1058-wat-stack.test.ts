// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { emitWat } from "../src/emit/wat.js";
import { createEmptyModule, type Instr } from "../src/ir/types.js";

function wat(body: Instr[]): string {
  const mod = createEmptyModule();
  mod.types.push({ kind: "func", params: [], results: [] });
  mod.functions.push({ name: "probe", typeIdx: 0, locals: [], body, exported: false });
  return emitWat(mod);
}

it("prints deeply nested WAT without recursive stack growth", () => {
  let body: Instr[] = [{ op: "nop" }];
  for (let i = 0; i < 3000; i++) body = [{ op: "block", blockType: { kind: "empty" }, body }];
  const text = wat(body);
  expect(text.match(/\(block/g)).toHaveLength(3000);
  expect(text.match(/nop/g)).toHaveLength(1);
  expect(text.length).toBeLessThan(1_000_000);
  expect(text.split("\n").every((line) => (line.match(/^ */)?.[0].length ?? 0) <= 128)).toBe(true);
  expect(text.endsWith("\n  )\n)")).toBe(true);
});

it("keeps shared arms as separate WAT occurrences and preserves empty arm formatting", () => {
  const shared: Instr[] = [{ op: "nop" }];
  const text = wat([
    { op: "if", blockType: { kind: "empty" }, then: shared, else: shared },
    { op: "block", blockType: { kind: "empty" }, body: [] },
    { op: "loop", blockType: { kind: "empty" }, body: [] },
    { op: "if", blockType: { kind: "val", type: { kind: "i32" } }, then: [] },
    { op: "try", blockType: { kind: "empty" }, body: [], catches: [{ tagIdx: 0, body: shared }], catchAll: [] },
    { op: "try_table", blockType: { kind: "empty" }, body: [], catches: [{ kind: "catch_all", depth: 0 }] },
  ]);
  expect(text.match(/nop/g)).toHaveLength(3);
  expect(text).toContain("    (block\n\n    )\n    (loop\n\n    )");
  expect(text).toContain(
    "    (if (result i32)\n      (then\n\n      )\n      (else\n        unreachable\n      )\n    )",
  );
  expect(text).toContain(
    "    (try\n      (do\n\n      )\n      (catch 0\n        nop\n      )\n      (catch_all\n\n      )\n    )",
  );
  expect(text).toContain("    (try_table (catch_all 0))");
});
