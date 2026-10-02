// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6759 — the post-codegen repair passes got cheaper by caching, fusing and
// skipping work that provably cannot change their result. Every shortcut rests
// on an invariant; each test here pins one of them, so a later edit that breaks
// the invariant fails here instead of silently changing emitted bytes.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import {
  crossFunctionInstrArrays,
  instrArraySharing,
  locateCallArgProducers,
  visitedFor,
} from "../src/codegen/call-arg-producers.js";
import { fixupExternConvertAny } from "../src/codegen/fixups.js";
import { stackBalance } from "../src/codegen/stack-balance.js";
import type { CodegenError } from "../src/codegen/context/types.js";
import type { Instr, WasmModule } from "../src/ir/types.js";
import { walkInstructions } from "../src/wasm/model/instruction-walk.js";

function moduleWith(types: unknown[], functions: unknown[]): WasmModule {
  return {
    types,
    imports: [],
    functions,
    globals: [],
    tags: [],
    elements: [],
    exports: [],
    funcOrdinalToPosition: [],
  } as unknown as WasmModule;
}

const VOID: unknown = { kind: "func", params: [], results: [] };
const I32: unknown = { kind: "i32" };

describe("#6759 opcode-effect caches never cache an operand-dependent effect", () => {
  it("stack-balance: two calls with different arities each get their own delta", () => {
    // Type 1: (i32, i32) -> ()   Type 2: (i32) -> i32
    const types = [
      VOID,
      { kind: "func", params: [I32, I32], results: [] },
      { kind: "func", params: [I32], results: [I32] },
    ];
    const balanced: Instr[] = [
      { op: "i32.const", value: 1 },
      { op: "i32.const", value: 2 },
      { op: "call", funcIdx: 2 },
    ];
    const leftover: Instr[] = [
      { op: "i32.const", value: 1 },
      { op: "call", funcIdx: 3 },
    ];
    const mod = moduleWith(types, [
      { name: "balanced", typeIdx: 0, locals: [], body: balanced },
      { name: "leftover", typeIdx: 0, locals: [], body: leftover },
      { name: "two", typeIdx: 1, locals: [], body: [] },
      { name: "one", typeIdx: 2, locals: [], body: [{ op: "local.get", index: 0 }] },
    ]);
    stackBalance(mod, []);
    // `call $two` consumes both values; `call $one` leaves one behind, which
    // the void function body must drop. A delta cached per opcode would give
    // both calls the same effect and get one of these wrong.
    expect(balanced.map((i) => i.op)).toEqual(["i32.const", "i32.const", "call"]);
    expect(leftover.map((i) => i.op)).toEqual(["i32.const", "call", "drop"]);
  });

  it("forward stack model: struct.new pops per its own type, calls per their own signature", () => {
    const types = [
      { kind: "struct", fields: [{ type: I32 }] },
      { kind: "struct", fields: [{ type: I32 }, { type: I32 }, { type: I32 }] },
      {
        kind: "func",
        params: [
          { kind: "ref", typeIdx: 0 },
          { kind: "ref", typeIdx: 1 },
        ],
        results: [],
      },
    ];
    const mod = moduleWith(types, [{ name: "sink", typeIdx: 2, locals: [], body: [] }]);
    const instrs: Instr[] = [
      { op: "i32.const", value: 1 },
      { op: "struct.new", typeIdx: 0 },
      { op: "i32.const", value: 2 },
      { op: "i32.const", value: 3 },
      { op: "i32.const", value: 4 },
      { op: "struct.new", typeIdx: 1 },
      { op: "call", funcIdx: 0 },
    ];
    expect(locateCallArgProducers(instrs, mod).get(6)).toEqual([1, 5]);
    // The same opcodes again, in the other order, in the same process.
    const swapped: Instr[] = [
      { op: "i32.const", value: 2 },
      { op: "i32.const", value: 3 },
      { op: "i32.const", value: 4 },
      { op: "struct.new", typeIdx: 1 },
      { op: "i32.const", value: 1 },
      { op: "struct.new", typeIdx: 0 },
      { op: "call", funcIdx: 0 },
    ];
    expect(locateCallArgProducers(swapped, mod).get(6)).toEqual([3, 5]);
  });

  it("the call-only producer view stops exactly where the full model stops", () => {
    const types = [VOID, { kind: "func", params: [I32], results: [] }];
    const mod = moduleWith(types, [{ name: "f", typeIdx: 1, locals: [], body: [] }]);
    const instrs: Instr[] = [
      { op: "i32.const", value: 1 },
      { op: "local.set", index: 0 }, // a non-call consumer: walked, not reported
      { op: "i32.const", value: 2 },
      { op: "call", funcIdx: 0 },
      { op: "br", depth: 0 }, // unmodelled: the walk stops here
      { op: "i32.const", value: 3 },
      { op: "call", funcIdx: 0 },
    ];
    const producers = locateCallArgProducers(instrs, mod);
    expect([...producers.entries()]).toEqual([[3, [2]]]);
  });
});

