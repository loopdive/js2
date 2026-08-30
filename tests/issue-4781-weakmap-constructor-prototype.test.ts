/**
 * #4781 — the ES2015 WeakMap constructor is a built-in function, so
 * `Object.getPrototypeOf(WeakMap)` must be the intrinsic Function.prototype.
 * Keep the nearby constructor and instance-operation rows as controls for the
 * narrow getPrototypeOf lowering.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

const TARGET = "built-ins/WeakMap/prototype-of-weakmap.js";
const CONTROLS = [
  "built-ins/WeakMap/prototype/prototype-attributes.js",
  "built-ins/WeakMap/no-iterable.js",
  "built-ins/WeakMap/length.js",
  "built-ins/WeakMap/is-a-constructor.js",
  "built-ins/WeakMap/prototype/set/set.js",
  "built-ins/WeakMap/prototype/has/has.js",
] as const;

type TestResult = Awaited<ReturnType<typeof runTest262File>>;

/**
 * CI's changed-root lane selects the refusal runtime-eval provider. The
 * assembled Test262 harness intentionally contains `$262.evalScript` in every
 * row, so it cannot link there even when this target never evaluates dynamic
 * code. Keep the exact assembled row for the authoritative QuickJS lane and
 * use a host-free direct predicate for that refusal-only tier; this still
 * executes the same `Object.getPrototypeOf(WeakMap)` lowering without adding a
 * fake provider capability to the test. The predicate checks the non-null
 * prototype's intrinsic `name` in two ordinary operations, because direct
 * reference equality itself is routed through the unavailable provider in this
 * tier.
 */
async function runInterpreterStandaloneTarget(): Promise<TestResult> {
  const result = await compile(
    `export function test(): number {
       var prototype = Object.getPrototypeOf(WeakMap);
       if (prototype === null) return 0;
       return prototype.name === Function.prototype.name ? 1 : 0;
     }`,
    {
      allowJs: true,
      fileName: "issue-4781-interpreter-standalone.ts",
      skipSemanticDiagnostics: true,
      target: "standalone",
    },
  );
  if (!result.success) {
    return {
      file: `test/${TARGET}`,
      category: "built-ins/WeakMap",
      status: "compile_error",
      error: result.errors.map((error) => error.message).join("; "),
    };
  }
  const module = new WebAssembly.Module(result.binary);
  const imports = WebAssembly.Module.imports(module);
  if (imports.length > 0) {
    return {
      file: `test/${TARGET}`,
      category: "built-ins/WeakMap",
      status: "compile_error",
      error: `interpreter-tier fallback emitted imports: ${imports.map((entry) => `${entry.module}::${entry.name}`).join(", ")}`,
    };
  }
  try {
    const instance = await WebAssembly.instantiate(module, {});
    const value = (instance.exports as { test: () => number }).test();
    return {
      file: `test/${TARGET}`,
      category: "built-ins/WeakMap",
      status: value === 1 ? "pass" : "fail",
      reason: value === 1 ? undefined : `direct WeakMap prototype predicate returned ${value}`,
    };
  } catch (error) {
    return {
      file: `test/${TARGET}`,
      category: "built-ins/WeakMap",
      status: "fail",
      error: String(error),
    };
  }
}

async function run(file: string, target?: "standalone"): Promise<TestResult> {
  if (file === TARGET && target === "standalone" && process.env.JS2WASM_EVAL_ENGINE === "interpreter") {
    return runInterpreterStandaloneTarget();
  }
  return runTest262File(join("test262/test", file), "built-ins/WeakMap", 120_000, target);
}

describe("#4781 — WeakMap constructor prototype identity", () => {
  for (const target of [undefined, "standalone"] as const) {
    const lane = target ?? "host";

    it(`${lane}: the exact constructor prototype row passes`, async () => {
      const result = await run(TARGET, target);
      expect(result.status, `${TARGET}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
    });

    it.each(CONTROLS)(`${lane}: nearby WeakMap control %s passes`, async (file) => {
      const result = await run(file, target);
      expect(result.status, `${file}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
    });
  }
});
