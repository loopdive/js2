// #5159 — `new Error(msg, { cause })` installs `cause`, and the arguments
// after the message are evaluated exactly once in source order.
//
// Before this fix the Error-family lowering
// (`src/codegen/expressions/new-builtin-globals.ts`) compiled every argument
// after the message and then emitted a bare `drop` for each. The side effects
// DID run — the issue's original "hit is 0" reading was a mis-measurement —
// but the VALUE was thrown away, so `__new_Error` was called with the message
// alone and §20.5.1.1 step 4 `InstallErrorCause(O, options)` never happened:
// `new Error("m", { cause: 1 }).cause` was permanently absent.
//
// The options bag is now kept in a local and handed to a companion host import
// `__error_install_cause(err, options)` AFTER construction. That import is a
// separate function rather than a second parameter on `__new_<Name>` on
// purpose: widening the constructor signature would have re-emitted every
// option-less `new Error(msg)` in every module. Modules that never pass options
// gain neither the import nor the call.
//
// `AggregateError` reaches the same `_installErrorCause` helper through its own
// 3-arg import and was ALREADY correct in a properly wired host — see the
// branding note on `run()` below.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

/**
 * Instantiate and wire the module the way a real host does.
 *
 * `__setInstance` is load-bearing here, not boilerplate. Since the data-struct
 * host bridge was authenticated (708ebbd56d, 2026-07-30) the runtime only
 * exposes `__struct_field_names` — the export `_installErrorCause` needs to see
 * a `cause` field on an opaque WasmGC options struct — once the host has
 * BRANDED the instance. A harness that calls `setExports` alone gets an
 * export view with that helper projected away, and every `cause` assertion
 * then fails for a reason that has nothing to do with the Error lowering.
 * The test262 runner brands (`tests/test262-runner.ts`), so this matches it.
 */
async function run(src: string): Promise<any> {
  const result: any = await compile(src, {
    fileName: "test.ts",
    skipSemanticDiagnostics: true,
  } as any);
  expect(result.binary?.length).toBeGreaterThan(0);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setInstance?.(instance);
  importObject.__setExports?.(instance.exports);
  return wrapExports(instance.exports, { signatures: result.exportSignatures });
}

/** Compile `body` as the whole of an exported `f()` and call it. */
async function f(body: string, ret = "string"): Promise<any> {
  const exports = await run(`export function f(): ${ret} { ${body} }`);
  return exports.f();
}

const ERROR_CTORS = [
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "ReferenceError",
] as const;

describe("#5159 defect 1 — options.cause is installed", () => {
  for (const ctor of ERROR_CTORS) {
    it(`${ctor}: a primitive cause is readable`, async () => {
      expect(await f(`const e: any = new ${ctor}("m", { cause: 42 } as any); return String(e.cause);`)).toBe("42");
    });

    it(`${ctor}: an object cause keeps REFERENCE identity`, async () => {
      // The whole reason `_installErrorCause` reads the raw field instead of
      // converting the struct: test262 asserts `error.cause === cause`.
      expect(
        await f(
          `const c: any = { k: 1 };
           const e: any = new ${ctor}("m", { cause: c } as any);
           return e.cause === c ? "same" : "DIFFERENT";`,
        ),
      ).toBe("same");
    });
  }

  it("AggregateError installs cause with reference identity (the twin)", async () => {
    expect(
      await f(
        `const c: any = { k: 1 };
         const e: any = new AggregateError([], "m", { cause: c } as any);
         return e.cause === c ? "same" : "DIFFERENT";`,
      ),
    ).toBe("same");
  });

  it("the message is still installed alongside the cause", async () => {
    expect(await f(`const e: any = new Error("m", { cause: 1 } as any); return String(e.message);`)).toBe("m");
  });

  it("cause is an OWN property (§20.5.8.1 CreateNonEnumerableDataPropertyOrThrow)", async () => {
    expect(
      await f(
        `const e: any = new Error("m", { cause: 1 } as any);
         return String(Object.prototype.hasOwnProperty.call(e, "cause"));`,
      ),
    ).toBe("true");
  });

  it("cause is non-enumerable, writable and configurable", async () => {
    expect(
      await f(
        `const e: any = new Error("m", { cause: 1 } as any);
         const d: any = Object.getOwnPropertyDescriptor(e, "cause");
         return String(d.enumerable) + "/" + String(d.writable) + "/" + String(d.configurable);`,
      ),
    ).toBe("false/true/true");
  });

  it("HasProperty, not truthiness — `{ cause: undefined }` still installs", async () => {
    expect(
      await f(
        `const e: any = new Error("m", { cause: undefined } as any);
         return String(Object.prototype.hasOwnProperty.call(e, "cause"));`,
      ),
    ).toBe("true");
  });

  it("an options bag WITHOUT cause installs nothing", async () => {
    expect(
      await f(
        `const e: any = new Error("m", { other: 1 } as any);
         return String(Object.prototype.hasOwnProperty.call(e, "cause"));`,
      ),
    ).toBe("false");
  });

  it("no options argument at all installs nothing", async () => {
    expect(
      await f(`const e: any = new Error("m"); return String(Object.prototype.hasOwnProperty.call(e, "cause"));`),
    ).toBe("false");
  });

  it("a non-object options argument is ignored, not thrown on", async () => {
    // §20.5.8.1 step 1 is `If options is an Object` — a number is simply not one.
    expect(
      await f(
        `const e: any = new Error("m", 5 as any); return String(Object.prototype.hasOwnProperty.call(e, "cause"));`,
      ),
    ).toBe("false");
  });

  it("the cause survives being read through a rethrow", async () => {
    expect(
      await f(
        `const c: any = { k: 2 };
         try { throw new TypeError("boom", { cause: c } as any); }
         catch (e: any) { return e.cause === c ? "same" : "DIFFERENT"; }`,
      ),
    ).toBe("same");
  });
});

