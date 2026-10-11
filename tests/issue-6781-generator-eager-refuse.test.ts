/**
 * #6781 — a `.throw()` / `.return()` on a generator that only the EAGER host
 * buffer can lower is a compile error, not a silent miscompile.
 *
 * The eager lowering (#1687) runs the whole body when the generator is created
 * and buffers the yields. That is fine for the `next()` value sequence, but an
 * abrupt resumption has no live suspension to land in: a `catch` around the
 * suspended `yield` never sees `.throw()`'s value, and a `finally` around it has
 * already run before `.return()`. Before this change all three refused probes
 * below compiled and ran differently from Node; the
 * "still compiles" probes pin what the gate must NOT refuse.
 *
 * JS-host lane only (the default target), like #3587's async refusal.
 */
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const DIAG = "generator-eager-unsupported";

async function compileSrc(src: string) {
  return compile(src, { fileName: "test.ts" });
}

async function runWasm(src: string): Promise<unknown> {
  const r = await compileSrc(src);
  if (!r.success) throw new Error(r.errors.map((e) => e.message).join(" | "));
  const imports = buildImports(r.imports, undefined, r.stringPool) as Record<string, unknown> & {
    setExports?: (e: unknown) => void;
    setInstance?: (i: unknown) => void;
  };
  const { instance } = await WebAssembly.instantiate(r.binary, imports as WebAssembly.Imports);
  imports.setInstance?.(instance);
  imports.setExports?.(instance.exports);
  return (instance.exports as { run(): unknown }).run();
}

/** The same program under Node (type-stripped), for parity assertions. */
function runJs(src: string): unknown {
  const js = ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports: { run?: () => unknown } = {};
  new Function("exports", "module", js)(exports, { exports });
  return exports.run!();
}

async function expectRefused(src: string, method: "throw" | "return", generatorName: string): Promise<void> {
  const r = await compileSrc(src);
  expect(r.success).toBe(false);
  const diag = r.errors.find((e) => e.message.includes(DIAG));
  expect(diag, r.errors.map((e) => e.message).join(" | ")).toBeDefined();
  expect(diag!.message).toContain(`.${method}() on generator \`${generatorName}\``);
  expect(diag!.message).toContain("#1687");
}

async function expectNodeParity(src: string): Promise<void> {
  const r = await compileSrc(src);
  expect(r.errors.filter((e) => e.message.includes(DIAG))).toEqual([]);
  expect(await runWasm(src)).toEqual(runJs(src));
}

describe("#6781 — refused: abrupt resumption of an eager-only generator", () => {
  it("probe 1: .throw() into the generator's own catch (result escapes to JSON.stringify)", async () => {
    // Before: `boom` escaped `.throw()` uncaught. Node: caught:boom, then {value:2}.
    await expectRefused(
      `
      const log: string[] = [];
      function* g() {
        try { yield 1; } catch (e) { log.push("caught:" + e); }
        yield 2;
      }
      export function run(): string {
        const it = g();
        it.next();
        const r = it.throw("boom");
        log.push(JSON.stringify(r));
        return log.join("|");
      }`,
      "throw",
      "g",
    );
  });

  it("probe 2: .return() before the first next() — body and finally ran at creation", async () => {
    // Before: "102;102;…". Node: "0;0;{value:7,done:true}".
    await expectRefused(
      `
      let created = 0;
      function* g(): Generator<number, any, any> {
        created = 100;
        try { yield 1; } finally { created += 2; }
      }
      export function run(): string {
        const it = g();
        const before = created;
        const r = it.return(7);
        return before + ";" + created + ";" + JSON.stringify(r);
      }`,
      "return",
      "g",
    );
  });

  it("probe 3: .throw() through a try/finally — the finally ran before the first next()", async () => {
    // Before: "finally,created,…". Node: "created,{…},finally,caught:boom".
    await expectRefused(
      `
      const log: string[] = [];
      function* g() {
        try { yield 1; } finally { log.push("finally"); }
      }
      export function run(): string {
        const it = g();
        log.push("created");
        try {
          log.push(JSON.stringify(it.next()));
          it.throw(new Error("boom"));
        } catch (e) {
          log.push("caught:" + (e as Error).message);
        }
        return log.join(",");
      }`,
      "throw",
      "g",
    );
  });

  it("a class generator METHOD (always eager in the JS-host lane)", async () => {
    // Before: the Error escaped run(). Node: "1,true,99".
    await expectRefused(
      `
      const log: number[] = [];
      class Box {
        *items() {
          try { yield 1; yield 2; } catch (e) { log.push(99); }
        }
      }
      export function run(): string {
        const it = new Box().items();
        const a = it.next();
        const r = it.throw(new Error("boom"));
        return [a.value, r.done, log.join("+")].join(",");
      }`,
      "throw",
      "items",
    );
  });

  it("a generator FUNCTION EXPRESSION bound to a const", async () => {
    // Before: "1,1,5,true,1" (finally ran at the first next()). Node: "1,0,5,true,1".
    await expectRefused(
      `
      const log: number[] = [];
      const gen = function* (): Generator<number, any, any> {
        try { yield 1; yield 2; } finally { log.push(7); }
      };
      export function run(): string {
        const it = gen();
        const a = it.next();
        const before = log.length;
        const r = it.return(5);
        return [a.value, before, r.value, r.done, log.length].join(",");
      }`,
      "return",
      "gen",
    );
  });

  it(".return() after exhaustion is refused too — exhaustion is not provable statically", async () => {
    // Decision: an explicit .return() cannot be shown to run only after the
    // buffer drained, so a guarded-yield eager generator is refused regardless.
    // (`sink.push(it)` lets the instance escape, which keeps it on the eager path.)
    await expectRefused(
      `
      const sink: any[] = [];
      function* g(): Generator<number, any, any> {
        try { yield 1; } finally { sink.push(0); }
      }
      export function run(): number {
        const it = g();
        sink.push(it);
        while (!it.next().done) {}
        return it.return(5).value;
      }`,
      "return",
      "g",
    );
  });
});

