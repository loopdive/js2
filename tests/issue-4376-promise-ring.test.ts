// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compileMulti } from "../src/index.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

function runNumber(instance: WebAssembly.Instance): number {
  try {
    return (instance.exports.run as () => number)();
  } catch (error: any) {
    if (error.getArg && instance.exports.__exn_render_prepare) {
      const payload = error.getArg(instance.exports.__exn_tag, 0);
      const length = (instance.exports.__exn_render_prepare as (payload: unknown) => number)(payload);
      const char = instance.exports.__exn_render_char as (index: number) => number;
      throw new Error(Array.from({ length }, (_, index) => String.fromCharCode(char(index))).join(""));
    }
    throw error;
  }
}

it.each(["inline", "nested"])("retains a captured applyBind helper through %s construction", async (mode) => {
  const result = await compileMulti(
    {
      "/applybind/entry.js": `
export function run() {
  const {apply,bind}=Function.prototype;
  const applyBind=bind.bind(apply);
  function target(a,b) { return a+b; }
  function make(target) { return applyBind(target); }
  const invoke=${mode === "nested" ? "make(target)" : "applyBind(target)"};
  return invoke(undefined,[19,23]);
}`,
    },
    "/applybind/entry.js",
    { target: "standalone", platform: "deno", allowJs: true, skipSemanticDiagnostics: true },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), result.importObject ?? {});
  expect(runNumber(instance)).toBe(42);
});

