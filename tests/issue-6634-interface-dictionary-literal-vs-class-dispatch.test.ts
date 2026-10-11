// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6634 (#5383 S48, root cause of #6633's S47 findings) — a NAMED INTERFACE's
// own Wasm carrier is chosen from whichever implementer's struct
// `collectInterface` happens to synthesize (an object-literal-compatible
// struct: each method becomes a mutable externref "closure slot" field). A
// CLASS implementing the same interface never physically matches that
// layout — its instances are a real class struct dispatched through the
// class's own method machinery, not a per-instance closure field. So a value
// that is ACTUALLY a class instance, flowing through an interface-typed slot
// (a function return, a `Record<string, Iface>` read, a parameter), fails
// the interface struct's own `ref.test`/`ref.cast` guard and silently
// becomes null:
//
//  - repro13 shape: a `Record<string, Iface>` holding BOTH a literal and a
//    class instance always answered the LITERAL for every key, because the
//    interface's carrier (and the call-site devirtualization guess in
//    `call-receiver-method.ts`) was hardcoded to the literal's struct — the
//    class instance nulls out, and its method happens not to read `this`, so
//    it silently runs the WRONG method instead of trapping.
//  - repro9 shape: a SOLE class implementer nulls out the same way, but the
//    null is wrapped in `ref.as_non_null` by the surrounding coercion — a
//    "dereferencing a null pointer" trap, even with no literal in sight.
//
// Fix: `src/codegen/interface-class-implementer.ts` —
// `interfaceHasClassImplementer(ctx, name)` (memoized: does any known class
// declare `implements <name>`?), consulted by both `resolveWasmType`'s two
// struct-name lookups (`index.ts`) and `resolveStructName`
// (`property-access.ts`). Once any class implements the interface, its
// carrier is externref, not the literal-shaped struct — so the EXISTING
// dynamic-receiver dispatch (which already handles arbitrary externref
// receivers) discriminates by the receiver's ACTUAL runtime type at each
// call, instead of the compiler hardcoding one implementer at compile time.
//
// Standalone only — `--target standalone`'s WasmGC struct carriers are what
// this defect is about; the JS-host/gc lane represents interface-typed
// values as plain host objects and never hits this struct-carrier choice.
import { describe, expect, it } from "vitest";
import { compileMulti, instantiateLinkedProject } from "../src/index.js";

const STANDALONE = { target: "standalone" as const, hostBridge: "off" as const };

async function run(body: string, fns: string[]): Promise<Record<string, unknown>> {
  const result = await compileMulti({ "/__main.js": body }, "/__main.js", {
    allowJs: true,
    skipSemanticDiagnostics: true,
    ...STANDALONE,
  } as never);
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await instantiateLinkedProject(result, {});
  const exports = instance.exports as unknown as Record<string, () => unknown>;
  const out: Record<string, unknown> = {};
  for (const name of fns) out[name] = exports[name]!();
  return out;
}

