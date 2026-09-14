// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type ts from "typescript";
import "../src/index.js";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { ensureMicrotaskQueue, getOrInitState, MICROTASK_QUEUE_INITIAL_SLOTS } from "../src/codegen/async-scheduler.js";
import { mintDefinedFunc, pushDefinedFunc } from "../src/codegen/func-space.js";
import { addFuncType } from "../src/codegen/registry/types.js";
import { addImport } from "../src/codegen/registry/imports.js";

async function queue(visit: (captures: unknown, value: unknown) => unknown) {
  const mod = createEmptyModule();
  mod.types.push({
    kind: "func",
    params: [{ kind: "externref" }, { kind: "externref" }],
    results: [{ kind: "externref" }],
  });
  const ctx = createCodegenContext(mod, {} as ts.TypeChecker);
  addImport(ctx, "test", "visit", { kind: "func", typeIdx: 0 });
  ensureMicrotaskQueue(ctx);
  const state = getOrInitState(ctx);
  const counts = [mod.types.length, mod.globals.length, mod.functions.length];
  ensureMicrotaskQueue(ctx);
  expect([mod.types.length, mod.globals.length, mod.functions.length]).toEqual(counts);
  expect(mod.globals.map((global) => global.name)).toEqual([
    "__mt_head",
    "__mt_tail",
    "__mt_cap",
    "__mt_funcs",
    "__mt_caps",
    "__mt_args",
  ]);
  expect(mod.functions.map((fn) => fn.name)).toEqual(["__microtask_grow", "__microtask_enqueue", "__drain_microtasks"]);
  const callback = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, callback, {
    name: "callback",
    typeIdx: state.microtaskFuncTypeIdx,
    locals: [],
    exported: false,
    body: [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: 0 },
    ],
  });
  mod.declaredFuncRefs.push(callback);
  const enqueue = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, enqueue, {
    name: "enqueue",
    typeIdx: addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], []),
    locals: [],
    exported: true,
    body: [
      { op: "ref.func", funcIdx: callback },
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: state.enqueueFuncIdx },
    ],
  });
  mod.exports.push(
    { name: "enqueue", desc: { kind: "func", index: enqueue } },
    { name: "drain", desc: { kind: "func", index: state.drainFuncIdx } },
    { name: "head", desc: { kind: "global", index: state.microtaskHeadGlobalIdx } },
    { name: "tail", desc: { kind: "global", index: state.microtaskTailGlobalIdx } },
    { name: "capacity", desc: { kind: "global", index: state.microtaskCapGlobalIdx } },
  );
  const binary = emitBinary(mod);
  expect(WebAssembly.validate(binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(binary, { test: { visit } });
  return instance.exports as {
    enqueue: (captures: unknown, value: unknown) => void;
    drain: () => void;
    head: WebAssembly.Global;
    tail: WebAssembly.Global;
    capacity: WebAssembly.Global;
  };
}

describe("prepared native queue physical closure", () => {
  it("keeps unused and exhausted drains empty", async () => {
    const seen: unknown[] = [];
    const q = await queue((captures, value) => {
      seen.push(captures, value);
      return value;
    });
    q.drain();
    expect(q.capacity.value).toBe(0);
    const captures = {};
    q.enqueue(captures, undefined);
    q.drain();
    q.drain();
    expect(seen).toEqual([captures, undefined]);
    expect(q.head.value).toBe(1);
    expect(q.tail.value).toBe(1);
  });

  it("grows past the production initial capacity without losing FIFO values or captures", async () => {
    const seen: unknown[] = [];
    const captures = {};
    const q = await queue((actualCaptures, value) => {
      expect(actualCaptures).toBe(captures);
      seen.push(value);
      return null;
    });
    const count = MICROTASK_QUEUE_INITIAL_SLOTS + 3;
    for (let i = 0; i < count; i++) q.enqueue(captures, i);
    expect(q.capacity.value).toBe(MICROTASK_QUEUE_INITIAL_SLOTS * 2);
    q.drain();
    expect(seen).toEqual(Array.from({ length: count }, (_, i) => i));
  });

  it("copies only live entries when a callback grows the queue during drain", async () => {
    const seen: unknown[] = [];
    const q = await queue((_captures, value) => {
      seen.push(value);
      if (value === 0) q.enqueue(null, "appended");
      return null;
    });
    for (let i = 0; i < MICROTASK_QUEUE_INITIAL_SLOTS; i++) q.enqueue(null, i);
    q.drain();
    expect(seen).toEqual([...Array.from({ length: MICROTASK_QUEUE_INITIAL_SLOTS }, (_, i) => i), "appended"]);
    expect(q.capacity.value).toBe(MICROTASK_QUEUE_INITIAL_SLOTS * 2);
    expect(q.head.value).toBe(MICROTASK_QUEUE_INITIAL_SLOTS);
    expect(q.tail.value).toBe(MICROTASK_QUEUE_INITIAL_SLOTS);
  });

  it("propagates a thrown callback after advancing head and resumes remaining work", async () => {
    const failure = new Error("callback failure");
    const seen: unknown[] = [];
    const q = await queue((_captures, value) => {
      seen.push(value);
      if (value === "throw") throw failure;
      return null;
    });
    q.enqueue(null, "throw");
    q.enqueue(null, "next");
    expect(() => q.drain()).toThrow(failure);
    expect(q.head.value).toBe(1);
    q.drain();
    expect(seen).toEqual(["throw", "next"]);
  });

  it("imports the native leaf in a fresh process with compiler dependencies denied", () => {
    const script = String.raw`
      import { registerHooks } from "node:module";
      import { fileURLToPath, pathToFileURL } from "node:url";
      import { relative, resolve, sep } from "node:path";
      const loaded = [];
      const root = resolve("src");
      registerHooks({ resolve(specifier, context, next) {
        const result = next(specifier, context);
        if (result.url.startsWith("file:")) {
          const path = relative(root, fileURLToPath(result.url)).split(sep).join("/");
          if (/^(codegen|frontend|checker|ts-api|compiler|legacy)(\/|\.|$)/.test(path) ||
              /^ir\/types\.(ts|js)$/.test(path) || /typescript|checker|from-ast/.test(specifier)) {
            throw new Error("Forbidden import: " + path);
          }
          loaded.push(path);
        }
        return result;
      }});
      const leaf = await import("./src/runtime/wasmgc/async/microtask-queue-bodies.ts");
      if (typeof leaf.buildDrainBody !== "function") throw new Error("Missing builder");
      if (!loaded.includes("runtime/wasmgc/async/microtask-queue-bodies.ts")) throw new Error("Leaf not observed");
      for (const path of ["codegen/async-scheduler.ts", "ir/types.ts", "compiler.ts"]) {
        const forbidden = pathToFileURL(resolve("src", path)).href;
        const injected = "data:text/javascript," + encodeURIComponent("import " + JSON.stringify(forbidden));
        let denied = false;
        try { await import(injected); }
        catch (error) { denied = String(error).includes("Forbidden import:"); }
        if (!denied) throw new Error("Import barrier failed its positive control: " + path);
      }
      console.log("physical-leaf-loaded");
    `;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain("physical-leaf-loaded");
  });

  it("preserves all five compatibility function objects in a separate fresh process", () => {
    const script = `
      const leaf = await import("./src/runtime/wasmgc/async/microtask-queue-bodies.ts");
      const adapter = await import("./src/codegen/prepared-native-async-runtime.ts");
      const names = ["buildGrowLocals", "buildGrowBody", "buildEnqueueBody", "buildDrainLocals", "buildDrainBody"];
      if (JSON.stringify(Object.keys(adapter).sort()) !== JSON.stringify([...names].sort())) {
        throw new Error("Unexpected compatibility surface");
      }
      for (const name of names) {
        if (typeof leaf[name] !== "function" || adapter[name] !== leaf[name]) throw new Error("Identity lost: " + name);
      }
      console.log("five-builder-identities-preserved");
    `;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain("five-builder-identities-preserved");
  });
});
