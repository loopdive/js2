// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5195 — ES2015 class residual pass, round 2. One block per landed step of the
// plan in `plan/issues/5195-es2015-standalone-class-r2.md`: the exact Test262
// rows it flipped, plus source-level controls in BOTH lanes that keep the
// mechanism pinned where the rows cannot reach it. Every standalone
// control asserts an EMPTY import list — the standalone target must stay
// host-import-free (#5272: the path-runner probe does not apply CI's host-import
// leak check, so this file is where that invariant is actually enforced).

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

/** Step 3 (cluster D1) — the `typeof caught` fold and the read off that binding. */
const STEP_3_ROWS = [
  "language/expressions/super/prop-dot-obj-null-proto.js",
  "language/expressions/super/prop-expr-obj-null-proto.js",
  "language/expressions/super/prop-expr-obj-unresolvable.js",
  "language/expressions/super/prop-expr-cls-unresolvable.js",
] as const;

/** Step 9 K — a computed key that folds to "constructor" is not the constructor. */
const STEP_9K_ROWS = [
  "language/computed-property-names/class/method/constructor-can-be-generator.js",
  "language/computed-property-names/class/method/constructor-can-be-getter.js",
  "language/computed-property-names/class/method/constructor-can-be-setter.js",
] as const;

async function runStandalone(source: string, exportName: string, fileName: string): Promise<unknown> {
  const result = await compile(source, {
    target: "standalone",
    allowJs: true,
    fileName,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  expect(result.imports, "#5195 standalone controls must stay host-free").toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as Record<string, () => unknown>)[exportName]!();
}

function runHost(source: string, exportName: string): unknown {
  const hostSource = source.replace(/\bexport\s+/g, "");
  return (new Function(`${hostSource}\nreturn ${exportName};`)() as () => unknown)();
}

/**
 * Row pins. `lanes` says which targets the row is expected to pass on: the
 * `super` rows in Step 3 exercise the #4688 object-literal runtime super read,
 * which exists only in the standalone lowering — the JS-host lane still
 * resolves `super.x` statically and never throws, so `caught` is never written
 * and `typeof caught` is legitimately "undefined" there. Pinning host on those
 * rows would pin a gap that is not this issue's.
 *
 * The generous per-test timeout is load, not slack: each row compiles the whole
 * harness once per lane, and this box runs several agents at a time.
 */
function pinRows(step: string, rows: readonly string[], lanes: "standalone" | "both"): void {
  for (const relativePath of rows) {
    const file = resolve(process.cwd(), "test262", "test", relativePath);
    const label = lanes === "both" ? "host and standalone" : "standalone";
    it.skipIf(!existsSync(file))(
      `${step}: ${relativePath} passes in ${label}`,
      async () => {
        try {
          if (lanes === "both") {
            const host = await runTest262File(file, "issue-5195", 60_000);
            expect({ status: host.status, error: host.error }).toEqual({ status: "pass", error: undefined });
          }
          const standalone = await runTest262File(file, "issue-5195", 60_000, "standalone");
          expect({ status: standalone.status, error: standalone.error }).toEqual({ status: "pass", error: undefined });
        } finally {
          restoreHostBuiltins();
        }
      },
      300_000,
    );
  }
}

describe("#5195 Step 3 — closure-written module binding: typeof and member read", () => {
  pinRows("step 3", STEP_3_ROWS, "standalone");

  // The `caught` idiom: the ONLY write to the module `var` happens inside a
  // nested function, which TypeScript's flow analysis does not apply to the
  // outer binding — so its checker type stays `undefined`. Folding `typeof` (or
  // reading a member) off that type answers "undefined"/null while the runtime
  // slot holds a real object.
  const CAUGHT_SOURCE = `
    var caught;
    function thrower() {
      try {
        throw new TypeError("boom");
      } catch (err) {
        caught = err;
      }
    }
    thrower();
    export function probe() {
      return (typeof caught === "object") && (caught.constructor === TypeError) && caught.message === "boom";
    }
  `;

  it("standalone: typeof and .constructor see the closure-written value", async () => {
    expect(await runStandalone(CAUGHT_SOURCE, "probe", "issue-5195-caught.js")).toBe(1);
  });

  it("host lane agrees", () => {
    expect(runHost(CAUGHT_SOURCE, "probe")).toBe(true);
  });

  // Order-preservation control: a module binding the checker CAN resolve keeps
  // its static answer — the guard must not turn every `typeof` into a runtime
  // call, and the member read must not leave its resolvable lane.
  const RESOLVED_SOURCE = `
    var n = 41;
    var s = "hi";
    function bump() { n = n + 1; }
    bump();
    export function probe() {
      return (typeof n === "number") && (typeof s === "string") && s.length === 2 && n === 42;
    }
  `;

  it("standalone: resolvable bindings keep their static typeof", async () => {
    expect(await runStandalone(RESOLVED_SOURCE, "probe", "issue-5195-resolved.js")).toBe(1);
  });

  it("host lane agrees on resolvable bindings", () => {
    expect(runHost(RESOLVED_SOURCE, "probe")).toBe(true);
  });
});

describe("#5195 Step 9K — computed class keys are not the constructor", () => {
  pinRows("step 9K", STEP_9K_ROWS, "both");

  // §13.2.5.5: PropName of a ComputedPropertyName is EMPTY, so a computed key
  // that merely FOLDS to "constructor" carries none of the §15.7.1 restrictions
  // on a method literally named `constructor`.
  const COMPUTED_CTOR_SOURCE = `
    class C {
      get ['constructor']() { return 7; }
    }
    class D {
      set ['constructor'](v) { this.seen = v; }
    }
    export function probe() {
      const d = new D();
      d.constructor = 5;
      return new C().constructor === 7 && d.seen === 5;
    }
  `;

  it("standalone: computed 'constructor' accessors compile and dispatch", async () => {
    expect(await runStandalone(COMPUTED_CTOR_SOURCE, "probe", "issue-5195-computed-ctor.js")).toBe(1);
  });

  it("host lane agrees on computed 'constructor' accessors", () => {
    expect(runHost(COMPUTED_CTOR_SOURCE, "probe")).toBe(true);
  });

  // The real restriction must survive: a method literally named `constructor`
  // still may not be a getter/setter/generator/async.
  it("a literal `get constructor()` is still an early error", async () => {
    const result = await compile("class C { get constructor() { return 1; } }", {
      target: "standalone",
      allowJs: true,
      fileName: "issue-5195-literal-ctor-getter.js",
      skipSemanticDiagnostics: true,
    });
    const messages = result.errors.map((error) => error.message).join("\n");
    expect(messages).toContain("Class constructor may not be a getter");
  });
});
