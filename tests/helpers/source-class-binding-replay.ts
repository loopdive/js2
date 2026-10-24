// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { prepareSourceClassBindings } from "./prepared-source-class-bindings.js";
import { replayOptions, replayProgram } from "./ir-whole-program-replay.js";
import { inspectPreparedErrorCopy, readInspectedErrorString } from "./prepared-error-inspector.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../../src/ir/program-codec.js";
import { prepareWholeIrProgram } from "../../src/ir/program-preparation.js";

// Native emission is synchronous; this child leaves Vitest's status channel responsive.
const immutable = process.argv[2] === "true",
  decoded = process.argv[3] === "true";
const fixture = prepareSourceClassBindings(immutable);
const encoded = encodePreparedIrProgram(fixture.program);
const program = decoded ? decodePreparedIrProgram(encoded) : fixture.program;
const result = await replayProgram(program, replayOptions("wasmgc", "standalone"));
if (result.kind !== "ran") throw Error(JSON.stringify(result.failure));
const run = result.run.exports.run as Function;
const values = [run(0), run(1), run(2), run(3), run(4), run(5), run(6)];
const reference = await inspectPreparedErrorCopy(result.run.emitted.module, "ReferenceError");
const referenceResult = {
  value: (reference.run as Function)(3),
  tag: (reference.errorTag as Function)(),
  messageAbsent: (reference.messageAbsent as Function)(),
};
let typeResult;
if (immutable) {
  const type = await inspectPreparedErrorCopy(result.run.emitted.module, "TypeError");
  typeResult = {
    value: (type.run as Function)(2),
    tag: (type.errorTag as Function)(),
    message: readInspectedErrorString(type, "message"),
  };
}
const sourceAdmission = prepareWholeIrProgram(fixture.source);
process.stdout.write(
  JSON.stringify({
    inventoryPreserved: JSON.stringify(fixture.program.inventory) === fixture.originalInventory,
    codecStable: encodePreparedIrProgram(program) === encoded,
    imports: result.run.emitted.module.imports,
    values,
    reference: referenceResult,
    ...(typeResult ? { type: typeResult } : {}),
    sourceAdmission: {
      kind: sourceAdmission.kind,
      code: sourceAdmission.kind === "unsupported" ? sourceAdmission.code : undefined,
    },
  }),
);
