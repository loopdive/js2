// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2104 (value-rep P1) — the canonical JsTag module.
 *
 * Guards the single tag policy home (`src/codegen/value-tags.ts`):
 *   - `JsTag` numeric values match the runtime tags written by the
 *     `__any_box_*` helpers in `any-helpers.ts` (drift here silently
 *     mis-dispatches every tag consumer);
 *   - `jsStaticType` classifies TS types into the right JS-type partition;
 *   - the `UNDEF_F64` sentinel push/test round-trips and uses the bit-pattern
 *     compare (not `f64.eq`, which is false for any NaN);
 *   - boxing through `boxToAny` stays behaviour-identical (an end-to-end
 *     `any`-boxed `String(v)` over the canonical value vector still matches JS).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { JsTag, emitIsUndefF64, jsStaticType, pushUndefF64, UNDEF_F64_BITS } from "../src/codegen/value-tags.js";
import { ts } from "../src/ts-api.js";
import type { Instr } from "../src/ir/types.js";

describe("#2104 JsTag enum — matches runtime box-helper tags", () => {
  it("tag values match the __any_box_* helpers", () => {
    // These MUST equal the i32.const tag each helper writes (any-helpers.ts).
    expect(JsTag.Null).toBe(0);
    expect(JsTag.Undefined).toBe(1);
    expect(JsTag.NumberI32).toBe(2);
    expect(JsTag.NumberF64).toBe(3);
    expect(JsTag.Boolean).toBe(4);
    expect(JsTag.String).toBe(5);
    expect(JsTag.Object).toBe(6);
    expect(JsTag.Function).toBe(7);
  });
});

describe("#2104 jsStaticType classifier", () => {
  function classify(src: string): string {
    // Wrap an expression and read the type of the cast operand.
    const full = `const __x = (${src}); export const __y = __x;`;
    const sf = ts.createSourceFile("t.ts", full, ts.ScriptTarget.Latest, true);
    const host = ts.createCompilerHost({});
    host.getSourceFile = (f) => (f === "t.ts" ? sf : undefined);
    host.readFile = () => full;
    host.fileExists = (f) => f === "t.ts";
    const prog = ts.createProgram(["t.ts"], { noLib: true, types: [] }, host);
    const checker = prog.getTypeChecker();
    let result = "unset";
    function visit(n: ts.Node): void {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === "__x" && n.initializer) {
        result = jsStaticType(checker.getTypeAtLocation(n.initializer));
      }
      ts.forEachChild(n, visit);
    }
    visit(sf);
    return result;
  }

  it("classifies primitive literals", () => {
    expect(classify("42")).toBe("number");
    expect(classify("1.5")).toBe("number");
    expect(classify("true")).toBe("boolean");
    expect(classify('"x"')).toBe("string");
    expect(classify("null")).toBe("null");
    expect(classify("undefined")).toBe("undefined");
    expect(classify("10n")).toBe("bigint");
  });

  it("classifies object and function types", () => {
    expect(classify("({a: 1})")).toBe("object");
    expect(classify("[1, 2]")).toBe("object");
    expect(classify("(() => 1)")).toBe("function");
  });

  it("returns unknown for any and undefined input", () => {
    expect(classify("(0 as any)")).toBe("unknown");
    expect(jsStaticType(undefined)).toBe("unknown");
  });
});

describe("#2104 UNDEF_F64 sentinel helpers", () => {
  const opNames = (instrs: Instr[]) => instrs.map((i) => i.op);

  it("pushUndefF64 emits the i64 bit pattern then reinterprets to f64", () => {
    const body: Instr[] = [];
    pushUndefF64(body);
    expect(opNames(body)).toEqual(["i64.const", "f64.reinterpret_i64"]);
    expect((body[0] as { value: bigint }).value).toBe(UNDEF_F64_BITS);
    expect(UNDEF_F64_BITS).toBe(0x7ff00000deadc0den);
  });

  it("emitIsUndefF64 compares the i64 bits (not f64.eq, which fails for NaN)", () => {
    const body: Instr[] = [];
    emitIsUndefF64(body);
    expect(opNames(body)).toEqual(["i64.reinterpret_f64", "i64.const", "i64.eq"]);
  });
});

describe("#2104 boxToAny — behaviour preserved end-to-end", () => {
  // String() over the canonical value vector, both direct-typed and any-boxed,
  // must still match JS — the tag-fidelity guard for the consolidated box path.
  async function run(src: string): Promise<unknown> {
    const r = await compile(src, { fileName: "t.ts" });
    expect(r.success, r.success ? "" : `CE: ${r.errors?.[0]?.message}`).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, (r.importObject ?? {}) as WebAssembly.Imports);
    return (instance.exports as { test(): unknown }).test();
  }

  it("String() of any-boxed number, bool, string round-trips", async () => {
    expect(await run("export function test(): string { const v: any = 42; return String(v); }")).toBe("42");
    expect(await run("export function test(): string { const v: any = true; return String(v); }")).toBe("true");
    expect(await run('export function test(): string { const v: any = "hi"; return String(v); }')).toBe("hi");
  });
});

describe("#42 boxToAny — native-string ref boxes as tag-5 STRING, not tag-6 object", () => {
  // In standalone/nativeStrings mode a native string is a `ref $AnyString`
  // (kind "ref"), so boxToAny used to fall through to the generic `ref →
  // __any_box_ref` arm and box it as a tag-6 OBJECT. That mis-dispatched
  // `__any_add` (any+any with a string operand took the object-ToString /
  // numeric arm instead of string concat). The fix routes a native-string ref
  // to the tag-5 `__any_box_string` path.
  async function runStandalone(src: string): Promise<number> {
    const r = await compile(src, { target: "standalone" });
    expect(r.success, r.success ? "" : `CE: ${JSON.stringify(r.errors)}`).toBe(true);
    expect(WebAssembly.validate(r.binary), "valid Wasm").toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    return (instance.exports as Record<string, () => number>).run();
  }

  it("genuine-any string operands concatenate (inline `as any`)", async () => {
    expect(
      await runStandalone(
        'export function run(): number { const c: any = ("foo" as any) + ("bar" as any); return `${c}`.length; }',
      ),
    ).toBe(6);
  });

  it("genuine-any string operands compare equal to the concatenation", async () => {
    expect(
      await runStandalone(
        'export function run(): number { const c: any = ("foo" as any) + ("bar" as any); return c === "foobar" ? 1 : 0; }',
      ),
    ).toBe(1);
  });

  it("typeof of the concatenation is string (tag-5, not tag-6 object)", async () => {
    expect(
      await runStandalone(
        'export function run(): number { const c: any = ("x" as any) + ("y" as any); return typeof c === "string" ? 1 : 0; }',
      ),
    ).toBe(1);
  });

  it("any-typed (non-narrowed) locals concatenate", async () => {
    // `let`/genuine-any locals are stored as $AnyValue; this also exercises the
    // operand-coercion path through boxToAny when an operand isn't already boxed.
    expect(
      await runStandalone(
        "function id(x: any): any { return x; } export function run(): number { const a: any = id('foo'); const b: any = id('bar'); const c: any = a + b; return `${c}`.length; }",
      ),
    ).toBe(6);
  });

  it("numeric any+any addition is unaffected (control)", async () => {
    expect(
      await runStandalone(
        "function id(x: any): any { return x; } export function run(): number { const a: any = id(2); const b: any = id(3); const c: any = a + b; return c as number; }",
      ),
    ).toBe(5);
  });
});
