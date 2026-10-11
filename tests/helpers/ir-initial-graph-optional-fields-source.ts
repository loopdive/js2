// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import {
  assertProgramInitialGraphPin,
  ProgramInitialGraphEvolutionError,
  type ProgramInitialGraphReader,
} from "./ir-program-initial-graph-evolution.js";

const path = "src/wasm/model/module-records.ts";
const current = {
  bytes: 4111,
  sha256: "7a16486fdc674335c690ed51c4e2767486732275b3acad00af5429a7d3ebf4cc",
  gitBlob: "8ff4cab7afb94aea25b5b5a79a07fe89d0538d12",
};
const prior = {
  bytes: 3867,
  sha256: "0de6972cbc506dc29a04119fed1efbf9a4b84e4219a52363c120e0130364ae75",
  gitBlob: "c700df20e0e24aa54b0dd5d4a438773c22deb6f7",
};
const offset = 2806;
const insertion =
  "  /**\n   * (#6867) The source property is declared optional (`k?: T`). A typed-ref\n   * coercion from a shape that lacks this field may complete it with\n   * `undefined` instead of failing its guarded downcast to null.\n   */\n  optional?: true;\n";

/** One fresh historical dependency view; never a compiler reader or historical-input normalizer. */
export function beforeOptionalFieldModuleRecords(reader: (path: string) => string): (path: string) => string;
export function beforeOptionalFieldModuleRecords(reader: ProgramInitialGraphReader): ProgramInitialGraphReader;
export function beforeOptionalFieldModuleRecords(reader: ProgramInitialGraphReader): ProgramInitialGraphReader {
  if (typeof reader !== "function")
    throw new ProgramInitialGraphEvolutionError("missing-source", "supplied reader required");
  return (requested) => {
    const source = reader(requested);
    if (requested !== path) return source;
    if (typeof source !== "string" || !source.length)
      throw new ProgramInitialGraphEvolutionError("pin", "primitive current module-records source required");
    const bytes = Buffer.from(source, "utf8");
    assertProgramInitialGraphPin(bytes, current, `current ${path}`);
    const span = Buffer.from(insertion, "utf8");
    if (span.length !== 244 || !bytes.subarray(offset, offset + span.length).equals(span))
      throw new ProgramInitialGraphEvolutionError("span", `fixed optional field ${path}`);
    const previous = Buffer.concat([bytes.subarray(0, offset), bytes.subarray(offset + span.length)]);
    assertProgramInitialGraphPin(previous, prior, `prior ${path}`);
    const replay = Buffer.concat([previous.subarray(0, offset), span, previous.subarray(offset)]);
    if (!replay.equals(bytes)) throw new ProgramInitialGraphEvolutionError("reciprocal", `complete current ${path}`);
    return previous.toString("utf8");
  };
}
