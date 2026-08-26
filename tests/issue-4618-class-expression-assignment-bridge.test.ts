// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4618: an assignment-position class expression must cross the JS-host
// boundary as the same constructible class object used by JSX element.type.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";
import { installReactTestEnvironment } from "./dogfood/react-test-environment.mjs";

async function captureAssignedClass(
  parent?: Function,
  compiledParent = false,
  explicitConstructor = false,
  staticMethod = false,
  derivedState = false,
  declaredClass = false,
): Promise<any> {
  let captured: unknown;
  function HostBase(this: any, props: any) {
    this.props = props;
  }
  (HostBase as any).prototype.isReactComponent = {};
  (globalThis as any).__hostBase4618 = parent ?? HostBase;
  (globalThis as Record<string, unknown>).__captureAssignedClass4618 = (value: unknown) => {
    captured = value;
  };
  const classBody = `
    ${
      staticMethod
        ? `static derive(props: any, state: any): string { return props.foo + ":" + state.bar; }
           static deriveObject(props: any, state: any): any {
             return { value: props.foo + ":" + state.bar };
           }`
        : ""
    }
    ${
      derivedState
        ? `state: any = {};
           static getDerivedStateFromProps(props: any, _state: any): any {
             return { value: props.value + ":derived" };
           }`
        : ""
    }
    ${
      explicitConstructor
        ? `state: any;
           constructor(props: any) { super(props); this.state = { name: this.props.name }; }`
        : ""
    }
    render(): string {
      return ${
        derivedState
          ? `(globalThis as any).__react4618Static.createElement("div", { className: String((this as any).state.value) })`
          : `"rendered:" + String((this as any).props.name)`
      };
    }
  `;
  const classDefinition = declaredClass
    ? `class Inner extends React.Component { ${classBody} }`
    : `let Inner: any; Inner = class extends React.Component { ${classBody} };`;
  const result = await compile(
    `
      ${
        compiledParent
          ? `function Base(props: any) { (this as any).props = props; }
             Base.prototype.isReactComponent = {};
             const React: any = { Component: Base };`
          : `const React: any = { Component: (globalThis as any).__hostBase4618 };`
      }
      export function send(): number {
        ${classDefinition}
        (globalThis as any).__captureAssignedClass4618(Inner);
        return 1;
      }
    `,
    {
      fileName: "issue-4618-class-expression-assignment-bridge.ts",
      skipSemanticDiagnostics: true,
      testRuntime: true,
    },
  );
  expect(result.success).toBe(true);
  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary!, imports);
  (imports as { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance?.(instance);
  const exports = wrapExports(instance, { signatures: result.exportSignatures }) as Record<string, () => unknown>;
  exports.send();
  return captured;
}

async function captureNestedReactClass(): Promise<any> {
  let captured: unknown;
  const React = await import("react");
  (globalThis as Record<string, unknown>).__react4618 = React;
  (globalThis as Record<string, unknown>).__captureNestedClass4618 = (value: unknown) => {
    captured = value;
  };
  const result = await compile(
    `
      const React: any = (globalThis as any).__react4618;
      let Inner: any;
      export function send(): number {
        Inner = class extends React.Component {
          render(): any { return React.createElement("div", { className: this.props.name }); }
        };
        class Foo extends React.Component {
          render(): any { return React.createElement(Inner, { name: this.props.bar }); }
        }
        (globalThis as any).__captureNestedClass4618(Foo);
        return 1;
      }
    `,
    {
      fileName: "issue-4618-nested-react-class-bridge.ts",
      skipSemanticDiagnostics: true,
      testRuntime: true,
    },
  );
  expect(result.success).toBe(true);
  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary!, imports);
  (imports as { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance?.(instance);
  const exports = wrapExports(instance, { signatures: result.exportSignatures }) as Record<string, () => unknown>;
  exports.send();
  return captured;
}

async function renderNestedReactClassInsideWasm(): Promise<string[]> {
  const rendered: string[] = [];
  const React = await import("react");
  const ReactDOM = await import("react-dom");
  const ReactDOMClient = await import("react-dom/client");
  (globalThis as Record<string, unknown>).__react4618 = React;
  (globalThis as Record<string, unknown>).__reactDom4618 = ReactDOM;
  (globalThis as Record<string, unknown>).__reactDomClient4618 = ReactDOMClient;
  (globalThis as Record<string, unknown>).__captureRendered4618 = (value: unknown) => {
    rendered.push(String(value));
  };
  const result = await compile(
    `
      export function send(): number {
        const HostReact: any = (globalThis as any).__react4618;
        var reactExports: any = {};
        reactExports.Component = HostReact.Component;
        function ReactElement(type, key, props): any {
          return { $$typeof: Symbol.for("react.transitional.element"), type, key, ref: null, props };
        }
        var hasOwnProperty: any = Object.prototype.hasOwnProperty;
        reactExports.createElement = function(type, config, children): any {
          var propName, props: any = {}, key: any = null;
          if (config != null)
            for (propName in (config.key !== undefined && (key = "" + config.key), config))
              hasOwnProperty.call(config, propName) &&
                "key" !== propName &&
                "__self" !== propName &&
                "__source" !== propName &&
                (props[propName] = config[propName]);
          var childrenLength = arguments.length - 2;
          if (childrenLength === 1) props.children = children;
          else if (childrenLength > 1) {
            for (var childArray = Array(childrenLength), i = 0; i < childrenLength; i++)
              childArray[i] = arguments[i + 2];
            props.children = childArray;
          }
          if (type && type.defaultProps)
            for (propName in ((childrenLength = type.defaultProps), childrenLength))
              props[propName] === undefined && (props[propName] = childrenLength[propName]);
          return ReactElement(type, key, props);
        };
        let React;
        let ReactDOM;
        let ReactDOMClient;
        React = reactExports;
        ReactDOM = (globalThis as any).__reactDom4618;
        ReactDOMClient = (globalThis as any).__reactDomClient4618;
        const container: any = document.createElement("div");
        const root: any = ReactDOMClient.createRoot(container);
        let Inner: any;
        function runTest(element): void {
          ReactDOM.flushSync(() => root.render(element));
          (globalThis as any).__captureRendered4618(container.firstChild === null ? "NULL" : container.firstChild.className);
        }
        Inner = class extends React.Component {
          render(): any { return React.createElement("div", { className: this.props.name }); }
        };
        class Foo extends React.Component {
          render(): any { return React.createElement(Inner, { name: this.props.bar }); }
        }
        runTest(React.createElement(Foo, { bar: "foo" }));
        runTest(React.createElement(Foo, { bar: "bar" }));
        ReactDOM.flushSync(() => root.unmount());
        return 1;
      }
    `,
    {
      fileName: "issue-4618-nested-react-class-inside-wasm.ts",
      skipSemanticDiagnostics: true,
      testRuntime: true,
    },
  );
  expect(result.success).toBe(true);
  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary!, imports);
  (imports as { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance?.(instance);
  const exports = wrapExports(instance, { signatures: result.exportSignatures }) as Record<string, () => unknown>;
  exports.send();
  await new Promise<void>((resolve) => setImmediate(resolve));
  return rendered;
}

describe("#4618 assignment-position class expression host bridge", () => {
  it("is constructible and preserves the inherited class marker", async () => {
    const Inner = await captureAssignedClass();
    expect(typeof Inner).toBe("function");
    expect(Inner.prototype.isReactComponent != null).toBe(true);
    const instance = new Inner({ name: "ok" });
    expect(instance.props?.name).toBe("ok");
    expect(instance.render()).toBe("rendered:ok");
  });

  it("renders through the original host ReactDOM class-component path", async () => {
    const environment = installReactTestEnvironment();
    try {
      // This is a synchronous flushSync lifecycle check, not an act() test.
      // Suppress React's act-environment warning while retaining the upstream
      // environment's DOM/runtime setup and cleanup.
      (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
      const React = await import("react");
      const ReactDOM = await import("react-dom");
      const ReactDOMClient = await import("react-dom/client");
      const Inner = await captureAssignedClass(React.Component);
      const container = document.createElement("div");
      const root = ReactDOMClient.createRoot(container);
      ReactDOM.flushSync(() => root.render(React.createElement(Inner, { name: "ok" })));
      expect(container.textContent).toBe("rendered:ok");
      ReactDOM.flushSync(() => root.unmount());
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      environment.cleanup();
    }
  });

  it("runs an implicit compiled parent constructor with the derived receiver", async () => {
    const Inner = await captureAssignedClass(undefined, true);
    const instance = new Inner({ name: "compiled" });
    expect(instance.props?.name).toBe("compiled");
    expect(instance.render()).toBe("rendered:compiled");
  });

  it("runs an explicit super call against a runtime parent at the source position", async () => {
    const Inner = await captureAssignedClass(undefined, false, true);
    const instance = new Inner({ name: "explicit" });
    expect(instance.props?.name).toBe("explicit");
    expect(instance.state?.name).toBe("explicit");
    expect(instance.render()).toBe("rendered:explicit");
  });

  it("runs an explicit super call against a compiled function parent", async () => {
    const Inner = await captureAssignedClass(undefined, true, true);
    const instance = new Inner({ name: "fnctor" });
    expect(instance.props?.name).toBe("fnctor");
    expect(instance.state?.name).toBe("fnctor");
    expect(instance.render()).toBe("rendered:fnctor");
  });

  it("exposes an assigned class static method on its canonical host class", async () => {
    const Inner = await captureAssignedClass(undefined, false, false, true);
    expect(typeof Inner.derive).toBe("function");
    expect(Inner.derive({ foo: "next" }, { bar: "prev" })).toBe("next:prev");
    const derived = Inner.deriveObject({ foo: "next" }, { bar: "prev" });
    expect(derived.value).toBe("next:prev");
    expect(Object.keys(derived)).toEqual(["value"]);
    expect(Object.assign({}, derived)).toEqual({ value: "next:prev" });
  });

  it("keeps a host-replaced closed object field visible to compiled methods", async () => {
    let Captured: any;
    function HostBase(this: any, props: any) {
      this.props = props;
    }
    (globalThis as any).__hostStateBase4618 = HostBase;
    (globalThis as any).__captureStateClass4618 = (value: unknown) => {
      Captured = value;
    };
    const result = await compile(
      `
        class Stateful extends (globalThis as any).__hostStateBase4618 {
          state: any = { foo: "initial", bar: "kept" };
          read(): string { return this.state.foo + ":" + this.state.bar; }
        }
        export function send(): number {
          (globalThis as any).__captureStateClass4618(Stateful);
          return 1;
        }
      `,
      {
        fileName: "issue-4618-dynamic-parent-host-field-writeback.ts",
        skipSemanticDiagnostics: true,
        testRuntime: true,
      },
    );
    expect(result.success).toBe(true);
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary!, imports);
    (imports as { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance?.(instance);
    const exports = wrapExports(instance, { signatures: result.exportSignatures }) as Record<string, () => unknown>;
    exports.send();
    const value = new Captured({});
    expect(value.read()).toBe("initial:kept");
    value.state = { foo: "updated", bar: "kept" };
    expect(value.read()).toBe("updated:kept");
  });

  it("lets a host framework call a compiled static method during construction", async () => {
    const environment = installReactTestEnvironment();
    try {
      (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
      const React = await import("react");
      const ReactDOM = await import("react-dom");
      const ReactDOMClient = await import("react-dom/client");
      (globalThis as any).__react4618Static = React;
      const Inner = await captureAssignedClass(React.Component, false, false, false, true);
      const container = document.createElement("div");
      const root = ReactDOMClient.createRoot(container);
      ReactDOM.flushSync(() => root.render(React.createElement(Inner, { value: "next" })));
      expect(container.firstElementChild?.className).toBe("next:derived");
      ReactDOM.flushSync(() => root.unmount());
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      environment.cleanup();
    }
  });

  it("lets a host framework call a compiled static method with a compiled function parent", async () => {
    const environment = installReactTestEnvironment();
    try {
      (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
      const React = await import("react");
      const ReactDOM = await import("react-dom");
      const ReactDOMClient = await import("react-dom/client");
      (globalThis as any).__react4618Static = React;
      const Inner = await captureAssignedClass(undefined, true, false, false, true);
      const container = document.createElement("div");
      const root = ReactDOMClient.createRoot(container);
      ReactDOM.flushSync(() => root.render(React.createElement(Inner, { value: "next" })));
      expect(container.firstElementChild?.className).toBe("next:derived");
      ReactDOM.flushSync(() => root.unmount());
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      environment.cleanup();
    }
  });

  it("lets a host framework call a static method on a declared class", async () => {
    const environment = installReactTestEnvironment();
    try {
      (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
      const React = await import("react");
      const ReactDOM = await import("react-dom");
      const ReactDOMClient = await import("react-dom/client");
      (globalThis as any).__react4618Static = React;
      const Inner = await captureAssignedClass(undefined, true, false, false, true, true);
      const container = document.createElement("div");
      const root = ReactDOMClient.createRoot(container);
      ReactDOM.flushSync(() => root.render(React.createElement(Inner, { value: "next" })));
      expect(container.firstElementChild?.className).toBe("next:derived");
      ReactDOM.flushSync(() => root.unmount());
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      environment.cleanup();
    }
  });

  it("renders a nested assigned class returned from another compiled class", async () => {
    const environment = installReactTestEnvironment();
    try {
      (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
      const React = await import("react");
      const ReactDOM = await import("react-dom");
      const ReactDOMClient = await import("react-dom/client");
      const Foo = await captureNestedReactClass();
      const container = document.createElement("div");
      const root = ReactDOMClient.createRoot(container);
      ReactDOM.flushSync(() => root.render(React.createElement(Foo, { bar: "ok" })));
      expect(container.firstChild).not.toBeNull();
      expect(container.firstChild?.nodeName).toBe("DIV");
      expect((container.firstChild as HTMLElement).className).toBe("ok");
      ReactDOM.flushSync(() => root.unmount());
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      environment.cleanup();
    }
  });

  it("renders a nested assigned class through an in-Wasm run helper", async () => {
    const environment = installReactTestEnvironment();
    try {
      (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
      expect(await renderNestedReactClassInsideWasm()).toEqual(["foo", "bar"]);
    } finally {
      environment.cleanup();
    }
  });
});
