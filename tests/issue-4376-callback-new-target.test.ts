import { expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string): Promise<number> {
  const result = await compile(source, { target: "standalone", platform: "deno", hostBridge: "off" });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(result.binary)), {});
  return (instance.exports.run as () => number)();
}

it("rejects construction in a dynamic rest callback without entering the host", async () => {
  expect(
    await run(`
    let entered=0;
    function make():any { return function(...args:any[]):any {
      if(new.target) throw new TypeError("cannot construct host callback");
      entered++; return 7;
    }; }
    function exercise(host:any):number {
      let rejected=false;
      try { new host(); } catch(error) {
        rejected=error instanceof TypeError && error.message==="cannot construct host callback";
      }
      return rejected && entered===0 && host()===7 && entered===1 ? 1 : -1;
    }
    export function run():number { return exercise(make()); }
  `),
  ).toBe(1);
});

it("returns the actual dynamic constructor as new.target", async () => {
  expect(
    await run(`
    function make():any { return function():any { return new.target; }; }
    function construct(C:any):any { return new C(); }
    export function run():number {
      const C:any=make(); return construct(C)===C && C()===undefined ? 1 : -1;
    }
  `),
  ).toBe(1);
});

it("keeps lexical new.target in an escaping arrow but clears it in ordinary nested calls", async () => {
  expect(
    await run(`
    function make():any { return function():any {
      const ordinary:any=function():any { return new.target; };
      if(ordinary()!==undefined) throw new Error("leaked target");
      return ()=>new.target;
    }; }
    function construct(C:any):any { return new C(); }
    export function run():number { const C:any=make(); const arrow:any=construct(C); return arrow()===C ? 1 : -1; }
  `),
  ).toBe(1);
});

it("does not retain construction state after a thrown callback", async () => {
  expect(
    await run(`
    const marker:any={value:17};
    function make():any { return function():any { if(new.target) throw marker; return new.target; }; }
    function exercise(C:any):number {
      let caught=false; try { new C(); } catch(error) { caught=error===marker; }
      return caught && C()===undefined ? 1 : -1;
    }
    export function run():number { return exercise(make()); }
  `),
  ).toBe(1);
});

it("binds construction state before parameter defaults", async () => {
  expect(
    await run(`
    function make():any { return function(target:any=new.target):any { return target; }; }
    function construct(C:any):any { return new C(); }
    export function run():number { const C:any=make(); return construct(C)===C ? 1 : -1; }
  `),
  ).toBe(1);
});

it("preserves new.target through a runtime-sized constructor argument vector", async () => {
  expect(
    await run(`
    function make():any { return function(...args:any[]):any { return {target:new.target,count:args.length,last:args[8]}; }; }
    function construct(C:any,args:any):any { return new C(...args); }
    export function run():number {
      const C:any=make(); const value:any=construct(C,[1,2,3,4,5,6,7,8,9]);
      return value.target===C && value.count===9 && value.last===9 ? 1 : -1;
    }
  `),
  ).toBe(1);
});

it.each([false, true])(
  "keeps non-rest array formals out of the full-vector rest shortcut (reversed=%s)",
  async (reversed) => {
    const rest = "function(...args:any[]):any { return args.length; }";
    const array = "function(args:any[]=[]):any { return args[0]; }";
    expect(
      await run(`
    const callbacks:any[]=[${reversed ? `${array},${rest}` : `${rest},${array}`}];
    function call(fn:any,args:any):any { return fn.apply(null,args); }
    export function run():number {
      return (call(callbacks[${reversed ? 1 : 0}],[1,2,3,4,5,6,7,8,9])===9 ? 1 : 0) +
        (call(callbacks[${reversed ? 0 : 1}],[[42]])===42 ? 2 : 0);
    }
  `),
    ).toBe(3);
  },
);

it("preserves receivers and thrown identity in full-vector rest calls", async () => {
  expect(
    await run(`
    const marker:any={value:17};
    const callbacks:any[]=[function(this:any,...args:any[]):any {
      if(args[8]===0) throw marker;
      return this.value+args.length+args[8];
    }];
    function call(fn:any,receiver:any,args:any):any { return fn.apply(receiver,args); }
    export function run():number {
      let caught=false;
      try { call(callbacks[0],{value:99},[1,2,3,4,5,6,7,8,0]); }
      catch(error) { caught=error===marker; }
      return caught && call(callbacks[0],{value:24},[1,2,3,4,5,6,7,8,9])===42 ? 1 : -1;
    }
  `),
  ).toBe(1);
});