it.each(["eager", "staged"])("runs a pending op through unchanged Deno infrastructure (%s)", async (mode) => {
  const primordials = readFileSync(new URL("./fixtures/deno-core-0.407.0/00_primordials.js", import.meta.url), "utf8");
  const infra = readFileSync(new URL("./fixtures/deno-core-0.407.0/00_infra.js", import.meta.url), "utf8");
  expect(createHash("sha256").update(primordials).digest("hex")).toBe(
    "5a2dfbdc4bb81412575d035901a11788001c7e0110e3f736d16289891af44a52",
  );
  expect(createHash("sha256").update(infra).digest("hex")).toBe(
    "33984000be930f3b02a2d1149ac0319724e8d95891623c8cc74699da4ce97287",
  );
  const files: Record<string, string> = {
    "/exact/seed.ts": `(globalThis as any).Deno = { core: { ops: {} } };`,
    "/exact/entry.ts": `import "./seed.ts";
    ${mode === "eager" ? 'import "./primordials.js"; import "./infra.js";' : 'import { boot } from "./scripts.ts";'}
    let stage = 0;
    let savedPromise:any;
    export function probeStage():number { return stage; }
    export function returnedPromise():any { return savedPromise; }
    export function settlePending():void { (globalThis as any).__infra.__resolvePromise(0,42,true); }
    export function run():number {
      stage = 1;
      ${mode === "staged" ? "boot();" : ""}
      stage = 2;
      const core:any = (globalThis as any).Deno.core;
      stage = 3;
      function op(id) { return undefined; }
      const wrapper = core.setUpAsyncStub("op_probe", op);
      stage = 4;
      const promise = wrapper();
      savedPromise = promise;
      stage = 5;
      return promise === null ? -1 : 42;
    }`,
  };
  if (mode === "eager") {
    files["/exact/primordials.js"] = primordials;
    files["/exact/infra.js"] = infra;
  } else {
    files["/exact/scripts.ts"] =
      `function script0():void {\n${primordials}\n}\nfunction script1():void {\n${infra}\n}\nexport function boot():void { script0(); script1(); }`;
  }
  const result = await compileMulti(files, "/exact/entry.ts", {
    target: "standalone",
    platform: "deno",
    skipSemanticDiagnostics: true,
    allowJs: true,
    deferTopLevelInit: true,
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  const imports: Record<string, Record<string, Function>> = {};
  for (const item of WebAssembly.Module.imports(module)) {
    expect(item.kind).toBe("function");
    (imports[item.module] ??= {})[item.name] = () => {
      throw new Error(`unexpected external call: ${item.module}::${item.name}`);
    };
  }
  const instance = new WebAssembly.Instance(module, imports);
  try {
    (instance.exports.__module_init as () => void)();
    expect((instance.exports.run as () => number)()).toBe(42);
    const promise = (instance.exports.returnedPromise as () => unknown)();
    const readState = instance.exports.__promise_boundary_state as (promise: unknown) => number;
    expect(typeof readState).toBe("function");
    expect(readState(promise)).toBe(0);
    const pendingCount = instance.exports.__microtasks_pending as () => number;
    expect(typeof pendingCount).toBe("function");
    expect(pendingCount()).toBe(0);
    (instance.exports.settlePending as () => void)();
    expect(readState(promise)).toBe(0);
    expect(pendingCount()).toBeGreaterThan(0);
    const drain = instance.exports.__drain_microtasks as () => void;
    expect(typeof drain).toBe("function");
    drain();
    expect(pendingCount()).toBe(0);
    expect(readState(promise)).toBe(1);
    const readValue = instance.exports.__promise_boundary_value as (promise: unknown) => unknown;
    expect(typeof readValue).toBe("function");
    expect(readValue(promise)).toBe(42);
  } catch (error: any) {
    if (error.getArg && instance.exports.__exn_render_prepare) {
      const payload = error.getArg(instance.exports.__exn_tag, 0);
      const length = (instance.exports.__exn_render_prepare as (payload: unknown) => number)(payload);
      const char = instance.exports.__exn_render_char as (index: number) => number;
      throw new Error(
        `stage ${(instance.exports.probeStage as () => number)()}: ` +
          Array.from({ length }, (_, index) => String.fromCharCode(char(index))).join(""),
      );
    }
    throw error;
  }
});

it.each([
  ["optional end", "7, -2, undefined", 1177],
  ["negative bounds", "7, -3, -1", 1771],
  ["infinite bounds", "7, -Infinity, Infinity", 7777],
  ["NaN start", "7, NaN, 1", 7111],
  ["object coercion", "7, { valueOf() { return 1; } }, 3", 1771],
])("fills a borrowed array with %s", async (_name, arguments_, expected) => {
  const result = await compileMulti(
    {
      "/fill/entry.ts": `
export function run():number {
  const fill:any = Array.prototype.fill;
  const a:any = [1,1,1,1];
  const returned = fill.call(a, ${arguments_});
  if (returned !== a) return -1;
  return a[0]*1000+a[1]*100+a[2]*10+a[3];
}`,
    },
    "/fill/entry.ts",
    { target: "standalone", platform: "deno", skipSemanticDiagnostics: true },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), result.importObject ?? {});
  expect((instance.exports.run as () => number)()).toBe(expected);
});

it("preserves a rebound fill method through descriptor publication", async () => {
  const result = await compileMulti(
    {
      "/descriptor/entry.ts": `
export function run():number {
  const {call,bind}=Function.prototype;
  const uncurry:any=bind.bind(call);
  const desc:any=Reflect.getOwnPropertyDescriptor(Array.prototype,"fill");
  desc.value=uncurry(desc.value);
  const dest:any={};
  Reflect.defineProperty(dest,"fill",desc);
  const array:any=[1,1,1,1];
  const result=dest.fill(array,7);
  return result === array ? array[0]*1000+array[1]*100+array[2]*10+array[3] : array[0] === 7 ? -2 : -3;
}`,
    },
    "/descriptor/entry.ts",
    { target: "standalone", platform: "deno", skipSemanticDiagnostics: true },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), result.importObject ?? {});
  expect(runNumber(instance)).toBe(7777);
});