describe("#6781 — not refused", () => {
  it("the same try/catch + .throw() shape when the lazy lowering claims it (results read via .value/.done)", async () => {
    await expectNodeParity(`
      const log: string[] = [];
      function* g() {
        try { yield 1; } catch (e) { log.push("caught:" + e); }
        yield 2;
      }
      export function run(): string {
        const it = g();
        it.next();
        const r = it.throw("boom");
        log.push(String(r.value) + "," + String(r.done));
        return log.join("|");
      }`);
  });

  it("lazy .return() runs the finally at the right time", async () => {
    await expectNodeParity(`
      const ev: number[] = [];
      function* g(): Generator<number, any, any> {
        try { yield 1; yield 2; } finally { ev.push(7); }
      }
      export function run(): string {
        const it = g();
        const a = it.next().value;
        const before = ev.length;
        const r = it.return(5);
        return [a, before, r.value, r.done, ev.length].join(",");
      }`);
  });

  it("next()-only consumption: manual next loop, finally timing", async () => {
    await expectNodeParity(`
      const ev: number[] = [];
      function* g() {
        ev.push(1);
        try { yield 10; yield 20; } finally { ev.push(2); }
        ev.push(3);
      }
      export function run(): string {
        const out: number[] = [];
        const it = g();
        out.push(ev.length);
        let r = it.next();
        while (!r.done) {
          out.push(r.value as number);
          out.push(ev.length);
          r = it.next();
        }
        out.push(ev.length);
        return out.join(",") + "|" + ev.join(",");
      }`);
  });

  it("next()-only consumption: for-of, spread and Array.from", async () => {
    await expectNodeParity(`
      function* g() {
        try { yield 1; yield 2; } finally { }
        yield 3;
      }
      export function run(): string {
        let s = 0;
        for (const v of g()) s = s * 10 + v;
        return [s, [...g()].join("+"), Array.from(g()).join("-")].join(",");
      }`);
  });

  it("an eager generator with a guarded yield that is only ever next()-ed", async () => {
    // JSON.stringify(result) keeps it eager; the value sequence is still right.
    // (Creation-time side effects of the eager path are #1687's, not this gate's.)
    const src = `
      function* g() {
        try { yield 1; yield 2; } finally { }
      }
      export function run(): string {
        const it = g();
        return [JSON.stringify(it.next()), JSON.stringify(it.next()), JSON.stringify(it.next())].join(",");
      }`;
    await expectNodeParity(src);
  });

  it("an eager generator WITHOUT a guarded yield: .return() mid-way drops the body's deferred throw", async () => {
    // Before the runtime fix: the eager body's later throw ("late") still
    // surfaced on the next() after .return(5). Node: {"done":true}.
    await expectNodeParity(`
      function* g(): Generator<number, any, any> {
        yield 1;
        throw new Error("late");
      }
      export function run(): string {
        const out: string[] = [];
        const it = g();
        try {
          out.push(JSON.stringify(it.next()));
          out.push(JSON.stringify(it.return(5)));
          out.push(JSON.stringify(it.next()));
        } catch (e) {
          out.push("caught:" + (e as Error).message);
        }
        return out.join(",");
      }`);
  });

  it("an eager generator WITHOUT a guarded yield: next() after .throw() is {undefined, done}, not the body's return value", async () => {
    await expectNodeParity(`
      function* g(): Generator<number, any, any> {
        yield 1;
        return 42;
      }
      export function run(): string {
        const out: string[] = [];
        const it = g();
        out.push(JSON.stringify(it.next()));
        try {
          it.throw(new Error("x"));
        } catch (e) {
          out.push("caught:" + (e as Error).message);
        }
        out.push(JSON.stringify(it.next()));
        return out.join(",");
      }`);
  });

  it("an instance the scan cannot trace (a parameter) is not refused — documented residual", async () => {
    const r = await compileSrc(`
      function* g() {
        try { yield 1; } catch (e) { }
      }
      function drive(it: Generator<number>): void {
        it.next();
        it.throw(new Error("x"));
      }
      export function run(): number {
        drive(g());
        return 1;
      }`);
    expect(r.errors.filter((e) => e.message.includes(DIAG))).toEqual([]);
  });
});
