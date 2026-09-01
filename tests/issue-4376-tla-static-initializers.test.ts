// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compileMulti } from "../src/index.js";

type GraphExports = WebAssembly.Exports & {
  __module_init: () => void;
  __v8x_graph_eval_drain: () => void;
  beforeProbe: () => number;
  probe: () => number;
};

async function compileGraph(files: Record<string, string>, entry: string): Promise<GraphExports> {
  const result = await compileMulti(files, entry, {
    target: "standalone",
    platform: "deno",
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
    hostBridge: "always",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);

  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return instance.exports as GraphExports;
}

describe("#4376 top-level-await class static initialization", () => {
  it("keeps static fields and blocks on their source-order sides of a top-level await", async () => {
    const exports = await compileGraph(
      {
        "./entry.ts": `
          let phase = 0;
          class Before {
            static x = (phase = 1, 40);
            static {
              Before.x = Before.x + 2;
              phase = Before.x;
            }
          }
          await Promise.resolve(undefined);
          phase = phase + 1;
          class After {
            static y = (phase = phase + 1, 7);
            static { phase = phase + After.y; }
          }
          export function beforeProbe(): number { return Before.x * 100 + phase; }
          export function probe(): number { return Before.x * 1000 + After.y * 100 + phase; }
        `,
      },
      "./entry.ts",
    );

    exports.__module_init();
    // The frame has reached the await: preceding class evaluation is complete,
    // while the statement and class after await still wait for graph drain.
    expect(exports.beforeProbe()).toBe(4242);
    exports.__v8x_graph_eval_drain();
    expect(exports.probe()).toBe(42751);
  });

  it("does not evaluate an importing module's class statics before dependency TLA settles", async () => {
    const exports = await compileGraph(
      {
        "./dependency.ts": `
          export let state = 0;
          state = 1;
          await Promise.resolve(undefined);
          state = 2;
        `,
        "./entry.ts": `
          import { state } from "./dependency.js";
          let observed = 0;
          class Entry {
            static value = state;
            static { observed = Entry.value; }
          }
          export function probe(): number { return Entry.value * 10 + observed; }
        `,
      },
      "./entry.ts",
    );

    exports.__module_init();
    exports.__v8x_graph_eval_drain();
    expect(exports.probe()).toBe(22);
  });

  it("does not lift a branch-local class static block out of its false branch", async () => {
    const exports = await compileGraph(
      {
        "./entry.ts": `
          let phase = 0;
          if (false) {
            class Skipped {
              static value = (phase = 1, 40);
              static { phase = phase + Skipped.value; }
            }
          }
          await Promise.resolve(undefined);
          export function probe(): number { return phase; }
        `,
      },
      "./entry.ts",
    );

    exports.__module_init();
    exports.__v8x_graph_eval_drain();
    expect(exports.probe()).toBe(0);
  });

  it("evaluates a branch-local class static block when its true branch runs", async () => {
    const exports = await compileGraph(
      {
        "./entry.ts": `
          let phase = 0;
          if (true) {
            class Runs {
              static value = (phase = 1, 40);
              static { phase = phase + Runs.value; }
            }
          }
          await Promise.resolve(undefined);
          export function probe(): number { return phase; }
        `,
      },
      "./entry.ts",
    );

    exports.__module_init();
    exports.__v8x_graph_eval_drain();
    expect(exports.probe()).toBe(41);
  });

  it("keeps a nested class static throw inside its enclosing catch", async () => {
    const exports = await compileGraph(
      {
        "./entry.ts": `
          let phase = 0;
          try {
            class Throws {
              static { throw 1; }
            }
          } catch {
            phase = 2;
          }
          await Promise.resolve(undefined);
          export function probe(): number { return phase; }
        `,
      },
      "./entry.ts",
    );

    exports.__module_init();
    exports.__v8x_graph_eval_drain();
    expect(exports.probe()).toBe(2);
  });
});
