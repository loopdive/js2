// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { classAllocationInput, prepareClassAllocationProgram } from "./helpers/prepared-class-values.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { requireProgram } from "./helpers/typed-program-fixtures.js";
import { acceptPreparedIrProgram } from "../src/ir/program-consumer.js";
import { replayOptions } from "./helpers/ir-whole-program-replay.js";
import { prepareNativeSourceClosureInput } from "../src/ir/program-native-invocation.js";
import { assertNativeSourceClosureRequirementsCurrent } from "../src/ir/program/native-source-closure-requirements.js";
import { irIntrinsicFuncRef } from "../src/ir/core/callable-bindings.js";

type Fixture = ReturnType<typeof classAllocationInput>;
const changes: readonly [string, (fixture: Fixture) => Fixture["allocation"], RegExp][] = [
  ["capturing Call body", (f) => ({ ...f.allocation, callTarget: f.construct.liftedFunc }), /capture mismatch/],
  [
    "changed Call signature",
    (f) => ({ ...f.allocation, signature: { ...f.allocation.signature, params: [] } }),
    /exact callable signature/,
  ],
  [
    "forged allocator",
    (f) => ({ ...f.allocation, allocator: irIntrinsicFuncRef("class.value.fake") }),
    /undeclared callable/,
  ],
  [
    "borrowed allocation ID",
    (f) => ({ ...f.allocation, alloc: f.construct.alloc }),
    /allocations: site .* contradicts/,
  ],
  [
    "external Construct value",
    (f) => ({ ...f.allocation, construct: f.allocation.parent }),
    /internal Construct closure/,
  ],
];
for (const [name, change, message] of changes)
  it(`rejects ${name} before physical emission`, () => {
    const f = classAllocationInput(),
      changed = change(f);
    const input = {
      ...f.input,
      ir: {
        ...f.input.ir,
        functions: f.input.ir.functions.map((fn) =>
          fn !== f.make
            ? fn
            : {
                ...fn,
                blocks: fn.blocks.map((block) => ({
                  ...block,
                  instrs: block.instrs.map((row) => (row === f.allocation ? changed : row)),
                })),
              },
        ),
      },
    };
    expect(() => {
      const prepared = requireProgram(prepareTypedIrProgram(input, f.options));
      const accepted = acceptPreparedIrProgram(prepared, replayOptions("wasmgc", "standalone"));
      if (accepted.kind !== "accepted") throw Error(accepted.detail);
    }).toThrow(message);
  });
it("rejects a copied class/source census while admitting the exact issued census", () => {
  const program = prepareClassAllocationProgram();
  const source = prepareNativeSourceClosureInput(program, program.runtime[0]!)!;
  expect(source.classValues?.length).toBeGreaterThan(0);
  expect(() => assertNativeSourceClosureRequirementsCurrent(source)).not.toThrow();
  expect(() => assertNativeSourceClosureRequirementsCurrent({ ...source })).toThrow(/unissued or detached/);
});
