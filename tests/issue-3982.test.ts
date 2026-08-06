import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

describe("ReactDOM upstream-suite compiler blockers (#3982)", () => {
  it("reuses a transitively capturing nested function value in sibling object literals", async () => {
    const result = await compile(
      `
        function moduleFactory() {
          var current = 2;
          function impl(a, b, c, d) { return current + a + b + c + d; }
          function update(a, b) { return impl(1, 2, a, b); }
          var first = { useEffect: update };
          var second = { useEffect: update };
          return second.useEffect;
        }
        var effect = moduleFactory();
        export function probe(): number { return effect(3, 4); }
      `,
      {
        fileName: "react-hooks-dispatchers.ts",
        skipSemanticDiagnostics: true,
      },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.probe as () => number)()).toBe(12);
  });

  it("stabilizes a captured object local before an out-of-shape property write", async () => {
    const result = await compile(
      `
        function moduleFactory() {
          function read() { return dispatcher.value; }
          var dispatcher = { value: 7 };
          dispatcher.extra = 1;
          var exports = { read: read };
          return exports;
        }
        var module = moduleFactory();
        export function probe(): number { return module.read(); }
      `,
      { fileName: "react-dispatcher-capture.ts", skipSemanticDiagnostics: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.probe as () => number)()).toBe(7);
  });

  it("keeps concrete descriptor literals typed when a dynamic write shares a field name", async () => {
    const result = await compile(
      `
        function writeAny(target: any, value: any) { target.value = value; }
        var expected = { value: "filter", writable: false, enumerable: false, configurable: true };
        writeAny({}, { unrelated: 1 });
        export function probe(): number {
          return expected.value === "filter" && expected.configurable ? 1 : 0;
        }
      `,
      { target: "standalone", fileName: "descriptor-representation.ts", skipSemanticDiagnostics: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.probe as () => number)()).toBe(1);
  });

  it("marshals array-like arguments for a cross-realm dynamic TypedArray constructor", async () => {
    const result = await compile(
      `export function probe(TA: any): number {
        var values = new TA([1, 2, 3]);
        return values.length;
      }`,
      { fileName: "cross-realm-typed-array.ts", skipSemanticDiagnostics: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const dom = new JSDOM();
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.probe as (ctor: unknown) => number)(dom.window.Float64Array)).toBe(3);
  });

  it("initializes a Map captured by a nested registration helper", async () => {
    const result = await compile(
      `
        function moduleFactory() {
          var events = new Map(), names = "abort click".split(" ");
          function register(name) { events.set(name, name); }
          names.forEach(register);
          return events.size;
        }
        export function probe() { return moduleFactory(); }
      `,
      { fileName: "react-event-registration.js", skipSemanticDiagnostics: true, experimentalIR: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.probe as () => number)()).toBe(2);
  });

  it("registers a bare Map constructor when a timer shim forces TypeScript grammar", async () => {
    const result = await compile(
      `
        export function probe() {
          var events = new Map([["click", "onClick"]]);
          var timer = setTimeout(function () {}, 1000);
          clearTimeout(timer);
          return events.size;
        }
      `,
      { fileName: "react-event-registration.js", skipSemanticDiagnostics: true, experimentalIR: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.probe as () => number)()).toBe(1);
  });

  it("routes incompatible dynamic object-field shapes through the sidecar", async () => {
    const result = await compile(
      `
        function sharedModule() {
          var exports = { internals: { d: { oldValue: 1 } } };
          return exports;
        }
        var shared = sharedModule();
        shared.internals.d = { newValue: 7 };
        export function probe() { return shared.internals.d.newValue; }
      `,
      { fileName: "react-dom-shared-internals.js", skipSemanticDiagnostics: true, experimentalIR: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.probe as () => number)()).toBe(7);
  });

  it("preserves a module-exported object alias when replacing a nested field", async () => {
    const result = await compile(
      `
        function sharedModule() {
          function noop() { return 0; }
          var Internals = { d: { f: noop } };
          var exports = {
            internals: Internals,
            flush: function () { return Internals.d.f(); }
          };
          return exports;
        }
        var shared = sharedModule();
        shared.internals.d = { f: function () { return 42; } };
        export function probe() { return shared.flush(); }
      `,
      { fileName: "react-dom-shared-internals-alias.js", skipSemanticDiagnostics: true, experimentalIR: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.probe as () => number)()).toBe(42);
  });

  it("keeps module-init flag fixups on delete-aware writes cloned through finally", async () => {
    const result = await compile(
      `
        export function probe() {
          var value = { current: 0, removed: 1 };
          delete value.removed;
          try {
            value.current = 3;
          } finally {
            value.current = 7;
          }
          return value.current;
        }
      `,
      { fileName: "react-start-transition-finally.js", skipSemanticDiagnostics: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
  });

  it("keeps captured callback locals inside nested map helpers in range", async () => {
    const result = await compile(
      `
        function reactModule() {
          function mapIntoArray(children, array, escapedPrefix, nameSoFar, callback) {
            return callback(children);
          }
          function mapChildren(children, func, context) {
            if (null == children) return children;
            var result = [], count = 0;
            mapIntoArray(children, result, "", "", function (child) {
              return func.call(context, child, count++);
            });
            return result;
          }
          return mapChildren;
        }
        export function probe() {
          var mapChildren = reactModule();
          return mapChildren(1, function (value, index) { return value + index; }, null)[0];
        }
      `,
      { fileName: "react-dom-map-children.js", skipSemanticDiagnostics: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
  });

  it("concatenates host arrays returned by String.prototype.split", async () => {
    const result = await compile(
      `
        export function probe() {
          var mediaEventTypes = "abort canplay".split(" ");
          return "cancel close".split(" ").concat(mediaEventTypes).length;
        }
      `,
      { fileName: "react-dom-event-registration.js", skipSemanticDiagnostics: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.probe as () => number)()).toBe(4);
  });

  it("preserves function expressions assigned to CommonJS-style exports", async () => {
    const result = await compile(
      `
        function sharedModule() {
          var exports = {};
          exports.createPortal = function () { return 0; };
          exports.flushSync = function () { return 0; };
          exports.version = "1";
          return exports;
        }
        function clientModule() {
          var exports = {};
          var offset = 1;
          function one() { return 1; }
          function two() { return 2; }
          function three() { return 3; }
          function four() { return 4; }
          exports.createRoot = function (value) {
            return value + offset + one() + two() + three() + four() - 10;
          };
          exports.hydrateRoot = function () { return 0; };
          exports.version = "1";
          return exports;
        }
        var shared = sharedModule();
        var client = clientModule();
        export function probe() { return client.createRoot(4); }
      `,
      { fileName: "react-dom-client.js", skipSemanticDiagnostics: true, experimentalIR: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.probe as () => number)()).toBe(5);
  });

  // (#3982, still open) A nested `async function` DECLARATION inside an `async`
  // parent loses its captures. Narrowed with probes: sync parent + nested async
  // decl works, async parent + nested sync decl works, and an async function
  // EXPRESSION inside an async parent works — only async-declared-inside-async
  // fails, reading the pre-capture value (`createRoot is not a function`) or
  // trapping on a null ref cell. Kept and skipped rather than deleted so the
  // shape stays recorded; see "Remaining blockers" in plan/issues/3982-*.md.
  it.skip("captures an assigned client module in a nested async helper", async () => {
    const result = await compile(
      `
        function clientModule() {
          var exports = {};
          exports.createRoot = function (value) { return value + 1; };
          return exports;
        }
        var clientModuleValue = clientModule();
        export async function probe() {
          let client;
          client = clientModuleValue;
          async function run(value) {
            return client.createRoot(value);
          }
          return await run(4);
        }
      `,
      { fileName: "react-dom-client-async.js", skipSemanticDiagnostics: true, experimentalIR: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    await expect((instance.exports.probe as () => Promise<number>)()).resolves.toBe(5);
  });

  // (#3982, still open) Same async-declared-inside-async capture gap as above,
  // with several captures whose order also has to survive.
  it.skip("keeps multiple assigned async-helper captures in declaration order", async () => {
    const result = await compile(
      `
        var reactValue = { createElement: function () { return 2; } };
        var sharedValue = { flushSync: function (callback) { return callback(); } };
        var clientValue = { createRoot: function (value) { return value + 1; } };
        export async function probe() {
          try {
          let React;
          let ReactDOMClient;
          let act;
          React = reactValue;
          ReactDOMClient = clientValue;
          act = async function (callback) {
            var result;
            sharedValue.flushSync(function () { result = callback(); });
            if (result !== null && result !== undefined && typeof result.then === "function") await result;
            return result;
          };
          async function run(value) {
            const root = ReactDOMClient.createRoot(value);
            await act(function () { return React.createElement(); });
            return root;
          }
          React = reactValue;
          return await run(4);
          } catch (error) {
            throw error;
          }
        }
      `,
      {
        fileName: "react-dom-client-async-captures.js",
        skipSemanticDiagnostics: true,
        experimentalIR: true,
      },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    await expect((instance.exports.probe as () => Promise<number>)()).resolves.toBe(5);
  });

  it("constructs a runtime-selected local constructor value", async () => {
    const result = await compile(
      `
        declare var AbortController: {
          new (): { signal: { aborted: boolean } };
        };
        var AbortControllerLocal =
          typeof AbortController !== "undefined"
            ? AbortController
            : function () {
                this.signal = { aborted: false };
              };
        export function probe() {
          var controller = new AbortControllerLocal();
          return controller.signal.aborted ? 0 : 1;
        }
      `,
      { fileName: "react-dom-runtime-constructor.ts", skipSemanticDiagnostics: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.probe as () => number)()).toBe(1);
  });

  it("reads an attribute through Element.firstChild after a DOM mutation", async () => {
    const result = await compile(
      `
        export function probe() {
          var parent = document.createElement("div");
          var child = document.createElement("div");
          child.setAttribute("unknown", "something");
          parent.appendChild(child);
          return parent.firstChild.getAttribute("unknown");
        }
      `,
      { fileName: "react-dom-attribute.js", skipSemanticDiagnostics: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const dom = new JSDOM("<!doctype html><html><body></body></html>");
    const imports = buildImports(result.imports, { document: dom.window.document }, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.probe as () => string)()).toBe("something");
  });

  it("shares a replaced nested dispatcher across CommonJS module objects", async () => {
    const result = await compile(
      `
        function sharedModule() {
          var exports = {};
          var Internals = { d: { f: function () { return 0; } } };
          exports.internals = Internals;
          exports.flush = function (callback) {
            callback();
            return Internals.d.f();
          };
          return exports;
        }
        var shared = sharedModule();
        function clientModule() {
          var linked = shared.internals;
          linked.d = { f: function () { return 42; } };
        }
        clientModule();
        export function probe() {
          return shared.flush(function () {});
        }
      `,
      { fileName: "react-dom-shared-dispatcher.js", skipSemanticDiagnostics: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.probe as () => number)()).toBe(42);
  });

  it("runs a shared dispatcher from finally when the try returns", async () => {
    const result = await compile(
      `
        function sharedModule() {
          var exports = {};
          var Internals = { p: 0, d: { f: function () { return 0; } } };
          exports.internals = Internals;
          exports.flush = function (callback) {
            var previousPriority = Internals.p;
            try {
              Internals.p = 2;
              if (callback) return callback();
            } finally {
              Internals.p = previousPriority;
              Internals.d.f();
            }
          };
          return exports;
        }
        var shared = sharedModule();
        var committed = 0;
        function clientModule() {
          var linked = shared.internals;
          var previousDispatcher = linked.d;
          linked.d = {
            f: function () {
              previousDispatcher.f();
              committed = 42;
            }
          };
        }
        clientModule();
        export function probe() {
          shared.flush(function () { return 7; });
          return committed;
        }
      `,
      { fileName: "react-dom-shared-finally.js", skipSemanticDiagnostics: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.probe as () => number)()).toBe(42);
  });

  it("links two function-constructor instances through an initially-null field", async () => {
    const result = await compile(
      `
        function clientModule() {
          function makeLaneMap(value) { return [value, value]; }
          function RootNode(containerInfo) {
            this.containerInfo = containerInfo;
            this.current = null;
            this.expirationTimes = makeLaneMap(-1);
          }
          function FiberNode(tag) {
            this.tag = tag;
            this.stateNode = null;
            this.updateQueue = null;
          }
          function createFiberRoot(containerInfo) {
            containerInfo = new RootNode(containerInfo);
            var fiber = new FiberNode(3);
            containerInfo.current = fiber;
            fiber.stateNode = containerInfo;
            fiber.updateQueue = {};
            return fiber;
          }
          return { createFiberRoot: createFiberRoot };
        }
        var client = clientModule();
        export function probe(containerInfo) {
          var fiber = client.createFiberRoot(containerInfo);
          return fiber.tag === 3 && fiber.updateQueue !== null && fiber.stateNode !== null ? 1 : 0;
        }
      `,
      { fileName: "react-dom-fiber-root.js", skipSemanticDiagnostics: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.probe as (value: object) => number)({ id: 1 })).toBe(1);
  });

  it("preserves nested void-call side effects in a logical comma expression", async () => {
    const result = await compile(
      `
        function clientModule() {
          var scheduled = 0;
          var entangled = 0;
          function schedule(root, fiber, lane) {
            scheduled = root.value + fiber.value + lane;
          }
          function entangle(root, fiber, lane) {
            entangled = root.value + fiber.value + lane;
          }
          function update(element, root, fiber, lane) {
            element !== null &&
              (schedule(root, fiber, lane),
               entangle(root, fiber, lane));
            return scheduled * 10 + entangled;
          }
          return { update: update };
        }
        var client = clientModule();
        export function probe() {
          return client.update({}, { value: 1 }, { value: 2 }, 3);
        }
      `,
      { fileName: "react-dom-logical-comma.js", skipSemanticDiagnostics: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.probe as () => number)()).toBe(66);
  });

  it("preserves a trailing nested void call in an unbraced if comma body", async () => {
    const result = await compile(
      `
        function clientModule() {
          var currentRoot = null;
          var scheduled = 0;
          function schedule(root) {
            if (root !== currentRoot)
              root === currentRoot && (scheduled = 10),
              ensureRootIsScheduled(root);
          }
          function ensureRootIsScheduled(root) {
            scheduled = root.value;
          }
          return { schedule: schedule, read: function () { return scheduled; } };
        }
        var client = clientModule();
        export function probe() {
          client.schedule({ value: 42 });
          return client.read();
        }
      `,
      { fileName: "react-dom-schedule-root.js", skipSemanticDiagnostics: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.probe as () => number)()).toBe(42);
  });

  it("resolves later capturing siblings used by conditional call branches", async () => {
    const result = await compile(
      `
        function clientModule() {
          var base = 40;
          function perform(useConcurrent) {
            return useConcurrent ? renderConcurrent() : renderSync();
          }
          function renderConcurrent() { return base + 1; }
          function renderSync() { return base + 2; }
          return { perform: perform };
        }
        var client = clientModule();
        export function probe() { return client.perform(false); }
      `,
      { fileName: "react-dom-render-conditional.js", skipSemanticDiagnostics: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.probe as () => number)()).toBe(42);
  });

  it("moves a forward callee's earlier unresolved dependency with it", async () => {
    const result = await compile(
      `
        function clientModule() {
          var value = 0;
          function caller(run) {
            return run ? moved() : 0;
          }
          function dependency() {
            value = 42;
          }
          function moved() {
            dependency();
            return value;
          }
          return { caller: caller };
        }
        var client = clientModule();
        export function probe() { return client.caller(true); }
      `,
      { fileName: "react-dom-transitive-forward-call.js", skipSemanticDiagnostics: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.probe as () => number)()).toBe(42);
  });

  it("preserves a bare forward sibling call after a returning conditional", async () => {
    const result = await compile(
      `
        function clientModule() {
          var committed = 0;
          function commitWhenReady(suspend) {
            if (suspend) {
              if (suspend === 2) return;
            }
            commitRoot();
          }
          function commitRoot() {
            committed = 42;
          }
          return {
            commitWhenReady: commitWhenReady,
            read: function () { return committed; }
          };
        }
        var client = clientModule();
        export function probe() {
          client.commitWhenReady(0);
          return client.read();
        }
      `,
      { fileName: "react-dom-forward-commit.js", skipSemanticDiagnostics: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.probe as () => number)()).toBe(42);
  });

  it("preserves a forward sibling call in a conditional comma result", async () => {
    const result = await compile(
      `
        function clientModule() {
          var called = 0;
          function flush(canFlush) {
            return canFlush ? (flushAcrossRoots(), false) : true;
          }
          function flushAcrossRoots() {
            called = 42;
          }
          return {
            flush: flush,
            read: function () { return called; }
          };
        }
        var client = clientModule();
        export function probe() {
          client.flush(true);
          return client.read();
        }
      `,
      { fileName: "react-dom-forward-conditional-comma.js", skipSemanticDiagnostics: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.probe as () => number)()).toBe(42);
  });

  it("preserves forward conditional calls in terminating mutual recursion", async () => {
    const result = await compile(
      `
        function clientModule() {
          var calls = 0;
          function flush(depth) {
            return depth > 0 ? (flushAcrossRoots(depth - 1), false) : true;
          }
          function flushAcrossRoots(depth) {
            calls += 1;
            if (depth > 0) flush(depth);
          }
          return {
            flush: flush,
            read: function () { return calls; }
          };
        }
        var client = clientModule();
        export function probe() {
          client.flush(2);
          return client.read();
        }
      `,
      { fileName: "react-dom-mutual-flush.js", skipSemanticDiagnostics: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.probe as () => number)()).toBe(2);
  });

  it("preserves a later capturing sibling selected as a bind target", async () => {
    const result = await compile(
      `
        function clientModule() {
          var called = 0;
          function addListener(priority) {
            switch (priority) {
              case 1:
                var listener = dispatchEvent;
                break;
              default:
                listener = dispatchEvent;
            }
            var bound = listener.bind(null, 40);
            bound(2);
          }
          function dispatchEvent(left, right) {
            called = left + right;
          }
          return {
            addListener: addListener,
            read: function () { return called; }
          };
        }
        var client = clientModule();
        export function probe() {
          client.addListener(1);
          return client.read();
        }
      `,
      { fileName: "react-dom-forward-bind.js", skipSemanticDiagnostics: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.probe as () => number)()).toBe(42);
  });

  // (#3982, still open) `captureSourceSlot` (#4134) resolves a cross-frame
  // capture by NAME. When the lifted caller declares its own local with the
  // same text as the capture — `var root = 1` here, shadowing the outer
  // `root = 40` that the sibling `updateOuterRoot` captures — a name lookup
  // cannot tell the two bindings apart, so the emitted `local.get` reads the
  // caller's own f64 slot and the module fails validation
  // (`struct.new[0] expected type f64, found local.get of type externref`).
  // Closing this needs capture slots keyed on the OWNING frame, not the name.
  // Kept and skipped rather than deleted; see plan/issues/3982-*.md.
  it.skip("threads a sibling capture past a same-named caller local", async () => {
    const result = await compile(
      `
        function clientModule() {
          var root = 40;
          function updateOuterRoot() {
            root += 2;
            return root;
          }
          function caller(hasLocalRoot) {
            if (hasLocalRoot) {
              var root = 1;
              root += 10;
            }
            return updateOuterRoot();
          }
          return {
            caller: caller,
            readOuterRoot: function () { return root; }
          };
        }
        var client = clientModule();
        export function probe() {
          return client.caller(true) * 100 + client.readOuterRoot();
        }
      `,
      { fileName: "react-dom-shadowed-transitive-capture.js", skipSemanticDiagnostics: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.probe as () => number)()).toBe(4242);
  });

  it("preserves heterogeneous writes to an initially empty queue", async () => {
    const result = await compile(
      `
        function clientModule() {
          var queue = [], index = 0;
          var numericFieldShape = { 2: false };
          function enqueue(fiber, shared, update, lane) {
            queue[index++] = fiber;
            queue[index++] = shared;
            queue[index++] = update;
            queue[index++] = lane;
          }
          function finish() {
            if (numericFieldShape[2]) return -1;
            var fiber = queue[0];
            var shared = queue[1];
            var update = queue[2];
            var lane = queue[3];
            var pending = shared.pending;
            if (pending === null) update.next = update;
            else {
              update.next = pending.next;
              pending.next = update;
            }
            shared.pending = update;
            return fiber.tag + update.value + lane;
          }
          return { enqueue: enqueue, finish: finish };
        }
        var client = clientModule();
        export function probe() {
          client.enqueue({ tag: 3 }, { pending: null }, { value: 30, next: null }, 9);
          return client.finish();
        }
      `,
      { fileName: "react-dom-concurrent-queue.js", skipSemanticDiagnostics: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.probe as () => number)()).toBe(42);
  });

  it("shape-checks inline dynamic member reads before selecting a same-layout field", async () => {
    const result = await compile(
      `
        var sharedNotPendingObject = {
          pending: false,
          data: null,
          method: null,
          action: null
        };
        function initialize() {
          return {
            baseState: sharedNotPendingObject,
            firstBaseUpdate: null,
            lastBaseUpdate: null,
            shared: { pending: null, lanes: 0, hiddenCallbacks: null },
            callbacks: null
          };
        }
        function Fiber() { this.updateQueue = null; }
        export function probe() {
          var fiber = new Fiber();
          fiber.updateQueue = initialize();
          var updateQueue: any = fiber.updateQueue;
          var queue = updateQueue.shared;
          return queue === sharedNotPendingObject ? -1 : queue.pending === null ? 1 : 0;
        }
      `,
      { fileName: "react-dom-shared-queue-read.ts", skipSemanticDiagnostics: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.probe as () => number)()).toBe(1);
  });

  it("resolves a later capturing sibling called from a loop body", async () => {
    const result = await compile(
      `
        function clientModule() {
          var current = 0;
          function workLoop() {
            for (; current < 1; ) performUnit();
            return current;
          }
          function performUnit() {
            current += 42;
          }
          return { workLoop: workLoop };
        }
        var client = clientModule();
        export function probe() { return client.workLoop(); }
      `,
      { fileName: "react-dom-work-loop.js", skipSemanticDiagnostics: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.probe as () => number)()).toBe(42);
  });

  it("calls a selected host builtin through a module-local alias", async () => {
    const result = await compile(
      `
        var clz32 = Math.clz32 ? Math.clz32 : clz32Fallback;
        function clz32Fallback(value) { return value === 0 ? 32 : 0; }
        export function probe() { return clz32(1); }
      `,
      { fileName: "react-dom-clz32.js", skipSemanticDiagnostics: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.probe as () => number)()).toBe(31);
  });

  it("preserves object fields through an aliased Object.assign call", async () => {
    const result = await compile(
      `
        var assign = Object.assign;
        export function probe() {
          var element = { type: "div" };
          var state = { element: null, cache: null };
          var payload = { element: element };
          var nextState = assign({}, state, payload);
          return nextState.element === element ? 1 : 0;
        }
      `,
      { fileName: "react-dom-object-assign.js", skipSemanticDiagnostics: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.probe as () => number)()).toBe(1);
  });

  it("shape-checks host field getters used by Object.assign", async () => {
    const result = await compile(
      `
        var assign = Object.assign;
        var decoy = { other: null as any, element: null as any };
        export function probe() {
          var element = { type: "div" };
          var payload = { element: element as any, other: null as any };
          var nextState: any = assign({}, payload);
          return decoy.other === null && nextState.element === element ? 1 : 0;
        }
      `,
      { fileName: "react-dom-object-assign-shape.ts", skipSemanticDiagnostics: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.probe as () => number)()).toBe(1);
  });

  it("keeps a numeric local dynamic when it is reused for an object payload", async () => {
    const result = await compile(
      `
        var assign = Object.assign;
        export function probe() {
          var payload = { element: { type: "div" } };
          var updateLane = 4 & -536870913;
          updateLane = payload;
          var nextState = assign({}, { element: null }, updateLane);
          return nextState.element === payload.element ? 1 : 0;
        }
      `,
      { fileName: "react-dom-mixed-update-lane.js", skipSemanticDiagnostics: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.probe as () => number)()).toBe(1);
  });

  it("passes an existing mutable capture cell to a read-only sibling", async () => {
    const result = await compile(
      `
        function makeRunner() {
          var flag = false;
          function mutate() { flag = true; }
          function read() { return flag ? 1 : 0; }
          return function () {
            mutate();
            return read();
          };
        }
        var runner = makeRunner();
        export function probe() { return runner(); }
      `,
      { fileName: "react-dom-transitive-box.js", skipSemanticDiagnostics: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.probe as () => number)()).toBe(1);
  });

  it("walks a child list by reassigning a tree cursor parameter", async () => {
    const result = await compile(
      `
        function Fiber(tag) {
          this.tag = tag;
          this.child = null;
          this.sibling = null;
          this.flags = 0;
          this.subtreeFlags = 0;
        }
        function visit(parentFiber) {
          var count = 0;
          if (parentFiber.subtreeFlags & 13886)
            for (parentFiber = parentFiber.child; parentFiber !== null; ) {
              count += parentFiber.flags & 2;
              parentFiber = parentFiber.sibling;
            }
          return count;
        }
        export function probe() {
          var root = new Fiber(3);
          var child = new Fiber(5);
          child.flags = 67108866;
          root.subtreeFlags = child.flags;
          root.child = child;
          return visit(root);
        }
      `,
      { fileName: "react-dom-fiber-traversal.js", skipSemanticDiagnostics: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.probe as () => number)()).toBe(2);
  });

  it("resolves mutually recursive capturing siblings used in a loop comma body", async () => {
    const result = await compile(
      `
        function makeVisitor() {
          var seen = 0;
          var factor = 3;
          var offset = 5;
          function traverse(parent) {
            if (parent.child)
              for (parent = parent.child; parent !== null; )
                visit(parent), (parent = parent.sibling);
            return seen + offset;
          }
          function visit(node) {
            seen += (node.flags & 2) * factor;
            if (node.child) traverse(node);
          }
          return traverse;
        }
        var runner = makeVisitor();
        export function probe() {
          var child = { flags: 2, child: null, sibling: null };
          var root = { flags: 0, child: child, sibling: null };
          return runner(root);
        }
      `,
      { fileName: "react-dom-mutation-cycle.js", skipSemanticDiagnostics: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.probe as () => number)()).toBe(11);
  });

  it("resolves lib.dom's window intersection as an ambient host global", async () => {
    const result = await compile(
      `
        export function probe() {
          var event = window.event;
          return event === undefined ? 32 : event.type.length;
        }
      `,
      { fileName: "react-dom-update-priority.js", skipSemanticDiagnostics: true },
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(result.imports.some((entry) => entry.module === "env" && entry.name === "global_window")).toBe(true);
    const imports = buildImports(result.imports, { window: { event: undefined } }, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.probe as () => number)()).toBe(32);
  });
});
