// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7380 — the proving-program corpus (tests/fixtures/prepared-proving-programs.json: the distinct programs the
// issue-7354-*, test262-prepared-* and issue-7188 tests hand to the strict Prepared entry) and the one outcome line
// per program that scripts/prepared-byte-identity.mts prints and tests/issue-7380-* compare.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { compile, compileMulti, type Test262CompileOptions } from "../../src/test262/test262-prepared-entry.js";

interface ProvingProgram {
  compile: "compile" | "compileMulti";
  entryFile: string;
  files: Record<string, string>;
  options: Record<string, unknown>;
}

export const provingPrograms: readonly ProvingProgram[] = JSON.parse(
  readFileSync(new URL("../fixtures/prepared-proving-programs.json", import.meta.url), "utf8"),
);

const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

export function provingProgramKey(program: ProvingProgram): string {
  return sha256(JSON.stringify(program)).slice(0, 12);
}

/** `bytes <sha256>` with the binary, `refused <messages>`, or `threw <message>` for an exception out of compile(). */
export async function provingOutcome(program: ProvingProgram): Promise<{ outcome: string; binary?: Uint8Array }> {
  const options = {
    ...program.options,
    wholeProgram: { kind: "prepared-program-required", version: 1 },
  } as Test262CompileOptions;
  try {
    const result =
      program.compile === "compile"
        ? await compile(program.files[program.entryFile]!, options)
        : await compileMulti(program.files, program.entryFile, options);
    if (result.success) return { outcome: `bytes ${sha256(result.binary)}`, binary: result.binary };
    return { outcome: `refused ${result.errors.map((error) => error.message).join(" | ")}`.replace(/\s+/g, " ") };
  } catch (error) {
    return { outcome: `threw ${error instanceof Error ? error.message : String(error)}`.replace(/\s+/g, " ") };
  }
}
