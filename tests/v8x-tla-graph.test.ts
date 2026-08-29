import { describe, expect, it } from "vitest";
import { compileMultiSource } from "../src/compiler.ts";
import { prepareManifestGraph } from "../examples/v8x-js2wasm-spike/compile-graph.ts";

const GRAPH_ASYNC = "__v8x_graph_async";
const GRAPH_STATE = "__v8x_graph_eval_state";
const GRAPH_RESULT = "__v8x_graph_eval_result";
const GRAPH_PREPARE_RESULT = "__v8x_graph_eval_prepare_result";
const GRAPH_DRAIN = "__v8x_graph_eval_drain";

type GraphExports = WebAssembly.Exports & {
  __module_init: () => void;
  __v8x_graph_async?: () => number;
  __v8x_graph_eval_state?: () => number;
  __v8x_graph_eval_result?: () => unknown;
  __v8x_graph_eval_prepare_result?: () => number;
  __v8x_graph_eval_drain?: () => void;
  __exn_tag?: WebAssembly.Tag;
  __exn_render_prepare?: (value: unknown) => number;
  __exn_render_char?: (index: number) => number;
};

async function compileGraph(modules: ReadonlyMap<string, string>, entry: string): Promise<GraphExports> {
  const graph = prepareManifestGraph(modules, entry);
  const result = await compileMultiSource(
    graph.files,
    graph.entry,
    {
      target: "standalone",
      platform: "deno",
      allowJs: true,
      skipSemanticDiagnostics: true,
      deferTopLevelInit: true,
      hostBridge: "always",
    },
    undefined,
    graph.projectResolutions,
  );
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return instance.exports as GraphExports;
}

function renderGraphValue(exports: GraphExports, value: unknown): string {
  const prepare = exports.__exn_render_prepare;
  const character = exports.__exn_render_char;
  expect(prepare).toBeTypeOf("function");
  expect(character).toBeTypeOf("function");
  const length = prepare!(value);
  let rendered = "";
  for (let index = 0; index < length; index++) rendered += String.fromCharCode(character!(index));
  return rendered;
}

function startGraph(exports: GraphExports): void {
  try {
    exports.__module_init();
  } catch (error) {
    if (error instanceof WebAssembly.Exception && exports.__exn_tag) {
      throw new Error(renderGraphValue(exports, error.getArg(exports.__exn_tag, 0)));
    }
    throw error;
  }
}

function expectAsyncAbi(exports: GraphExports): void {
  expect(exports[GRAPH_ASYNC]).toBeTypeOf("function");
  expect(exports[GRAPH_STATE]).toBeTypeOf("function");
  expect(exports[GRAPH_RESULT]).toBeTypeOf("function");
  expect(exports[GRAPH_DRAIN]).toBeTypeOf("function");
  expect(exports.__v8x_graph_async!()).toBe(1);
}

