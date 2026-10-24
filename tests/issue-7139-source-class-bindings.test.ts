// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

function replay(immutable: boolean, decoded: boolean): Promise<unknown> {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [
      "--import",
      "tsx",
      resolve("tests/helpers/source-class-binding-replay.ts"),
      String(immutable),
      String(decoded),
    ]);
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(Error(`native binding replay exited ${code}: ${stderr}\n${stdout}`));
      else {
        try {
          accept(JSON.parse(stdout));
        } catch (error) {
          reject(error);
        }
      }
    });
  });
}

for (const immutable of [false, true])
  for (const decoded of [false, true])
    it(`executes original class binding reads/writes with retained TDZ cells, immutable=${immutable}, decoded=${decoded}`, async () => {
      expect(await replay(immutable, decoded)).toEqual({
        inventoryPreserved: true,
        codecStable: true,
        imports: [],
        values: [11, 200, immutable ? 223 : 101, 1013, immutable ? 223 : 1003, immutable ? 223 : 1001, 200],
        reference: { value: 1013, tag: -16, messageAbsent: 1 },
        ...(immutable ? { type: { value: 223, tag: -11, message: "Assignment to constant variable." } } : {}),
        sourceAdmission: { kind: "unsupported", code: "class-definition-execution-unsupported" },
      });
    }, 180000);