it.each(["direct", "loop", "unlifted", "inline", "apply", "fresh"])(
  "copies an inferred uncurried fill through %s reflection",
  async (mode) => {
    const result = await compileMulti(
      {
        "/copy/entry.js": `
let copies=0;
let iterations=0;
let matches=0;
export function run() {
  const primordials = {};
  (() => {
    const {defineProperty:define,getOwnPropertyDescriptor:descriptor,ownKeys:keys}=Reflect;
    const {call,bind}=Function.prototype;
    const uncurry=bind.bind(call);
    function copy(src,dest) {
      copies++;
      for(const key of ${mode === "loop" ? "keys(src)" : '["fill"]'}) {
        iterations++;
        if(key !== "fill") continue;
        matches++;
        const desc=descriptor(src,key);
        const {value}=desc;
        if(typeof value === "function") desc.value=${mode === "fresh" ? "Function.prototype.call.bind(value)" : "uncurry(value)"};
        define(dest,key,desc);
        globalThis.__copiedDest=dest;
      }
    }
    ${mode === "inline" ? 'const desc=descriptor(Array.prototype,"fill"); desc.value=uncurry(desc.value); define(primordials,"fill",desc);' : mode === "unlifted" ? "copy(Array.prototype,primordials);" : '["Array"].forEach(name => copy(globalThis[name].prototype,primordials));'}
  })();
  const array=[1,1,1,1];
  ${mode === "inline" ? "" : "if(copies !== 1) return -100 - copies;"}
  ${mode === "inline" ? "" : "if(matches !== 1) return -200 - iterations;"}
  ${mode === "inline" ? "" : "if(globalThis.__copiedDest !== primordials) return -300;"}
  const fill=primordials.fill;
  if(typeof fill !== "function") return -5;
  const result=${mode === "apply" ? "fill.apply(undefined,[array,7])" : "fill(array,7)"};
  return result === array ? array[0]*1000+array[1]*100+array[2]*10+array[3] : result === primordials ? -4 : array[0] === 7 ? -2 : -3;
}`,
      },
      "/copy/entry.js",
      { target: "standalone", platform: "deno", allowJs: true, skipSemanticDiagnostics: true },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), result.importObject ?? {});
    expect(runNumber(instance)).toBe(7777);
  },
);

it.each([
  [
    "executor once",
    "let calls=0; function make(){calls++; return (resolve)=>{calls++;};} const C:any=Promise; const p=new C(make()); return calls;",
    2,
  ],
  [
    "invalid executor",
    "const C:any=Promise; try { new C(7); } catch(e) { return e instanceof TypeError ? 42 : -1; } return -2;",
    42,
  ],
  [
    "missing executor",
    "const C:any=Promise; try { new C(); } catch(e) { return e instanceof TypeError ? 42 : -1; } return -2;",
    42,
  ],
  [
    "nonintrinsic identity",
    "class Other { value:number; constructor(exec:any){ this.value=42; } } const intrinsic:any=Promise; const C:any=Other; const p=new C(()=>{}); return p.value;",
    42,
  ],
])("preserves dynamic Promise control %s", async (_name, source, expected) => {
  const result = await compileMulti(
    { "/control/entry.ts": `export function run():number { ${source} }` },
    "/control/entry.ts",
    { target: "standalone", platform: "deno", skipSemanticDiagnostics: true },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), result.importObject ?? {});
  expect((instance.exports.run as () => number)()).toBe(expected);
});