describe("v8x compiled module graph top-level await ABI", () => {
  it("keeps a forever-pending top-level await pending without advancing", async () => {
    const exports = await compileGraph(
      new Map([
        [
          "file:///main.js",
          `
            let state = 0;
            state = 1;
            await new Promise(() => {});
            state = 2;
            export function readState() { return state; }
          `,
        ],
      ]),
      "file:///main.js",
    );
    expectAsyncAbi(exports);
    expect(exports.__v8x_graph_eval_state!()).toBe(0);

    startGraph(exports);
    expect(exports.__v8x_graph_eval_state!()).toBe(0);
    expect((exports.readState as () => number)()).toBe(1);
    exports.__v8x_graph_eval_drain!();
    startGraph(exports);
    expect(exports.__v8x_graph_eval_state!()).toBe(0);
    expect((exports.readState as () => number)()).toBe(1);
  });

  it("resumes an already-fulfilled await on the graph microtask drain", async () => {
    const exports = await compileGraph(
      new Map([
        [
          "file:///main.js",
          `
            let state = 1;
            await Promise.resolve(undefined);
            state = 2;
            export function readState() { return state; }
          `,
        ],
      ]),
      "file:///main.js",
    );
    expectAsyncAbi(exports);
    startGraph(exports);
    expect(exports.__v8x_graph_eval_state!()).toBe(0);
    expect((exports.readState as () => number)()).toBe(1);
    exports.__v8x_graph_eval_drain!();
    expect(exports.__v8x_graph_eval_state!()).toBe(1);
    expect((exports.readState as () => number)()).toBe(2);
  });

  it("settles rejected and preserves the Error payload", async () => {
    const exports = await compileGraph(
      new Map([
        [
          "file:///main.ts",
          `
            let preparedResult = "";
            export function __v8x_graph_value_prepare(value: any): number {
              preparedResult = value instanceof Error ? value.message : String(value);
              return preparedResult.length;
            }
            export function readPreparedResultChar(index: number): number {
              return preparedResult.charCodeAt(index);
            }
            let state = 1;
            await Promise.reject(new Error("tla boom"));
            state = 2;
            export function readState() { return state; }
          `,
        ],
      ]),
      "file:///main.ts",
    );
    expectAsyncAbi(exports);
    startGraph(exports);
    expect(exports.__v8x_graph_eval_state!()).toBe(0);
    exports.__v8x_graph_eval_drain!();
    expect(exports.__v8x_graph_eval_state!()).toBe(2);
    expect((exports.readState as () => number)()).toBe(1);
    expect(exports[GRAPH_PREPARE_RESULT]).toBeTypeOf("function");
    expect(exports.__v8x_graph_eval_prepare_result!()).toBe("tla boom".length);
    const readPreparedResultChar = exports.readPreparedResultChar as (index: number) => number;
    const preparedResult = Array.from({ length: "tla boom".length }, (_, index) =>
      String.fromCharCode(readPreparedResultChar(index)),
    ).join("");
    expect(preparedResult).toBe("tla boom");
    expect(renderGraphValue(exports, exports.__v8x_graph_eval_result!())).toContain("Error: tla boom");
  });

  it("keeps a nested rejection array visible to the fused result serializer", async () => {
    const exports = await compileGraph(
      new Map([
        [
          "file:///main.ts",
          `
            let preparedResult = "";
            export function __v8x_graph_value_prepare(value: any): number {
              const values: any = value.values;
              preparedResult = values instanceof Array
                ? String(values.length) + ":" + String(values[4].deep)
                : "not-array";
              return preparedResult.length;
            }
            export function readPreparedResultChar(index: number): number {
              return preparedResult.charCodeAt(index);
            }
            await Promise.reject({
              code: 7,
              values: [undefined, null, true, "ok", { deep: 9 }],
            });
          `,
        ],
      ]),
      "file:///main.ts",
    );
    expectAsyncAbi(exports);
    startGraph(exports);
    exports.__v8x_graph_eval_drain!();
    expect(exports.__v8x_graph_eval_state!()).toBe(2);
    expect(exports.__v8x_graph_eval_prepare_result!()).toBe("5:9".length);
    const readPreparedResultChar = exports.readPreparedResultChar as (index: number) => number;
    const preparedResult = Array.from({ length: "5:9".length }, (_, index) =>
      String.fromCharCode(readPreparedResultChar(index)),
    ).join("");
    expect(preparedResult).toBe("5:9");
  });

  it("does not evaluate a dependent module until its dependency resumes", async () => {
    const exports = await compileGraph(
      new Map([
        [
          "file:///dep.js",
          `
            export let depState = 0;
            let releaseGate;
            const gate = new Promise((resolve) => { releaseGate = resolve; });
            depState = 1;
            await gate;
            depState = 2;
            export function release() { releaseGate(); }
          `,
        ],
        [
          "file:///main.js",
          `
            import { depState, release } from "./dep.js";
            let parentState = 0;
            parentState = depState;
            export function readState() { return parentState; }
            export function resumeDependency() { release(); }
          `,
        ],
      ]),
      "file:///main.js",
    );
    expectAsyncAbi(exports);
    startGraph(exports);
    expect(exports.__v8x_graph_eval_state!()).toBe(0);
    let parentStillInTdz = false;
    try {
      (exports.readState as () => number)();
    } catch {
      parentStillInTdz = true;
    }
    expect(parentStillInTdz).toBe(true);
    (exports.resumeDependency as () => void)();
    exports.__v8x_graph_eval_drain!();
    expect(exports.__v8x_graph_eval_state!()).toBe(1);
    expect((exports.readState as () => number)()).toBe(2);
  });

  it("leaves a synchronous graph on the existing initializer ABI", async () => {
    const exports = await compileGraph(
      new Map([
        [
          "file:///main.js",
          `
            let state = 1;
            state = 2;
            export async function later() { await Promise.resolve(undefined); }
            export function readState() { return state; }
          `,
        ],
      ]),
      "file:///main.js",
    );
    expect(exports[GRAPH_ASYNC]).toBeUndefined();
    expect(exports[GRAPH_STATE]).toBeUndefined();
    expect(exports[GRAPH_RESULT]).toBeUndefined();
    expect(exports[GRAPH_DRAIN]).toBeUndefined();
    startGraph(exports);
    expect((exports.readState as () => number)()).toBe(2);
  });
});