describe("#6634 — interface carrier must not alias to one implementer's struct when another exists", () => {
  it("fix-witness (repro13 shape): a Record<string, Iface> holding both a literal and a class instance dispatches each key to its OWN implementer (base tree: both keys answered the class)", async () => {
    const out = await run(
      `
      interface CalImpl {
        isoToDate(req: Record<string, boolean>): any;
      }
      class NonIsoCalendar implements CalImpl {
        isoToDate(req: Record<string, boolean>): any {
          return { era: "x", year: 1 };
        }
      }
      const impl: Record<string, CalImpl> = {};
      impl["iso8601"] = {
        isoToDate(requestedFields: Record<string, boolean>): any {
          return { era: undefined, year: 999 };
        },
      };
      impl["gregory"] = new NonIsoCalendar();
      function getCalendar(id: string): CalImpl {
        return impl[id];
      }
      export function probeLiteralYear() {
        const t = "era";
        return getCalendar("iso8601").isoToDate({ [t]: true }).year;
      }
      export function probeLiteralEraTypeofUndefined() {
        const t = "era";
        const res = getCalendar("iso8601").isoToDate({ [t]: true });
        return typeof res[t] === "undefined" ? 1 : 0;
      }
      export function probeClassYear() {
        const t = "era";
        return getCalendar("gregory").isoToDate({ [t]: true }).year;
      }
      export function probeClassEraTypeofString() {
        const t = "era";
        const res = getCalendar("gregory").isoToDate({ [t]: true });
        return typeof res[t] === "string" ? 1 : 0;
      }
      `,
      ["probeLiteralYear", "probeLiteralEraTypeofUndefined", "probeClassYear", "probeClassEraTypeofString"],
    );
    expect(out.probeLiteralYear).toBe(999);
    expect(out.probeLiteralEraTypeofUndefined).toBe(1);
    expect(out.probeClassYear).toBe(1);
    expect(out.probeClassEraTypeofString).toBe(1);
  });

  it("fix-witness (repro9 shape): a SOLE class implementer reached through a function return does not null out (base tree: dereferencing a null pointer)", async () => {
    const out = await run(
      `
      interface Cal {
        isoToDate(): any;
      }
      class Iso8601 implements Cal {
        isoToDate(): any {
          return 42;
        }
      }
      function getCalendar(): Cal {
        return new Iso8601();
      }
      export function probe() {
        const cal = getCalendar();
        return cal.isoToDate();
      }
      `,
      ["probe"],
    );
    expect(out.probe).toBe(42);
  });

  it("fix-witness (three-implementer variant): two classes + one literal, each key answers its OWN implementer", async () => {
    const out = await run(
      `
      interface Shape {
        area(): number;
      }
      class Square implements Shape {
        side: number;
        constructor(side: number) { this.side = side; }
        area(): number { return this.side * this.side; }
      }
      class Circle implements Shape {
        radius: number;
        constructor(radius: number) { this.radius = radius; }
        area(): number { return 3 * this.radius * this.radius; } // avoid Math.PI float compare
      }
      const shapes: Record<string, Shape> = {};
      shapes["square"] = new Square(4);
      shapes["circle"] = new Circle(2);
      shapes["flat"] = { area() { return 0; } };
      function getShape(id: string): Shape {
        return shapes[id];
      }
      export function probeSquare() { return getShape("square").area(); }
      export function probeCircle() { return getShape("circle").area(); }
      export function probeFlat() { return getShape("flat").area(); }
      `,
      ["probeSquare", "probeCircle", "probeFlat"],
    );
    expect(out.probeSquare).toBe(16);
    expect(out.probeCircle).toBe(12);
    expect(out.probeFlat).toBe(0);
  });

  it("fix-witness: an interface implemented ONLY by a class (no literal in sight, single implementer, a DIFFERENT interface name) also traps on base — the same struct-carrier defect fires whenever the interface's OWN synthesized struct is used, not only when a literal coexists", async () => {
    const out = await run(
      `
      interface Greeter {
        greet(): string;
      }
      class English implements Greeter {
        greet(): string { return "hello"; }
      }
      function getGreeter(): Greeter {
        return new English();
      }
      export function probe() {
        return getGreeter().greet().length;
      }
      `,
      ["probe"],
    );
    expect(out.probe).toBe(5); // "hello".length
  });

  it("control: an interface implemented ONLY by object literals is unaffected", async () => {
    const out = await run(
      `
      interface Greeter {
        greet(): string;
      }
      const impl: Record<string, Greeter> = {};
      impl["en"] = { greet() { return "hi"; } };
      function getGreeter(id: string): Greeter {
        return impl[id];
      }
      export function probe() {
        return getGreeter("en").greet().length;
      }
      `,
      ["probe"],
    );
    expect(out.probe).toBe(2); // "hi".length
  });

  it("control: a direct `new C().m()` call on the class itself is unaffected by the interface guard", async () => {
    const out = await run(
      `
      interface CalImpl {
        isoToDate(): any;
      }
      class NonIsoCalendar implements CalImpl {
        isoToDate(): any { return { year: 1 }; }
      }
      export function probe() {
        return new NonIsoCalendar().isoToDate().year;
      }
      `,
      ["probe"],
    );
    expect(out.probe).toBe(1);
  });

  // ── S49 (#6634 residual): DESTRUCTURED-PARAMETER method + class implementer ──
  //
  // S48b reduced a NEW trap this same carrier fix exposed: an interface method
  // whose parameter is DESTRUCTURED (`compute({year, month, day})`) implemented
  // by an OBJECT LITERAL, plus an uncalled CLASS implementer of the same
  // interface anywhere in the program. Both ingredients are required (repro16
  // below — same shape, no class implementer — already passed before S49).
  //
  // The receiver-side #6634 fix correctly forces the call through the
  // closed-method dispatcher's runtime `ref.test` cascade (the call site can't
  // know statically which implementer answers). But the destructured-parameter
  // OBJECT ARGUMENT is compiled generically as the open `$Object` carrier
  // (`compileInternalCallArgument`'s deliberate externref-expected-type
  // widening for object literals) — and every dispatcher arm then
  // unconditionally `ref.cast`s that `$Object` to its own candidate's CLOSED
  // struct, which it never inhabits. Wasm TRAP ("illegal cast"), regardless of
  // which arm runs, on an otherwise well-typed call.
  //
  // Fix: `src/codegen/extern-arg-marshal.ts`'s
  // `ensureStructFromObjectCoercionHelper` — a per-typeIdx marshal consulted
  // ONLY by `closed-method-dispatch.ts`'s arms for a (methodName, arity)
  // dispatcher whose candidates MIX a class implementer with a non-class one
  // (`buildEntryArm`'s `allowObjectCoercion` flag). It `ref.test`s the fast
  // already-closed-struct path first (byte-identical to before), and only for
  // a genuine mismatch reads the target struct's fields generically off the
  // externref value via `__extern_get` + `struct.new` — the same "reach a
  // field the checker could not name" idea as #5187's `carrierNameForAccess`.
  it("control (repro16 shape): the SAME destructured-parameter object-literal method, with NO class implementer at all, is unaffected (already passed before S49)", async () => {
    const out = await run(
      `
      interface Calc {
        compute(fields: { year: number; month: number; day: number }): number;
      }
      const impl: Record<string, Calc> = {};
      impl["a"] = {
        compute({ year, month, day }: { year: number; month: number; day: number }): number {
          return year + month + day;
        },
      };
      function getCalc(id: string): Calc {
        return impl[id];
      }
      export function probe() {
        const c = getCalc("a");
        return c.compute({ year: 1976, month: 11, day: 18 });
      }
      `,
      ["probe"],
    );
    expect(out.probe).toBe(2005);
  });

  it("fix-witness (repro17 shape): a destructured-parameter object-literal method PLUS an UNCALLED class implementer of the same interface (base tree: TRAP illegal cast)", async () => {
    const out = await run(
      `
      interface Calc {
        compute(fields: { year: number; month: number; day: number }): number;
      }
      class ClassCalc implements Calc {
        compute(fields: { year: number; month: number; day: number }): number {
          return fields.year * 100;
        }
      }
      function keepAlive(): Calc {
        return new ClassCalc();
      }
      const impl: Record<string, Calc> = {};
      impl["a"] = {
        compute({ year, month, day }: { year: number; month: number; day: number }): number {
          return year + month + day;
        },
      };
      function getCalc(id: string): Calc {
        return impl[id];
      }
      export function probe() {
        const c = getCalc("a");
        return c.compute({ year: 1976, month: 11, day: 18 });
      }
      export function probeKeepAliveNotNull() {
        return keepAlive() !== null && keepAlive() !== undefined ? 1 : 0;
      }
      `,
      ["probe", "probeKeepAliveNotNull"],
    );
    expect(out.probe).toBe(2005);
    expect(out.probeKeepAliveNotNull).toBe(1);
  });

  it("fix-witness (repro17 variant, class implementer CALLED too): the class arm ALSO answers correctly through the same dispatcher (base tree: TRAP illegal cast)", async () => {
    const out = await run(
      `
      interface Calc {
        compute(fields: { year: number; month: number; day: number }): number;
      }
      class ClassCalc implements Calc {
        compute(fields: { year: number; month: number; day: number }): number {
          return fields.year * 100 + fields.month * 10 + fields.day;
        }
      }
      const impl: Record<string, Calc> = {};
      impl["lit"] = {
        compute({ year, month, day }: { year: number; month: number; day: number }): number {
          return year + month + day;
        },
      };
      impl["cls"] = new ClassCalc();
      function getCalc(id: string): Calc {
        return impl[id];
      }
      export function probeLiteral() {
        return getCalc("lit").compute({ year: 1976, month: 11, day: 18 });
      }
      export function probeClass() {
        return getCalc("cls").compute({ year: 5, month: 3, day: 2 });
      }
      `,
      ["probeLiteral", "probeClass"],
    );
    expect(out.probeLiteral).toBe(2005);
    expect(out.probeClass).toBe(532);
  });

  it("fix-witness (2-param destructured variant): two destructured-object parameters, class implementer present but uncalled (base tree: TRAP illegal cast)", async () => {
    const out = await run(
      `
      interface Merger {
        merge(a: { x: number; y: number }, b: { x: number; y: number }): number;
      }
      class ClassMerger implements Merger {
        merge(a: { x: number; y: number }, b: { x: number; y: number }): number {
          return a.x + b.x;
        }
      }
      function keepAlive(): Merger {
        return new ClassMerger();
      }
      const impl: Record<string, Merger> = {};
      impl["a"] = {
        merge({ x: x1, y: y1 }: { x: number; y: number }, { x: x2, y: y2 }: { x: number; y: number }): number {
          return x1 + y1 + x2 + y2;
        },
      };
      function getMerger(id: string): Merger {
        return impl[id];
      }
      export function probe() {
        const m = getMerger("a");
        return m.merge({ x: 1, y: 2 }, { x: 30, y: 40 });
      }
      export function probeKeepAliveNotNull() {
        return keepAlive() !== null && keepAlive() !== undefined ? 1 : 0;
      }
      `,
      ["probe", "probeKeepAliveNotNull"],
    );
    expect(out.probe).toBe(73);
    expect(out.probeKeepAliveNotNull).toBe(1);
  });
});