it.each(["direct", "primordial", "reflected", "aliased"])(
  "retains a null-filled promise ring through %s initialization",
  async (mode) => {
    const result = await compileMulti(
      {
        "/ring/entry.ts": `
const published: any = {};
function boot(): void {
  (() => {
    const ArrayCtor: any = Array;
    const { call, bind } = Function.prototype;
    const uncurryThis: any = bind.bind(call);
    const ArrayPrototypeFill: any = uncurryThis(${mode === "reflected" ? 'Reflect.getOwnPropertyDescriptor(Array.prototype, "fill").value' : "Array.prototype.fill"});
    const RING_SIZE = 4096;
    const NO_PROMISE = null;
    const promiseRing = ${mode === "direct" ? "new Array(RING_SIZE).fill(NO_PROMISE)" : mode === "aliased" ? "ArrayPrototypeFill(new ArrayCtor(RING_SIZE), NO_PROMISE)" : "ArrayPrototypeFill(new Array(RING_SIZE), NO_PROMISE)"};
    function setPromise(id) {
      const oldPromise = promiseRing[id % RING_SIZE];
      if (oldPromise !== NO_PROMISE) return oldPromise[2];
      return 42;
    }
    published.setPromise = setPromise;
  })();
}
export function run(): number { boot(); return published.setPromise(0); }
`,
      },
      "/ring/entry.ts",
      { target: "standalone", platform: "deno", skipSemanticDiagnostics: true },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), result.importObject ?? {});
    try {
      expect((instance.exports.run as () => number)()).toBe(42);
    } catch (error: any) {
      if (error.getArg && instance.exports.__exn_render_prepare) {
        const payload = error.getArg(instance.exports.__exn_tag, 0);
        const length = (instance.exports.__exn_render_prepare as (payload: unknown) => number)(payload);
        const char = instance.exports.__exn_render_char as (index: number) => number;
        throw new Error(Array.from({ length }, (_, index) => String.fromCharCode(char(index))).join(""));
      }
      throw error;
    }
  },
);

it.each(["read", "construct", "catch", "symbol", "global-read", "global-construct", "global-catch", "global-symbol"])(
  "executes pending promise stage %s",
  async (stageName) => {
    const viaGlobal = stageName.startsWith("global-");
    const stage = stageName.replace("global-", "");
    const result = await compileMulti(
      {
        "/pending/entry.ts": `
const published:any = {};
export function run():number {
  (() => {
    const { call, bind } = Function.prototype;
    const uncurryThis:any = bind.bind(call);
    const Fill:any = uncurryThis(Array.prototype.fill);
    const Catch:any = uncurryThis(Promise.prototype.catch);
    const constructors:any = globalThis;
    const ArrayCtor:any = ${viaGlobal ? 'constructors["Array"]' : "Array"};
    const PromiseCtor:any = ${viaGlobal ? 'constructors["Promise"]' : "Promise"};
    const size = 4096;
    const empty = null;
    const ring = Fill(new ArrayCtor(size), empty);
    const key = Symbol.for("Deno.core.internalPromiseId");
    function setPromise(id) {
      const idx = id % size;
      const old = ring[idx];
      if (old !== empty) return old[2];
      ${
        stage === "read"
          ? "return 42;"
          : `
      const promise = new PromiseCtor((resolve, reject) => {
        ring[idx] = [resolve, reject, id];
      });
      ${
        stage === "construct"
          ? "if (ring[idx] === null) return promise === null ? -1 : -2; return ring[idx][2] + 42;"
          : `
      const wrapped = Catch(promise, function rejectHandler(res) { throw res; });
      ${stage === "symbol" ? "wrapped[key] = id;" : ""}
      return ring[idx][2] + 42;
      `
      }`
      }
    }
    published.setPromise = setPromise;
  })();
  return published.setPromise(0);
}`,
      },
      "/pending/entry.ts",
      { target: "standalone", platform: "deno", skipSemanticDiagnostics: true },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), result.importObject ?? {});
    expect((instance.exports.run as () => number)()).toBe(42);
  },
);

it("settles an aliased native Promise only after its deferred resolver runs", async () => {
  const result = await compileMulti(
    {
      "/settle/entry.ts": `
let resolveLater:any;
let seen = -1;
export function init():void {
  const C:any = Promise;
  const p:any = new C((resolve,reject) => { resolveLater=resolve; });
  p.then((value) => { seen=value; });
}
export function settle():void { resolveLater(42); }
export function read():number { return seen; }
`,
    },
    "/settle/entry.ts",
    { target: "standalone", platform: "deno", skipSemanticDiagnostics: true },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), result.importObject ?? {});
  const exports = instance.exports as Record<string, CallableFunction>;
  exports.init();
  expect(exports.read()).toBe(-1);
  exports.settle();
  expect(exports.read()).toBe(-1);
  expect(typeof exports.__drain_microtasks).toBe("function");
  exports.__drain_microtasks();
  expect(exports.read()).toBe(42);
});
