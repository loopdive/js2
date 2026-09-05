// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3371 r4 — `Reflect.construct(target, args, NewTarget)` with an arbitrary
 * distinct NewTarget, `--target standalone`.
 *
 * Before this change the lowering picked the instance prototype by SCANNING THE
 * SOURCE for a prior `NewTarget.prototype = …` assignment, and emitted a hard
 * compile error when the scan found nothing. The 11 test262 rows pinned below
 * were all `compile_error` on `origin/main` at 46c12b01d6; they pass here
 * because the arm now performs the real `? Get(NewTarget, "prototype")`.
 *
 * The two things worth breaking on a future edit:
 *  - the prototype read must actually RUN (six `custom-proto-access-throws`
 *    rows only pass because the getter throws), and
 *  - it must NOT run before the constructor's own argument validation
 *    (`byteOffset-validated-against-initial-buffer-length` wants a RangeError,
 *    `throw-type-error-before-custom-proto-access` wants a TypeError).
 * A patch that moves the read earlier flips the first group green and the
 * second red, so both groups are listed deliberately.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

const TEST262_ROOT = "test262/test";
const ROW_TIMEOUT = 180_000;

async function expectStandalonePass(file: string): Promise<void> {
  const result = await runTest262File(join(TEST262_ROOT, file), "issue-3371", 60_000, "standalone");
  expect(result.status, `${file}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
}

/** The prototype getter must run — its throw is the whole observable. */
const GETTER_RUNS_ROWS = [
  "built-ins/DataView/custom-proto-access-throws.js",
  "built-ins/TypedArrayConstructors/ctors/length-arg/custom-proto-access-throws.js",
  "built-ins/TypedArrayConstructors/ctors/object-arg/custom-proto-access-throws.js",
  "built-ins/TypedArrayConstructors/ctors/typedarray-arg/custom-proto-access-throws.js",
  "built-ins/TypedArrayConstructors/ctors/no-args/custom-proto-access-throws.js",
  "built-ins/TypedArrayConstructors/ctors/buffer-arg/custom-proto-access-throws.js",
  "built-ins/Promise/get-prototype-abrupt.js",
  "built-ins/Promise/get-prototype-abrupt-executor-not-callable.js",
];

/** The constructor's own validation must win over the prototype getter. */
const VALIDATION_FIRST_ROWS = [
  "built-ins/DataView/byteOffset-validated-against-initial-buffer-length.js",
  "built-ins/TypedArrayConstructors/ctors/typedarray-arg/throw-type-error-before-custom-proto-access.js",
];

/** The fetched prototype must actually reach the instance. */
const PROTOTYPE_APPLIED_ROWS = ["built-ins/Reflect/construct/return-with-newtarget-argument.js"];

/** Unchanged by this work — the no-distinct-NewTarget positive control. */
const POSITIVE_CONTROL = "built-ins/Reflect/construct/return-without-newtarget-argument.js";

describe("#3371 r4 — runtime NewTarget.prototype for Reflect.construct (standalone)", () => {
  it.each(GETTER_RUNS_ROWS)(
    "runs the NewTarget.prototype getter: %s",
    async (file) => {
      await expectStandalonePass(file);
    },
    ROW_TIMEOUT,
  );

  it.each(VALIDATION_FIRST_ROWS)(
    "validates arguments before reading the prototype: %s",
    async (file) => {
      await expectStandalonePass(file);
    },
    ROW_TIMEOUT,
  );

  it.each(PROTOTYPE_APPLIED_ROWS)(
    "applies the fetched prototype to the instance: %s",
    async (file) => {
      await expectStandalonePass(file);
    },
    ROW_TIMEOUT,
  );

  it(
    "keeps the no-distinct-NewTarget positive control passing",
    async () => {
      await expectStandalonePass(POSITIVE_CONTROL);
    },
    ROW_TIMEOUT,
  );
});

/**
 * Node-parity probes. Each source is also the answer node gives; the standalone
 * module must additionally emit ZERO host imports, which is the property CI
 * enforces and the in-process test262 path does not check.
 */
const PARITY_SOURCES: readonly { name: string; source: string }[] = [
  {
    name: "an ordinary function target takes NewTarget.prototype",
    source: `
      export function test(): number {
        function fn(this: any): void { this.o = 1; }
        const NT: any = function (): void {};
        const P: any = { tag: 7 };
        // A DESCRIPTOR write, not \`NT.prototype = P\`: the assignment form is
        // what the old source scan recognised, and this probe exists to pin
        // the runtime read that replaced it.
        Object.defineProperty(NT, "prototype", { value: P });
        const r: any = Reflect.construct(fn, [], NT);
        if (Object.getPrototypeOf(r) !== P) return 1;
        if (r.o !== 1) return 2;
        return 0;
      }
    `,
  },
  {
    name: "a throwing NewTarget.prototype getter propagates",
    source: `
      export function test(): number {
        function fn(this: any): void { this.o = 1; }
        const NT: any = function (): void {};
        Object.defineProperty(NT, "prototype", {
          get(): any { throw new RangeError("proto"); },
        });
        try {
          Reflect.construct(fn, [], NT);
        } catch (e: any) {
          return e instanceof RangeError ? 0 : 1;
        }
        return 2;
      }
    `,
  },
  {
    name: "a bound function is a constructor for NewTarget purposes",
    source: `
      export function test(): number {
        function fn(this: any): void { this.o = 1; }
        const bound: any = (function (): void {}).bind(null);
        // Would have thrown "newTarget is not a constructor" before r4.
        const r: any = Reflect.construct(fn, [], bound);
        return r === null || r === undefined ? 1 : 0;
      }
    `,
  },
];

describe("#3371 r4 — node-parity probes, zero host imports", () => {
  it.each(PARITY_SOURCES)(
    "$name",
    async ({ source }) => {
      const result = await compile(source, {
        target: "standalone",
        allowJs: true,
        skipSemanticDiagnostics: true,
        fileName: "issue-3371-r4.ts",
      });
      expect(
        result.success,
        `standalone compile failed:\n${result.errors?.map((e) => `L${e.line}: ${e.message}`).join("\n") ?? ""}`,
      ).toBe(true);
      if (!result.success) return;
      expect(result.imports, "standalone Reflect.construct probes must emit zero host imports").toEqual([]);
      const { instance } = await WebAssembly.instantiate(result.binary, {});
      expect((instance.exports as { test: () => number }).test()).toBe(0);
    },
    ROW_TIMEOUT,
  );
});
