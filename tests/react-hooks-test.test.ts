import { describe, it, expect } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import { buildImports as buildHostImports } from "../src/runtime.js";

// (#7032) This file used to hand-roll the host `env`, listing only the imports
// its programs needed when it was written. The JS-host lane has since grown
// real-semantics imports for the same programs (`__register_prototype` for
// every class, 5ff86e89f5 #5347; real `TypeError` instances via
// `__new_TypeError`, #3287; `__get_undefined`, `__call_function_N`, ...), and
// each one turned a passing test into an instantiate-time LinkError. Link
// against the production resolver instead: it is the import contract the
// compiler actually emits against.
function buildImports(result: CompileResult) {
  return buildHostImports(result.imports, undefined, result.stringPool);
}

async function compileToWasm(source: string) {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const imports = buildImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return instance.exports as Record<string, Function>;
}

const HOOKS_SOURCE = `
class HookState {
  memoizedState: number;
  next: HookState | null = null;
  constructor(initial: number) { this.memoizedState = initial; }
}

let firstHook: HookState | null = null;
let currentHook: HookState | null = null;
let lastHook: HookState | null = null;

function useState(initial: number): number {
  if (currentHook === null) {
    const hook = new HookState(initial);
    if (firstHook === null) { firstHook = hook; }
    if (lastHook !== null) { lastHook.next = hook; }
    lastHook = hook;
    currentHook = hook;
  }
  const value = currentHook.memoizedState;
  currentHook = currentHook.next;
  return value;
}

function setState(hookIndex: number, newValue: number): void {
  let hook = firstHook;
  let i = 0;
  while (hook !== null && i < hookIndex) { hook = hook.next; i = i + 1; }
  if (hook !== null) { hook.memoizedState = newValue; }
}

function resetHooks(): void {
  currentHook = firstHook;
}
`;

describe("Issue #469: React hooks state machine", () => {
  it("useState returns initial value", async () => {
    const exports = await compileToWasm(`
      ${HOOKS_SOURCE}
      export function test(): number {
        const count = useState(42);
        return count;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("setState updates hook and re-render reads new value", async () => {
    const exports = await compileToWasm(`
      ${HOOKS_SOURCE}

      function render(): number {
        const count = useState(0);
        return count;
      }

      export function test(): number {
        // First render: initializes hook with 0
        const v1 = render();
        // Update state to 99
        setState(0, 99);
        // Re-render: reset cursor and read updated value
        resetHooks();
        const v2 = render();
        return v1 + v2;  // 0 + 99 = 99
      }
    `);
    expect(exports.test()).toBe(99);
  });

  it("multiple useState hooks form linked list", async () => {
    const exports = await compileToWasm(`
      ${HOOKS_SOURCE}

      function render(): number {
        const a = useState(10);
        const b = useState(20);
        const c = useState(30);
        return a + b + c;
      }

      export function test(): number {
        return render();
      }
    `);
    expect(exports.test()).toBe(60);
  });

  it("setState on second hook in linked list", async () => {
    const exports = await compileToWasm(`
      ${HOOKS_SOURCE}

      function render(): number {
        const a = useState(10);
        const b = useState(20);
        return a + b;
      }

      export function test(): number {
        const v1 = render();
        // Update second hook (index 1) to 50
        setState(1, 50);
        resetHooks();
        const v2 = render();
        return v2;  // 10 + 50 = 60
      }
    `);
    expect(exports.test()).toBe(60);
  });

  it("self-referencing struct with null field", async () => {
    const exports = await compileToWasm(`
      class Node {
        value: number;
        next: Node | null = null;
        constructor(v: number) { this.value = v; }
      }

      export function test(): number {
        const n = new Node(42);
        if (n.next === null) {
          return n.value;
        }
        return 0;
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("linked list traversal with while loop", async () => {
    const exports = await compileToWasm(`
      class Node {
        value: number;
        next: Node | null = null;
        constructor(v: number) { this.value = v; }
      }

      export function test(): number {
        const a = new Node(1);
        const b = new Node(2);
        const c = new Node(3);
        a.next = b;
        b.next = c;

        let sum = 0;
        let current: Node | null = a;
        while (current !== null) {
          sum = sum + current.value;
          current = current.next;
        }
        return sum;
      }
    `);
    expect(exports.test()).toBe(6);
  });

  it("mutation of struct field through linked list", async () => {
    const exports = await compileToWasm(`
      class Node {
        value: number;
        next: Node | null = null;
        constructor(v: number) { this.value = v; }
      }

      export function test(): number {
        const a = new Node(10);
        const b = new Node(20);
        a.next = b;

        // Mutate b's value through a.next
        let target: Node | null = a.next;
        if (target !== null) {
          target.value = 99;
        }

        return b.value;
      }
    `);
    expect(exports.test()).toBe(99);
  });
});
