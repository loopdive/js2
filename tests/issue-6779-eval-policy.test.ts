// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6779 — the JS-host dynamic-code policy.
 *
 *  (a) The DEFAULT policy is `deny`: a runtime `eval` / `new Function` string
 *      throws the same `EvalError` an explicit `deny` throws and runs nothing,
 *      so it cannot observe host globals such as `process`.
 *  (b) `hostEval` (the old `compat` behaviour) still falls back to the host
 *      realm when the js2wasm child module cannot be BUILT, but a throw from
 *      RUNNING the string propagates once, unchanged — the string is never
 *      re-executed in the host (it used to double its side effects and swap
 *      its error class).
 *  (c) `compat` is a deprecated alias of `hostEval` that warns once per
 *      `buildImports` call.
 *  (d) The `new Function` arm follows the same split.
 *
 * Every dynamic string is built at runtime (or passed in from JS) so the
 * compiler's static eval folding cannot apply.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, type DynamicCodePolicy } from "../src/runtime.js";

const SOURCE = `
export function ev(src: any): any { return eval(src); }
export function nf(body: any): any { const f = new Function(body); return f(); }
`;

interface ProbeExports {
  ev(src: string): unknown;
  nf(body: string): unknown;
}

let compiled: Awaited<ReturnType<typeof compile>> | undefined;

async function instantiate(policy?: DynamicCodePolicy): Promise<ProbeExports> {
  compiled ??= await compile(SOURCE, { fileName: "issue-6779.ts" });
  expect(compiled.success).toBe(true);
  const imports = buildImports(
    compiled.imports,
    undefined,
    compiled.stringPool,
    policy === undefined ? undefined : { dynamicCode: policy },
  );
  const { instance } = await WebAssembly.instantiate(compiled.binary, imports as unknown as WebAssembly.Imports);
  imports.setInstance?.(instance);
  return instance.exports as unknown as ProbeExports;
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

const host = globalThis as Record<string, unknown>;
const at = (...parts: string[]): string => parts.join("");

afterEach(() => {
  Reflect.deleteProperty(host, "__issue6779Seen");
  Reflect.deleteProperty(host, "__issue6779Count");
  vi.restoreAllMocks();
});

describe("#6779 (a) the default policy fails closed", () => {
  it("eval of a host global throws the deny EvalError", async () => {
    const byDefault = await instantiate();
    const denied = await instantiate("deny");
    const src = at("globalThis", ".", "process");
    const defaultError = thrown(() => byDefault.ev(src));
    const denyError = thrown(() => denied.ev(src));
    expect(denyError).toBeInstanceOf(EvalError);
    expect(defaultError).toBeInstanceOf(EvalError);
    expect((defaultError as Error).message).toBe((denyError as Error).message);
  });

  it("the denied string runs nothing, so it cannot observe process", async () => {
    const byDefault = await instantiate();
    expect(thrown(() => byDefault.ev(at("globalThis.__issue6779Seen = ", "typeof process")))).toBeInstanceOf(EvalError);
    expect(host.__issue6779Seen).toBeUndefined();
  });

  it("new Function is denied too", async () => {
    const byDefault = await instantiate();
    expect(thrown(() => byDefault.nf(at("globalThis.__issue6779Seen = 1; ", "return process")))).toBeInstanceOf(
      EvalError,
    );
    expect(host.__issue6779Seen).toBeUndefined();
  });
});

describe("#6779 (b) hostEval runs a throwing eval body exactly once", () => {
  it("a body that throws after a side effect: one increment, original TypeError", async () => {
    const exports = await instantiate("hostEval");
    const error = thrown(() =>
      exports.ev(at("globalThis.__issue6779Count = (globalThis.__issue6779Count | 0) + 1; ", "null.x")),
    );
    expect(error).toBeInstanceOf(TypeError);
    expect(host.__issue6779Count).toBe(1);
  });

  it("still evaluates an ordinary string", async () => {
    const exports = await instantiate("hostEval");
    expect(exports.ev(at("1 + ", "2"))).toBe(3);
  });

  it("a string naming a host global the child cannot bind runs once, in the host", async () => {
    const exports = await instantiate("hostEval");
    host.__issue6779Fn = () => 7;
    try {
      // The child module cannot see `__issue6779Fn`, so it is refused before
      // the increment runs; the host realm then runs the whole string once.
      const value = exports.ev(
        at("globalThis.__issue6779Count = (globalThis.__issue6779Count | 0) + 1; ", "__issue6779Fn()"),
      );
      expect(value).toBe(7);
      expect(host.__issue6779Count).toBe(1);
    } finally {
      Reflect.deleteProperty(host, "__issue6779Fn");
    }
  });

  it("a string the child module cannot BUILD still falls back to the host realm", async () => {
    const exports = await instantiate("hostEval");
    // An Annex B HTML-like comment: the TypeScript parse rejects it, so the
    // child module is never built and nothing of the string has run yet.
    expect(exports.ev(at("<!-- annex b comment\n", "7"))).toBe(7);
  });
});

describe("#6779 (c) compat is a deprecated alias of hostEval", () => {
  it("behaves like hostEval and warns once per buildImports call", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const exports = await instantiate("compat");
    expect(exports.ev(at("40 + ", "2"))).toBe(42);
    const error = thrown(() =>
      exports.ev(at("globalThis.__issue6779Count = (globalThis.__issue6779Count | 0) + 1; ", "null.x")),
    );
    expect(error).toBeInstanceOf(TypeError);
    expect(host.__issue6779Count).toBe(1);
    exports.nf(at("return ", "1"));
    const compatWarnings = warn.mock.calls.filter((call) => String(call[0]).includes('"compat" is deprecated'));
    expect(compatWarnings).toHaveLength(1);
  });

  it("an unknown policy is rejected rather than picking an arm", async () => {
    compiled ??= await compile(SOURCE, { fileName: "issue-6779.ts" });
    expect(() =>
      buildImports(compiled!.imports, undefined, compiled!.stringPool, {
        dynamicCode: "hosteval" as DynamicCodePolicy,
      }),
    ).toThrow(TypeError);
  });
});

describe("#6779 (d) the new Function arm splits the same way", () => {
  it("a body that throws after a side effect: one increment, original TypeError", async () => {
    const exports = await instantiate("hostEval");
    const error = thrown(() =>
      exports.nf(at("globalThis.__issue6779Count = (globalThis.__issue6779Count | 0) + 1; ", "return null.x")),
    );
    expect(error).toBeInstanceOf(TypeError);
    expect(host.__issue6779Count).toBe(1);
  });

  it("a body the child module cannot BUILD still uses the host Function constructor", async () => {
    const exports = await instantiate("hostEval");
    expect(exports.nf(at("<!-- annex b comment\n", "return 7"))).toBe(7);
  });
});