describe("#6759 shared-array table", () => {
  it("reports exactly the arrays reached from two different functions", () => {
    const leaf: Instr[] = [{ op: "nop" }];
    const shared: Instr[] = [{ op: "block", blockType: { kind: "empty" }, body: leaf }];
    const onlyA: Instr[] = [{ op: "nop" }];
    const mod = moduleWith(
      [VOID],
      [
        {
          name: "a",
          typeIdx: 0,
          locals: [],
          // `onlyA` is reached twice, but from ONE function: not shared.
          body: [
            { op: "block", blockType: { kind: "empty" }, body: shared },
            { op: "block", blockType: { kind: "empty" }, body: onlyA },
            { op: "loop", blockType: { kind: "empty" }, body: onlyA },
          ],
        },
        { name: "b", typeIdx: 0, locals: [], body: [{ op: "if", blockType: { kind: "empty" }, then: shared }] },
      ],
    );
    const result = crossFunctionInstrArrays(mod);
    expect(result.has(shared)).toBe(true);
    expect(result.has(leaf)).toBe(true); // reached from both, through `shared`
    expect(result.has(onlyA)).toBe(false);
    expect(result.has(mod.functions[0]!.body)).toBe(false);
  });
});

describe("#6759 only multi-parent arrays need visited bookkeeping", () => {
  const block = (body: Instr[]): Instr => ({ op: "block", blockType: { kind: "empty" }, body });

  it("lists exactly the arrays reached more than once, within or across functions", () => {
    const once: Instr[] = [{ op: "nop" }];
    const twice: Instr[] = [{ op: "nop" }];
    const across: Instr[] = [{ op: "nop" }];
    const mod = moduleWith(
      [VOID],
      [
        { name: "f", typeIdx: 0, locals: [], body: [block(once), block(twice), block(twice), block(across)] },
        { name: "g", typeIdx: 0, locals: [], body: [block(across)] },
      ],
    );
    const sharing = instrArraySharing(mod);
    expect([...sharing.multiParent]).toEqual(expect.arrayContaining([twice, across]));
    expect(sharing.multiParent.size).toBe(2);
    expect([...sharing.shared]).toEqual([across]);
  });

  it("hands out visited-sets that remember multi-parent arrays only", () => {
    const single: Instr[] = [];
    const multi: Instr[] = [];
    const none = visitedFor({ shared: new Set(), multiParent: new Set() });
    none.add(single);
    expect(none.has(single)).toBe(false);
    const some = visitedFor({ shared: new Set(), multiParent: new Set([multi]) });
    some.add(single);
    some.add(multi);
    expect(some.has(single)).toBe(false); // reached once: never asked again
    expect(some.has(multi)).toBe(true);
  });

  it("stack-balance repairs a module exactly as it does without the sharing analysis", () => {
    const build = (): WasmModule => {
      const twice: Instr[] = [{ op: "i32.const", value: 7 }];
      return moduleWith(
        [VOID, { kind: "func", params: [], results: [I32] }],
        [
          {
            name: "f",
            typeIdx: 0,
            locals: [],
            body: [
              block([{ op: "i32.const", value: 1 }]),
              block(twice),
              block(twice),
              { op: "i32.const", value: 0 },
              {
                op: "if",
                blockType: { kind: "val", type: I32 },
                then: [
                  { op: "i32.const", value: 2 },
                  { op: "i32.const", value: 3 },
                ],
              },
              { op: "drop" },
            ],
          },
          { name: "g", typeIdx: 1, locals: [], body: [{ op: "unreachable" }, { op: "i32.const", value: 4 }] },
        ],
      );
    };
    const unaided = build();
    const aided = build();
    const sharing = instrArraySharing(aided);
    expect(sharing.multiParent.size).toBe(1);
    const a = stackBalance(unaided, []);
    const b = stackBalance(aided, [], sharing);
    expect(b).toBe(a);
    expect(JSON.stringify(aided.functions.map((f) => f.body))).toBe(
      JSON.stringify(unaided.functions.map((f) => f.body)),
    );
    expect(a).toBeGreaterThan(0); // the fixture really exercises the repairs
  });
});