// A materialized `arguments` forwarder selects the native apply bridge. The
// observed opaque spread also reserves its real argument-index reader.
const hostForwarder = `
  function forward(receiver:any, first:any, b:any, c:any, d:any, e:any, f:any, g:any, h:any, last:any):any {
    return callback.apply(receiver, arguments as any);
  }
  export function spread(fn:any, args:any):any { return fn(...args); }
`;
async function hostRest(source: string, foreign?: () => void) {
  const result = await compile(source, { emitWat: true, deferTopLevelInit: true });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  expect(result.errors.filter((error) => error.severity === "error")).toEqual([]);
  expect(WebAssembly.validate(new Uint8Array(result.binary))).toBe(true);
  const start = result.wat.indexOf("(func $__apply_closure ");
  expect(start).toBeGreaterThanOrEqual(0);
  const next = result.wat.indexOf("\n  (func ", start + 1);
  const apply = result.wat.slice(start, next < 0 ? undefined : next);
  expect(apply).toContain("__rest_apply_array");
  expect(apply).toContain("call_ref");
  expect(apply).toMatch(/\(try\b/);
  expect(apply).not.toContain("try_table");
  const taggedRestore = apply.match(
    /\(catch \d+\s+local\.set (\d+)\s+local\.get (\d+)\s+global\.set (\d+)\s+local\.get \1\s+throw \d+/,
  );
  expect(taggedRestore).not.toBeNull();
  if (!taggedRestore) throw new Error("missing tagged rest receiver restoration");
  const previous = taggedRestore[2],
    receiver = taggedRestore[3];
  expect(apply).toMatch(new RegExp(`global\\.get ${receiver}\\s+local\\.set ${previous}`));
  expect(apply).toMatch(new RegExp(`\\(catch_all\\s+local\\.get ${previous}\\s+global\\.set ${receiver}\\s+rethrow 0`));
  const imports = buildImports(result.imports, undefined, result.stringPool);
  if (foreign) {
    expect(result.imports.some((entry) => entry.module === "env" && entry.name === "console_log_number")).toBe(true);
    imports.env.console_log_number = foreign;
  }
  const {
    setInstance,
    setExports,
    startImportCounting: _startImportCounting,
    takeImportCounts: _takeImportCounts,
    ...wasmImports
  } = imports;
  const instance = new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(result.binary)), wasmImports);
  setInstance?.(instance);
  setExports?.(instance.exports as Record<string, Function>);
  const invoke = (name: string, ...args: unknown[]) => {
    const fn = instance.exports[name];
    if (typeof fn !== "function") throw new Error(`missing native export ${name}`);
    return fn(...args);
  };
  invoke("__module_init");
  expect(invoke("spread", (...args: unknown[]) => args.length, [1, 2, 3])).toBe(3);
  return { invoke, apply };
}

it("executes a host native rest-vector apply with ten arguments and its actual receiver", async () => {
  const { invoke } = await hostRest(`
    const callback=function(this:any,...args:any[]):any { return this.value+args.length+args[9]; };
    ${hostForwarder}
    export function run():number {
      try { return forward({value:23},1,2,3,4,5,6,7,8,9); } finally { }
    }
  `);
  expect(invoke("run")).toBe(42);
});

it("preserves a host native rest-vector tagged object and a healthy receiver after the throw", async () => {
  const { invoke } = await hostRest(`
    const callback=function(this:any,...args:any[]):any {
      if(args[9]===0) throw args[1];
      return this.value+args.length+args[9];
    };
    ${hostForwarder}
    export function run():number {
      const marker:any={value:17};
      let caught=false;
      try { forward({value:99},marker,2,3,4,5,6,7,8,0); }
      catch(error) { caught=error===marker; }
      return caught && forward({value:23},1,2,3,4,5,6,7,8,9)===42 ? 1 : -1;
    }
  `);
  expect(invoke("run")).toBe(1);
});

it("rethrows a foreign host import sentinel once from native rest apply and preserves the healthy follow-up", async () => {
  const sentinel = new Error("foreign rest apply sentinel");
  let calls = 0;
  const { invoke, apply } = await hostRest(
    `
    let effects=0;
    const callback=function(this:any,...args:any[]):any {
      if(args[9]===0) console.log(1);
      return this.value+args.length+args[9];
    };
    ${hostForwarder}
    export function attempt():void {
      try { forward({value:99},1,2,3,4,5,6,7,8,0); } finally { effects++; }
    }
    export function healthy():number { return forward({value:23},1,2,3,4,5,6,7,8,9); }
    export function count():number { return effects; }
  `,
    () => {
      calls++;
      throw sentinel;
    },
  );
  expect(apply).toMatch(/\(catch_all\s+local\.get \d+\s+global\.set \d+\s+rethrow 0/);
  let caught: unknown;
  try {
    invoke("attempt");
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(sentinel);
  expect(calls).toBe(1);
  expect(invoke("count")).toBe(1);
  expect(invoke("healthy")).toBe(42);
  expect(calls).toBe(1);
  expect(invoke("count")).toBe(1);
});
