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
const PARITY_SOURCES: readonly { name: string; source: string; fileName?: string }[] = [
  {
    name: "an ordinary function target takes NewTarget.prototype",
    source: `
      function NT(): void {}
      export function test(): number {
        function fn(this: any): void { this.o = 1; }
        const r: any = Reflect.construct(fn, [], NT);
        if (Object.getPrototypeOf(r) !== NT.prototype) return 1;
        if (r.o !== 1) return 2;
        return 0;
      }
    `,
  },
  {
    name: "a DataView target takes NewTarget.prototype",
    source: `
      function NT(): void {}
      export function test(): number {
        const buf: any = new ArrayBuffer(8);
        const r: any = Reflect.construct(DataView, [buf], NT);
        if (Object.getPrototypeOf(r) !== NT.prototype) return 1;
        if (r.byteLength !== 8) return 2;
        return 0;
      }
    `,
  },
  {
    // (#3371 review r1, F2) §10.1.14 step 3: a bound function has no own
    // \`prototype\`, so the read yields undefined and the INTRINSIC default must
    // survive. Before the Type(proto)-is-Object gate the raw non-object landed
    // in the DataView window struct and \`getPrototypeOf\` answered undefined.
    name: "a NewTarget without a prototype keeps the intrinsic default",
    source: `
      function Base(): void {}
      const NT: any = Base.bind(null);
      export function test(): number {
        const buf: any = new ArrayBuffer(8);
        const r: any = Reflect.construct(DataView, [buf], NT);
        return Object.getPrototypeOf(r) === DataView.prototype ? 0 : 1;
      }
    `,
  },
  {
    // The r4 version of this probe used an ordinary-function target and an
    // ordinary-function NewTarget; that pair is refused now (review r1, F6), so
    // the getter-propagation property is pinned on the shape the kept
    // `custom-proto-access-throws` rows actually use.
    name: "a throwing NewTarget.prototype getter propagates",
    source: `
      const NT: any = (function (): void {}).bind(null);
      Object.defineProperty(NT, "prototype", {
        get(): any { throw new RangeError("proto"); },
      });
      export function test(): number {
        const buf: any = new ArrayBuffer(8);
        try {
          Reflect.construct(DataView, [buf], NT);
        } catch (e: any) {
          return e instanceof RangeError ? 0 : 1;
        }
        return 2;
      }
    `,
  },
  // ---- r2 (2026-09-05): one pin per admitted step. Each source is a program
  // BASE refused with the `(#3371)` compile error and node answers; the
  // measurement for each is in that step's commit body.
  {
    // r2 step 1. `inner`'s `new.target` is its own, so both node and the
    // compiled module see `undefined` for it; only a read of the TARGET's own
    // `new.target` is unrepresentable.
    name: "r2/1 a nested function's new.target does not refuse the site",
    source: `
      function NT(): void {}
      function F(this: any, a: number): void {
        this.a = a;
        function inner(): any { return new.target; }
        this.b = inner();
      }
      export function test(): number {
        const o: any = Reflect.construct(F, [1], NT);
        if (o.a !== 1) return 1;
        if (Object.getPrototypeOf(o) !== NT.prototype) return 2;
        return o.b === undefined ? 0 : 3;
      }
    `,
  },
  {
    // r2 step 2. Symbol is never constructible, so the site throws before any
    // prototype is used — the one wrapper constructor whose admitted answer was
    // measured to equal node.
    name: "r2/2 a Symbol target throws TypeError, as node does",
    source: `
      function NT(): void {}
      export function test(): number {
        try {
          Reflect.construct(Symbol as any, [], NT);
        } catch (e: any) {
          return e instanceof TypeError ? 0 : 1;
        }
        return 2;
      }
    `,
  },
  {
    // r2 step 3. `helper`'s parameter is a different binding; counting it
    // refused the site.
    name: "r2/3 an unrelated parameter of the same name does not refuse the site",
    source: `
      function NT(): void {}
      function F(this: any, a: number): void { this.a = a; }
      function helper(NT: number): number { return NT; }
      export function test(): number {
        const o: any = Reflect.construct(F, [1], NT);
        if (o.a !== 1) return 1;
        if (Object.getPrototypeOf(o) !== NT.prototype) return 2;
        return helper(3) === 3 ? 0 : 3;
      }
    `,
  },
  {
    // r2 step 4. The slot still holds the plain object the declaration
    // installed; only a write to the SLOT would replace it.
    name: "r2/4 mutating NT.prototype does not refuse the site",
    source: `
      function NT(): void {}
      function F(this: any, a: number): void { this.a = a; }
      NT.prototype.tag = 9;
      export function test(): number {
        const o: any = Reflect.construct(F, [1], NT);
        if (o.a !== 1) return 1;
        if (Object.getPrototypeOf(o) !== NT.prototype) return 2;
        return o.tag === 9 ? 0 : 3;
      }
    `,
  },
  {
    // r2 step 5. A target the compiler cannot resolve to one function
    // declaration does not get the closed-struct lowering, so the generic
    // [[SetPrototypeOf]] reaches it.
    name: "r2/5 a dynamic in-file function target takes the carrier route",
    source: `
      function F(this: any, a: number): void { this.a = a; }
      function G(this: any, a: number): void { this.a = a; }
      function NT(): void {}
      let T = F;
      T = G;
      export function test(): number {
        const o: any = Reflect.construct(T, [1], NT);
        if (o.a !== 1) return 1;
        return Object.getPrototypeOf(o) === NT.prototype ? 0 : 2;
      }
    `,
  },
  // ---- review round 1 (2026-09-06): the ADMITTED half of each finding. The
  // matching refusals are in REFUSED_SOURCES below; measurements are in the
  // issue file's "Review round 1" subsection.
  {
    // R2-1. Every value the binding can hold is an ordinary function
    // declaration, so the dynamic target stays admitted after the value-set
    // gate replaced the initializer-kind gate. Node answers 2 for `r.k`.
    name: "r1/R2-1 a conditionally reassigned all-ordinary-function target stays admitted",
    source: `
      function NT(): void {}
      function F(this: any): void { this.k = 1; }
      function G(this: any): void { this.k = 2; }
      export function test(): number {
        let T = F;
        if (NT.name.length > 0) { T = G; }
        const r: any = Reflect.construct(T, [], NT);
        if (Object.getPrototypeOf(r) !== NT.prototype) return 1;
        return r.k === 2 ? 0 : 2;
      }
    `,
  },
  {
    // R2-3. The same program WITHOUT a type annotation on the binding. The
    // annotated twin is refused (see REFUSED_SOURCES); this one must not be,
    // or the annotation gate has over-refused. Node answers 12.
    name: "r1/R2-3 an unannotated dynamic target with arguments stays admitted",
    source: `
      function NT(): void {}
      function F(this: any, a: number, b: number): void { this.k = a + b; }
      function G(this: any, a: number, b: number): void { this.k = a * b; }
      export function test(): number {
        let T = F;
        T = G;
        const r: any = Reflect.construct(T, [3, 4], NT);
        if (Object.getPrototypeOf(r) !== NT.prototype) return 1;
        return r.k === 12 ? 0 : 2;
      }
    `,
  },
  {
    // R2-4. A nested METHOD has no [[Construct]] at all, so its `new.target`
    // is `undefined` on both sides and the scan may still stop at it. Node
    // answers 1 for `r.o`.
    name: "r1/R2-4 a nested method's new.target does not refuse the site",
    source: `
      function NT(): void {}
      export function test(): number {
        function fn(this: any): void {
          const o: any = { m(): any { return new.target; } };
          this.o = o.m() === undefined ? 1 : 2;
        }
        const r: any = Reflect.construct(fn, [], NT);
        if (Object.getPrototypeOf(r) !== NT.prototype) return 1;
        return r.o === 1 ? 0 : 2;
      }
    `,
  },
  // ---- review round 2 (2026-09-06): the ADMITTED control for each finding.
  // Each is the nearest neighbour of a shape now refused below, and answers
  // what node answers; a fix that refuses these has over-refused.
  {
    // r2/F2 control (`y6_fnexpr_second_value.ts`). The function expression is a
    // LATER value, not the initializer, so the binding keeps the lowering the
    // value-set gate was validated on. Node answers 1 for `r.k`.
    name: "r2/F2 a function expression as a later value stays admitted",
    source: `
      function NT(): void {}
      function G(this: any): void { this.k = 2; }
      export function test(): number {
        let T = G;
        T = function (this: any): void { this.k = 1; };
        const r: any = Reflect.construct(T, [], NT);
        if (Object.getPrototypeOf(r) !== NT.prototype) return 1;
        return r.k === 1 ? 0 : 2;
      }
    `,
  },
  {
    // r2/F3 control (`w9_plain_js.js`). The same `.js` program with NO type
    // annotation, TypeScript or JSDoc. The annotated twins refuse below; this
    // one must not, or the JSDoc clause has over-refused. Node answers 2.
    name: "r2/F3 an unannotated .js dynamic target stays admitted",
    fileName: "issue-3371-r2-w9.js",
    source: `
      function NT() {}
      function F() { this.k = 1; }
      function G() { this.k = 2; }
      /** @returns {number} */
      export function test() {
        let T = F;
        T = G;
        const r = Reflect.construct(T, [], NT);
        if (Object.getPrototypeOf(r) !== NT.prototype) return 1;
        return r.k === 2 ? 0 : 2;
      }
    `,
  },
  {
    // r2 optional scan (`w1_unrelated_param_named_T.ts`). `helper`'s parameter
    // is a DIFFERENT binding spelled `T`; counting its write textually put
    // `T + 1` in the value set and refused the site. Node answers 2 for `r.k`.
    name: "r2 an unrelated parameter named like the target does not refuse the site",
    source: `
      function NT(): void {}
      function F(this: any): void { this.k = 1; }
      function G(this: any): void { this.k = 2; }
      function helper(T: number): number { T = T + 1; return T; }
      export function test(): number {
        let T = F;
        T = G;
        const r: any = Reflect.construct(T, [], NT);
        if (Object.getPrototypeOf(r) !== NT.prototype) return 1;
        if (helper(0) !== 1) return 2;
        return r.k === 2 ? 0 : 3;
      }
    `,
  },
  {
    // r2 optional scan (`v6_shadow_block_write.ts`). Same, for a block-scoped
    // shadow rather than a parameter. Node answers 2 for `r.k`.
    name: "r2 a block-scoped shadow write does not refuse the site",
    source: `
      function NT(): void {}
      function F(this: any): void { this.k = 1; }
      function G(this: any): void { this.k = 2; }
      export function test(): number {
        let T = F;
        T = G;
        { let T: any = 0; T = 7; if (T === 8) return 1; }
        const r: any = Reflect.construct(T, [], NT);
        if (Object.getPrototypeOf(r) !== NT.prototype) return 2;
        return r.k === 2 ? 0 : 3;
      }
    `,
  },
  {
    // r3 (`d2_named_iife_plain.ts`). The G1 refusal added in review round 3 is
    // about a named function expression reaching ITSELF; one that only reads
    // `new.target` and is immediately called still stops the scan, and this row
    // is the control that keeps that arm from being widened into a blanket
    // refusal of every named IIFE. Node answers `r.k === 1`.
    name: "r3 a named IIFE that never mentions its own name stays admitted",
    source: `
      function NT(): void {}
      let seen = 0;
      function F(this: any): void {
        (function inner(): void { seen = new.target === undefined ? 1 : 2; })();
        this.k = seen;
      }
      export function test(): number {
        const r: any = Reflect.construct(F, [], NT);
        if (Object.getPrototypeOf(r) !== NT.prototype) return 2;
        return r.k === 1 ? 0 : 3;
      }
    `,
  },
  {
    // r3 (`c5_ts_with_jsdoc_type.ts`). A JSDoc `@type` in a `.ts` file is inert
    // — TypeScript reads types from syntax there — so this is the same program
    // as the unannotated dynamic-target control and must not be refused for a
    // type it does not have. Node answers `r.k === 2`.
    name: "r3 a JSDoc @type in a .ts source does not count as an annotation",
    source: `
      function NT(): void {}
      function F(this: any): void { this.k = 1; }
      function G(this: any): void { this.k = 2; }
      export function test(): number {
        /** @type {any} */
        let T = F;
        T = G;
        const r: any = Reflect.construct(T, [], NT);
        if (Object.getPrototypeOf(r) !== NT.prototype) return 2;
        return r.k === 2 ? 0 : 3;
      }
    `,
  },
  {
    // r3 (`c7_jsdoc_second_declarator.js`). A statement-level `@type` over
    // several declarators types the FIRST one; attributing the `number` here to
    // `T` refused a program node answers 2 on.
    name: "r3 a JSDoc @type on a sibling declarator is not this binding's type",
    fileName: "issue-3371-r3-c7.js",
    source: `
      function NT() {}
      function F() { this.k = 1; }
      function G() { this.k = 2; }
      /** @returns {number} */
      export function test() {
        /** @type {number} */
        let n = 0, T = F;
        T = G;
        const r = Reflect.construct(T, [], NT);
        if (Object.getPrototypeOf(r) !== NT.prototype) return 2;
        return r.k === 2 && n === 0 ? 0 : 3;
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
    async ({ source, fileName }) => {
      const result = await compile(source, {
        target: "standalone",
        allowJs: true,
        skipSemanticDiagnostics: true,
        fileName: fileName ?? "issue-3371-r4.ts",
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

/**
 * (#3371 review round 1, 2026-09-05) The boundary of the runtime path.
 *
 * Each source below is a program node runs happily and this compiler answered
 * WRONGLY after r4 — a class NewTarget silently ignored, a `new.target` read
 * inside the target seeing `undefined`, a NewTarget expression evaluated out of
 * source order, an `Array` target whose prototype write is a no-op. The
 * sanctioned outcome for an unbounded shape is the ORIGINAL #3371 compile
 * error, never a wrong runtime value, so each is pinned to that refusal on both
 * `standalone` and `wasi`. Delete a pin only together with a measurement
 * showing the shape now answers what node answers.
 */
const REFUSED_SOURCES: readonly { name: string; source: string; fileName?: string }[] = [
  {
    name: "a class NewTarget (its prototype object is not reified in standalone)",
    source: `
      function F(this: any): void { this.v = 5; }
      class C {}
      export function test(): number {
        const o: any = Reflect.construct(F, [], C);
        return Object.getPrototypeOf(o) === C.prototype ? 0 : 1;
      }
    `,
  },
  {
    name: "a class NewTarget reached through a const alias",
    source: `
      function F(this: any): void { this.v = 5; }
      class C {}
      const NT: any = C;
      export function test(): number {
        const o: any = Reflect.construct(F, [], NT);
        return Object.getPrototypeOf(o) === C.prototype ? 0 : 1;
      }
    `,
  },
  {
    name: "a target that reads new.target (there is no NewTarget value carrier)",
    source: `
      function NT(): void {}
      function F(this: any): void { this.nt = new.target === NT ? 0 : 1; }
      export function test(): number {
        return Reflect.construct(F, [], NT).nt;
      }
    `,
  },
  {
    name: "a NewTarget expression that is not a bare identifier (evaluation order)",
    source: `
      function NT(): void {}
      function id(x: any): any { return x; }
      export function test(): number {
        const buf: any = new ArrayBuffer(8);
        const o: any = Reflect.construct(DataView, [buf], id(NT));
        return Object.getPrototypeOf(o) === NT.prototype ? 0 : 1;
      }
    `,
  },
  {
    name: "an Array target (its carrier has no settable prototype)",
    source: `
      function NT(): void {}
      export function test(): number {
        const o: any = Reflect.construct(Array, [3], NT);
        return Object.getPrototypeOf(o) === NT.prototype ? 0 : 1;
      }
    `,
  },
  {
    // r2 step 2. A proto-identity-only probe says the wrapper carriers take the
    // patch; a probe that also reads a method through the patched chain shows
    // dispatch stays nominal (`o.valueOf()` answers the primitive where node
    // answers the wrapper object). Boolean/Number/String keep the refusal.
    name: "r2 a Boolean target (its wrapper dispatch stays nominal)",
    source: `
      function NT(): void {}
      export function test(): number {
        const o: any = Reflect.construct(Boolean as any, [true], NT);
        return Object.getPrototypeOf(o) === NT.prototype ? 0 : 1;
      }
    `,
  },
  {
    // r2 step 5. An async function is not a constructor: node throws a
    // TypeError, the carrier route returned an object.
    name: "r2 an async function target (not a constructor)",
    source: `
      async function A(a: number): Promise<number> { return a; }
      function NT(): void {}
      export function test(): number {
        try {
          Reflect.construct(A as any, [1], NT);
        } catch (e: any) {
          return e instanceof TypeError ? 0 : 1;
        }
        return 2;
      }
    `,
  },
  {
    // r2 step 5. A spread argument list on a dynamic function target TRAPS
    // where node returns a value.
    name: "r2 a spread argument list on a dynamic function target",
    source: `
      function F(this: any, a: number, b: number): void { this.a = a; this.b = b; }
      function G(this: any, a: number, b: number): void { this.a = a; this.b = b; }
      function NT(): void {}
      let T = F;
      T = G;
      const xs: number[] = [1, 2];
      export function test(): number {
        const o: any = Reflect.construct(T, [...xs], NT);
        return Object.getPrototypeOf(o) === NT.prototype ? 0 : 1;
      }
    `,
  },
  {
    // r2 step 3. The compiler's model of a function's `prototype` slot is
    // name-keyed: a slot write to a same-spelled binding in another scope makes
    // the OUTER `NT.prototype` read null, on base as well.
    name: "r2 a prototype-slot write to a same-named binding in another scope",
    source: `
      function F(this: any, a: number): void { this.a = a; }
      function NT(): void {}
      function other(): any {
        const NT: any = function (): void {};
        Object.defineProperty(NT, "prototype", { value: { tag: 1 } });
        return NT;
      }
      export function test(): number {
        other();
        const o: any = Reflect.construct(F, [1], NT);
        return Object.getPrototypeOf(o) === NT.prototype ? 0 : 1;
      }
    `,
  },
  // ---- review round 1 (2026-09-06). Each of these compiled and answered
  // WRONGLY after r4 and refuses now; the node answer is named in the comment.
  {
    // R2-1. The binding's INITIALIZER is an ordinary function, but a later
    // assignment makes it an async function, which is not a constructor: node
    // throws a TypeError, the r4 arm returned an object.
    name: "r1 a dynamic target later assigned an async function",
    source: `
      function NT(): void {}
      function F(this: any): void { this.k = 1; }
      async function A(): Promise<void> {}
      export function test(): number {
        let T = F;
        T = A as any;
        try {
          const r: any = Reflect.construct(T, [], NT);
          return r === undefined ? 8 : 5;
        } catch (e: any) {
          return e instanceof TypeError ? 0 : 9;
        }
      }
    `,
  },
  {
    // R2-2. Same shape reached through a `const` alias — the value-set gate
    // does not follow alias chains, so this refuses rather than resolving.
    name: "r1 a dynamic target assigned an async function through an alias",
    source: `
      function NT(): void {}
      function F(this: any): void { this.k = 1; }
      async function A(): Promise<void> {}
      const A2 = A;
      export function test(): number {
        let T = F;
        T = A2 as any;
        try {
          const r: any = Reflect.construct(T, [], NT);
          return r === undefined ? 8 : 5;
        } catch (e: any) {
          return e instanceof TypeError ? 0 : 9;
        }
      }
    `,
  },
  {
    // R2-2. A bound function target: node answers 2, the r4 arm answered NaN.
    name: "r1 a dynamic target assigned a bound function",
    source: `
      function NT(): void {}
      function F(this: any): void { this.k = 1; }
      function G(this: any): void { this.k = 2; }
      export function test(): number {
        let T = F;
        T = G.bind(null) as any;
        const r: any = Reflect.construct(T, [], NT);
        return Object.getPrototypeOf(r) === NT.prototype ? r.k : 10;
      }
    `,
  },
  {
    // R2-3. The unannotated twin of this program is admitted and equals node
    // (see PARITY_SOURCES); annotated, the r4 arm read a wrong prototype (4
    // where node answers 2) and a following field read trapped.
    name: "r1 an `any`-annotated dynamic function target",
    source: `
      function NT(): void {}
      function F(this: any): void { this.k = 1; }
      function G(this: any): void { this.k = 2; }
      export function test(): number {
        let T: any = F;
        T = G;
        const r: any = Reflect.construct(T, [], NT);
        if (Object.getPrototypeOf(r) !== NT.prototype) return 4;
        return r.k;
      }
    `,
  },
  {
    // R2-4. `inner` is CONSTRUCTED, so it has a `new.target` of its own that
    // the class-id lowering cannot supply: node answers 2, the r4 arm 1.
    name: "r1 a nested function that is itself constructed reads its own new.target",
    source: `
      function NT(): void {}
      export function test(): number {
        function fn(this: any): void {
          function inner(this: any): void { this.q = new.target === undefined ? 1 : 2; }
          this.o = (new (inner as any)()).q;
        }
        const r: any = Reflect.construct(fn, [], NT);
        if (Object.getPrototypeOf(r) !== NT.prototype) return 4;
        return r.o;
      }
    `,
  },
  {
    // R2-5. §15.7.10 [[Call]]s a class field initialiser, so node sees
    // `new.target === undefined` there (answer 1). Measured on this tree,
    // treating field initialisers as owners admits this at 2, so the scan
    // keeps descending into them and the site stays refused.
    name: "r1 a class field initialiser reading new.target inside the target",
    source: `
      function NT(): void {}
      export function test(): number {
        function fn(this: any): void {
          class C { v: any = new.target; }
          this.o = new C().v === undefined ? 1 : 2;
        }
        const r: any = Reflect.construct(fn, [], NT);
        if (Object.getPrototypeOf(r) !== NT.prototype) return 4;
        return r.o;
      }
    `,
  },
  {
    name: "a NewTarget whose prototype was replaced by a descriptor write",
    source: `
      function F(this: any): void { this.v = 5; }
      const P: any = { tag: 7 };
      const NT: any = function (): void {};
      Object.defineProperty(NT, "prototype", { value: P });
      export function test(): number {
        return Object.getPrototypeOf(Reflect.construct(F, [], NT)) === P ? 0 : 1;
      }
    `,
  },
  // ---- review round 2 (2026-09-06). Four shapes the round-1 tree ADMITTED and
  // answered wrongly where base refused with the same `(#3371)` error; node
  // answers 2 in every one. Measurements are in the issue file's "Review round
  // 2" subsection. The admitted controls are in PARITY_SOURCES above.
  {
    // F1 (`y1_dyn_target_reads_nt.ts`). The value-set gate proved each member
    // an ordinary function but never re-ran the `new.target` check on any
    // member body, so a reassigned target whose second value reads
    // `new.target` compiled and answered 1.
    name: "r2 a dynamic target whose value set reads new.target",
    source: `
      function NT(): void {}
      function F(this: any): void { this.k = 1; }
      function G(this: any): void { this.k = new.target === undefined ? 1 : 2; }
      export function test(): number {
        let T = F;
        T = G;
        const r: any = Reflect.construct(T, [], NT);
        if (Object.getPrototypeOf(r) !== NT.prototype) return 4;
        return r.k;
      }
    `,
  },
  {
    // F2 (`y3_dyn_fnexpr_init.ts`). A function EXPRESSION in the INITIALIZER
    // position gives the binding a callee lowering that drops the fetched
    // prototype: the compiled module took the `!== NT.prototype` branch (4).
    name: "r2 a dynamic target whose initializer is a function expression",
    source: `
      function NT(): void {}
      function G(this: any): void { this.k = 2; }
      export function test(): number {
        let T = function (this: any): void { this.k = 1; };
        T = G;
        const r: any = Reflect.construct(T, [], NT);
        if (Object.getPrototypeOf(r) !== NT.prototype) return 4;
        return r.k;
      }
    `,
  },
  {
    // F3 (`w8_jsdoc_js.js`). The annotation refusal was spelled as
    // `declaration.type`, which a JSDoc `@type` in a `.js` file does not set,
    // so the JSDoc twin of the already-refused `let T: any = F` slipped
    // through and answered 4.
    name: "r2 a JSDoc-annotated dynamic target in a .js source",
    fileName: "issue-3371-r2-w8.js",
    source: `
      function NT() {}
      function F() { this.k = 1; }
      function G() { this.k = 2; }
      /** @returns {number} */
      export function test() {
        /** @type {any} */
        let T = F;
        T = G;
        const r = Reflect.construct(T, [], NT);
        if (Object.getPrototypeOf(r) !== NT.prototype) return 4;
        return r.k;
      }
    `,
  },
  {
    // F4 (`c1_namedfnexpr_ctor.ts`). `neverConstructed` called a NAMED function
    // EXPRESSION unconstructible because its own name never escapes — but it is
    // reached through the variable it is assigned to, so the nested
    // `new.target` read went uncounted and the site answered 1.
    name: "r2 a constructed named function expression inside the target",
    source: `
      function NT(): void {}
      export function test(): number {
        function fn(this: any): void {
          const q = function inner(this: any): void { this.q = new.target === undefined ? 1 : 2; };
          this.o = (new (q as any)()).q;
        }
        const r: any = Reflect.construct(fn, [], NT);
        if (Object.getPrototypeOf(r) !== NT.prototype) return 4;
        return r.o;
      }
    `,
  },
  {
    // G1 (`d1_named_iife_selfnew.ts`). A named function EXPRESSION binds its
    // own name inside its own body, so an immediate call does not make it
    // unconstructible: `new inner(0)` reaches it, its `new.target` read is a
    // real read, and the site answered 0 where node answers 2.
    name: "r3 a named IIFE that constructs itself by name inside the target",
    source: `
      function NT(): void {}
      let seen = 0;
      function F(this: any): void {
        (function inner(this: any, n: number): any {
          if (n) { new (inner as any)(0); return; }
          seen = new.target === undefined ? 1 : 2;
        })(1);
        this.k = seen;
      }
      export function test(): number {
        const r: any = Reflect.construct(F, [], NT);
        if (Object.getPrototypeOf(r) !== NT.prototype) return 4;
        return r.k;
      }
    `,
  },
  {
    // G2 (`f1d_shorthand_destr_arrow2.ts`). A destructuring SHORTHAND resolves
    // to the object-literal property, not to the binding it writes, so the
    // symbol-resolved write scan dropped it: the value set collapsed to `F`,
    // the arrow that `src.T` actually holds was never seen, and the site
    // answered 1 where node throws a TypeError.
    name: "r3 a shorthand-destructuring write to a dynamic target",
    source: `
      function NT(): void {}
      function F(this: any): void { this.k = 1; }
      const src: any = { T: (): void => {} };
      let T = F;
      export function test(): number {
        ({ T } = src);
        const r: any = Reflect.construct(T, [], NT);
        return Object.getPrototypeOf(r) === NT.prototype ? 1 : 4;
      }
    `,
  },
  {
    // G2, the defaulted twin (`f1h_shorthand_default.ts`): `{ T = 42 }` writes
    // the binding too, and answered 1 where node throws.
    name: "r3 a defaulted shorthand-destructuring write to a dynamic target",
    source: `
      function NT(): void {}
      function F(this: any): void { this.k = 1; }
      const src: any = {};
      let T = F;
      export function test(): number {
        ({ T = 42 as any } = src);
        const r: any = Reflect.construct(T, [], NT);
        return Object.getPrototypeOf(r) === NT.prototype ? 1 : 4;
      }
    `,
  },
];

describe.each(["standalone", "wasi"] as const)("#3371 review r1 — refusals kept (%s)", (target) => {
  it.each(REFUSED_SOURCES)(
    "refuses $name",
    async ({ source, fileName }) => {
      const result = await compile(source, {
        target,
        allowJs: true,
        skipSemanticDiagnostics: true,
        fileName: fileName ?? "issue-3371-r4-refused.ts",
      });
      const errors = (result.errors ?? []).filter((e) => e.severity === "error");
      expect(errors.map((e) => e.message).join("\n")).toContain("(#3371)");
    },
    ROW_TIMEOUT,
  );
});