describe("#5159 defect 2 — arguments after the message evaluate once, in order", () => {
  it("the options expression runs exactly once", async () => {
    expect(
      await f(
        `let hit = 0;
         function bag(): any { hit = hit + 1; return { cause: 1 }; }
         const e: any = new Error("m", bag() as any);
         return String(hit);`,
      ),
    ).toBe("1");
  });

  it("a side effect in the options position runs AND the cause still lands", async () => {
    // The original repro shape, now pinned on both halves at once: before the
    // fix `hit` was already 1 (the expression ran) but `cause` was absent.
    expect(
      await f(
        `let hit = 0;
         const o: any = { cause: 7 };
         const e: any = new Error("m", ((hit = hit + 1), o) as any);
         return String(hit) + "/" + String(e.cause);`,
      ),
    ).toBe("1/7");
  });

  it("message is evaluated BEFORE options (§13.3.6.1 ArgumentListEvaluation order)", async () => {
    expect(
      await f(
        `let log = "";
         function msg(): any { log = log + "m"; return "x"; }
         function bag(): any { log = log + "o"; return { cause: 1 }; }
         const e: any = new Error(msg() as any, bag() as any);
         return log;`,
      ),
    ).toBe("mo");
  });

  it("surplus arguments past the options bag are still evaluated, in order", async () => {
    // They have no spec meaning, but ArgumentListEvaluation still runs them —
    // and the fix must not have turned the drop loop into an early exit.
    expect(
      await f(
        `let log = "";
         function a(): any { log = log + "a"; return { cause: 1 }; }
         function b(): any { log = log + "b"; return 2; }
         function c(): any { log = log + "c"; return 3; }
         const e: any = new Error("m", a() as any, b() as any, c() as any);
         return log + "/" + String(e.cause);`,
      ),
    ).toBe("abc/1");
  });

  it("AggregateError evaluates its options argument exactly once too", async () => {
    expect(
      await f(
        `let hit = 0;
         function bag(): any { hit = hit + 1; return { cause: 1 }; }
         const e: any = new AggregateError([], "m", bag() as any);
         return String(hit) + "/" + String(e.cause);`,
      ),
    ).toBe("1/1");
  });
});

describe("#5159 — no options means no new import and no behaviour change", () => {
  it("an option-less module does not import __error_install_cause", async () => {
    // The byte-identity guarantee for option-less Error construction, asserted
    // where it is actually decidable: the companion import only appears in a
    // module whose call site passed options.
    const without: any = await compile(`export function f(): any { return new Error("m"); }`, {
      fileName: "test.ts",
      skipSemanticDiagnostics: true,
    } as any);
    const withOpts: any = await compile(`export function f(): any { return new Error("m", { cause: 1 } as any); }`, {
      fileName: "test.ts",
      skipSemanticDiagnostics: true,
    } as any);
    const names = (r: any): string[] => (r.imports ?? []).map((i: any) => (typeof i === "string" ? i : i.name));
    expect(names(without)).not.toContain("__error_install_cause");
    expect(names(withOpts)).toContain("__error_install_cause");
  });

  it("option-less Error construction still reports its message", async () => {
    expect(await f(`const e: any = new Error("m"); return String(e.message);`)).toBe("m");
  });
});