describe("#6759 stack-balance preflight: lazily compared block contexts", () => {
  function sameArrayTwice(first: unknown, second: unknown): { errors: string; leaf: Instr[] } {
    const leaf: Instr[] = [{ op: "i32.const", value: 1 }];
    const mod = moduleWith(
      [VOID],
      [
        {
          name: "twice",
          typeIdx: 0,
          locals: [],
          body: [
            { op: "block", blockType: first, body: leaf },
            { op: "drop" },
            { op: "block", blockType: second, body: leaf },
            { op: "drop" },
          ],
        },
      ],
    );
    const diagnostics: CodegenError[] = [];
    stackBalance(mod, diagnostics);
    return { errors: diagnostics.map((d) => d.message).join("\n"), leaf };
  }

  it("treats two DISTINCT but equal block-type objects as one context", () => {
    const { errors, leaf } = sameArrayTwice(
      { kind: "val", type: { kind: "i32" } },
      { kind: "val", type: { kind: "i32" } },
    );
    expect(errors).not.toMatch(/incompatible control-flow/);
    expect(leaf).toEqual([{ op: "i32.const", value: 1 }]);
  });

  it("still refuses two block types that differ", () => {
    const { errors } = sameArrayTwice({ kind: "val", type: { kind: "i32" } }, { kind: "val", type: { kind: "f64" } });
    expect(errors).toMatch(/incompatible control-flow/);
  });
});

describe("#6759 extern.convert_any fixup skips only lists it cannot change", () => {
  it("still removes a redundant extern.convert_any in a list with no ref.null.extern", () => {
    const body: Instr[] = [{ op: "local.get", index: 0 }, { op: "extern.convert_any" }, { op: "drop" }];
    const mod = moduleWith(
      [{ kind: "func", params: [{ kind: "externref" }], results: [] }],
      [{ name: "f", typeIdx: 0, locals: [], body }],
    );
    fixupExternConvertAny({ mod, errors: [] } as never);
    expect(body.map((i) => i.op)).toEqual(["local.get", "drop"]);
  });

  it("still retypes a ref.null.extern argument in a list with no extern.convert_any", () => {
    const body: Instr[] = [{ op: "ref.null.extern" }, { op: "call", funcIdx: 1 }];
    const mod = moduleWith(
      [VOID, { kind: "struct", fields: [] }, { kind: "func", params: [{ kind: "ref_null", typeIdx: 1 }], results: [] }],
      [
        { name: "f", typeIdx: 0, locals: [], body },
        { name: "g", typeIdx: 2, locals: [], body: [] },
      ],
    );
    fixupExternConvertAny({ mod, errors: [] } as never);
    expect(body[0]).toEqual({ op: "ref.null", typeIdx: 1 });
  });
});

describe("#6759 instruction walker keeps pre-order and child order", () => {
  it("visits body, then, else, catches, catchAll in order", () => {
    const tag = (n: number): Instr => ({ op: "i32.const", value: n });
    const instrs: Instr[] = [
      tag(0),
      {
        op: "try",
        blockType: { kind: "empty" },
        body: [tag(1)],
        catches: [
          { tagIdx: 0, body: [tag(2)] },
          { tagIdx: 1, body: [tag(3)] },
        ],
        catchAll: [tag(4)],
      },
      { op: "if", blockType: { kind: "empty" }, then: [tag(5)], else: [tag(6)] },
      tag(7),
    ];
    const seen: number[] = [];
    walkInstructions(instrs, (i) => {
      if (i.op === "i32.const") seen.push(i.value);
    });
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("#6759 inliner: memoized specialisation stays per constant vector", () => {
  it("computes the right result when one callee is specialised at several constant sites", async () => {
    const result = await compile(
      `
      function pick(mode: number, x: number): number {
        if (mode === 0) return x + 1;
        if (mode === 1) return x * 2;
        return x - 3;
      }
      export function run(x: number): number {
        let acc = 0;
        for (let i = 0; i < 3; i++) {
          acc += pick(0, x);
          acc += pick(1, x);
          acc += pick(0, x);
          acc += pick(2, x);
          acc += pick(-0, x);
        }
        return acc;
      }
      `,
      { target: "standalone", fileName: "pick.ts" } as never,
    );
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const run = instance.exports.run as (x: number) => number;
    // Per iteration: (x+1) + 2x + (x+1) + (x-3) + (x+1); three iterations.
    expect(run(10)).toBe(3 * (11 + 20 + 11 + 7 + 11));
  });
});
