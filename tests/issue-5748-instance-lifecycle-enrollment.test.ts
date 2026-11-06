// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it, vi } from "vitest";
import {
  createInstanceLifecycleAdapter,
  type InstanceLifecycleAdapter,
  type InstanceLifecycleEnrollment,
} from "../src/runtime/instance-lifecycle-adapter.js";

const exportsGetter = Object.getOwnPropertyDescriptor(WebAssembly.Instance.prototype, "exports")!.get!;
function brandedExports(instance: unknown): WebAssembly.Exports | undefined {
  try {
    return Reflect.apply(exportsGetter, instance, []) as WebAssembly.Exports;
  } catch {
    return undefined;
  }
}

function instance(): WebAssembly.Instance {
  return new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])));
}

function subject() {
  const wasm = instance();
  return { wasm, raw: wasm.exports as Record<string, Function> };
}

for (const setter of ["setExports", "setInstance"] as const) {
  describe(`legacy lifecycle ${setter}`, () => {
    const publish = (adapter: InstanceLifecycleAdapter, value: ReturnType<typeof subject>) => {
      if (setter === "setExports") adapter.setExports(value.raw);
      else adapter.setInstance(value.wasm);
    };
    const trusted = setter === "setInstance";

    it("publishes the prepared view rather than the raw export object", () => {
      const value = subject();
      const view = { marker: () => 1 };
      const adapter = createInstanceLifecycleAdapter({
        brandedExports,
        prepareExports: (raw, authority) => {
          expect(raw).toBe(value.raw);
          expect(authority).toBe(trusted);
          return view;
        },
      });
      adapter.callbackState.deferToExports(() => expect(adapter.callbackState.getExports()).toBe(view));
      publish(adapter, value);
      expect(adapter.callbackState.getExports()).toBe(view);
    });

    it("prepares with the old view, then publishes before draining in FIFO order", () => {
      const old = subject();
      const next = subject();
      const events: string[] = [];
      const adapter = createInstanceLifecycleAdapter({
        brandedExports,
        prepareExports: (raw, authority) => {
          expect(authority).toBe(trusted);
          if (raw === next.raw) {
            expect(adapter.callbackState.getExports()).toBe(old.raw);
            events.push("prepare");
          }
          return raw;
        },
      });
      publish(adapter, old);
      for (const name of ["first", "second"])
        adapter.callbackState.deferToExports(() => {
          expect(adapter.callbackState.getExports()).toBe(next.raw);
          events.push(name);
        });
      publish(adapter, next);
      expect(events).toEqual(["prepare", "first", "second"]);
    });

    it("retains the old view and queue when preparation throws", () => {
      const old = subject();
      const bad = subject();
      const marker = new Error("prepare");
      const operation = vi.fn();
      const adapter = createInstanceLifecycleAdapter({
        brandedExports,
        prepareExports: (raw) => {
          if (raw === bad.raw) throw marker;
          return raw;
        },
      });
      publish(adapter, old);
      adapter.callbackState.deferToExports(operation);
      expect(() => publish(adapter, bad)).toThrow(marker);
      expect(adapter.callbackState.getExports()).toBe(old.raw);
      expect(operation).not.toHaveBeenCalled();
      publish(adapter, old);
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it("shifts a throwing operation before calling it and retains the installed view and tail", () => {
      const value = subject();
      const marker = new Error("drain");
      const first = vi.fn(() => {
        throw marker;
      });
      const tail = vi.fn();
      const adapter = createInstanceLifecycleAdapter({ brandedExports, prepareExports: (raw) => raw });
      adapter.callbackState.deferToExports(first);
      adapter.callbackState.deferToExports(tail);
      expect(() => publish(adapter, value)).toThrow(marker);
      expect(adapter.callbackState.getExports()).toBe(value.raw);
      expect(first).toHaveBeenCalledTimes(1);
      expect(tail).not.toHaveBeenCalled();
      publish(adapter, value);
      expect(first).toHaveBeenCalledTimes(1);
      expect(tail).toHaveBeenCalledTimes(1);
    });

    it("repeats preparation and drains newly queued work on every installation", () => {
      const value = subject();
      const prepare = vi.fn((raw: Record<string, Function>) => raw);
      const adapter = createInstanceLifecycleAdapter({ brandedExports, prepareExports: prepare });
      publish(adapter, value);
      const queued = vi.fn();
      adapter.callbackState.deferToExports(queued);
      expect(queued).not.toHaveBeenCalled();
      publish(adapter, value);
      publish(adapter, value);
      expect(prepare).toHaveBeenCalledTimes(3);
      expect(queued).toHaveBeenCalledTimes(1);
    });

    it("drains reentrantly appended work after the already queued tail", () => {
      const events: string[] = [];
      const adapter = createInstanceLifecycleAdapter({ brandedExports, prepareExports: (raw) => raw });
      adapter.callbackState.deferToExports(() => {
        events.push("first");
        adapter.callbackState.deferToExports(() => events.push("appended"));
      });
      adapter.callbackState.deferToExports(() => events.push("tail"));
      publish(adapter, subject());
      expect(events).toEqual(["first", "tail", "appended"]);
    });

    it("lets a nested install drain the same queue and retain its replacement view", () => {
      const outer = subject();
      const inner = subject();
      const events: string[] = [];
      const adapter = createInstanceLifecycleAdapter({
        brandedExports,
        prepareExports: (raw) => {
          events.push(raw === outer.raw ? "outer" : "inner");
          return raw;
        },
      });
      adapter.callbackState.deferToExports(() => {
        events.push("first");
        adapter.callbackState.deferToExports(() => events.push("appended"));
        publish(adapter, inner);
        expect(adapter.callbackState.getExports()).toBe(inner.raw);
        events.push("resume");
      });
      adapter.callbackState.deferToExports(() => {
        expect(adapter.callbackState.getExports()).toBe(inner.raw);
        events.push("tail");
      });
      publish(adapter, outer);
      expect(events).toEqual(["outer", "first", "inner", "tail", "appended", "resume"]);
      expect(adapter.callbackState.getExports()).toBe(inner.raw);
    });

    it("publishes the outer prepared view after a successful reentrant prepare", () => {
      const outer = subject();
      const inner = subject();
      const views: unknown[] = [];
      const adapter = createInstanceLifecycleAdapter({
        brandedExports,
        prepareExports: (raw) => {
          if (raw === outer.raw) publish(adapter, inner);
          return raw;
        },
      });
      adapter.callbackState.deferToExports(() => views.push(adapter.callbackState.getExports()));
      publish(adapter, outer);
      expect(views).toHaveLength(1);
      expect(views[0]).toBe(inner.raw);
      expect(adapter.callbackState.getExports()).toBe(outer.raw);
    });

    it("does not roll back a nested installation when the outer prepare subsequently throws", () => {
      const outer = subject();
      const inner = subject();
      const marker = new Error("outer prepare");
      const adapter = createInstanceLifecycleAdapter({
        brandedExports,
        prepareExports: (raw) => {
          if (raw === outer.raw) {
            publish(adapter, inner);
            throw marker;
          }
          return raw;
        },
      });
      expect(() => publish(adapter, outer)).toThrow(marker);
      expect(adapter.callbackState.getExports()).toBe(inner.raw);
    });
  });
}

describe("adapter-owned inert instance enrollment", () => {
  it("retains raw exports without preparing, publishing, draining or altering start exports", () => {
    const old = subject();
    const next = subject();
    const prepare = vi.fn((raw: Record<string, Function>) => raw);
    const adapter = createInstanceLifecycleAdapter({ brandedExports, prepareExports: prepare });
    adapter.setExports(old.raw);
    const start = () => 1;
    adapter.callbackState.registerStartExport("start", start);
    const queued = vi.fn();
    adapter.callbackState.deferToExports(queued);
    const enrollment = adapter.enrollInstance(next.wasm);
    expect(Object.isFrozen(enrollment)).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(queued).not.toHaveBeenCalled();
    expect(adapter.callbackState.getExports()).toBe(old.raw);
    expect(adapter.callbackState.getStartExports()?.start).toBe(start);
    adapter.installEnrolledInstance(enrollment);
    expect(prepare).toHaveBeenLastCalledWith(next.raw, true);
    expect(adapter.callbackState.getExports()).toBe(next.raw);
    expect(queued).toHaveBeenCalledTimes(1);
  });

  it("does not publish when enrollment is the first operation", () => {
    const prepare = vi.fn((raw: Record<string, Function>) => raw);
    const adapter = createInstanceLifecycleAdapter({ brandedExports, prepareExports: prepare });
    adapter.enrollInstance(instance());
    expect(adapter.callbackState.getExports()).toBeUndefined();
    expect(adapter.callbackState.getStartExports()).toBeUndefined();
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each(["plain", "prototype", "proxy"])("rejects a forged %s instance without activation", (kind) => {
    const real = instance();
    const fake =
      kind === "plain"
        ? { exports: real.exports }
        : kind === "prototype"
          ? Object.create(WebAssembly.Instance.prototype)
          : new Proxy(real, {});
    const prepare = vi.fn((raw: Record<string, Function>) => raw);
    const adapter = createInstanceLifecycleAdapter({ brandedExports, prepareExports: prepare });
    const queued = vi.fn();
    adapter.callbackState.deferToExports(queued);
    expect(() => adapter.enrollInstance(fake)).toThrow("enrollInstance: expected a genuine WebAssembly.Instance");
    expect(() => adapter.setInstance(fake)).toThrow("setInstance: expected a genuine WebAssembly.Instance");
    expect(prepare).not.toHaveBeenCalled();
    expect(queued).not.toHaveBeenCalled();
    expect(adapter.callbackState.getExports()).toBeUndefined();
  });

  it("rejects foreign, copied, inherited and proxied handles before mutation", () => {
    const first = createInstanceLifecycleAdapter({ brandedExports, prepareExports: (raw) => raw });
    const prepare = vi.fn((raw: Record<string, Function>) => raw);
    const second = createInstanceLifecycleAdapter({ brandedExports, prepareExports: prepare });
    const old = subject();
    second.setExports(old.raw);
    const queued = vi.fn();
    second.callbackState.deferToExports(queued);
    const foreign = first.enrollInstance(instance());
    const local = second.enrollInstance(instance());
    for (const fake of [foreign, { ...local }, Object.create(local), new Proxy(local, {})]) {
      expect(() => second.installEnrolledInstance(fake)).toThrow("foreign or forged enrollment");
      expect(second.callbackState.getExports()).toBe(old.raw);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(queued).not.toHaveBeenCalled();
    }
    second.installEnrolledInstance(local);
    expect(queued).toHaveBeenCalledTimes(1);
  });

  it("retains each enrollment's raw identity and permits repeated legacy installation", () => {
    const a = subject();
    const b = subject();
    const prepare = vi.fn((raw: Record<string, Function>) => raw);
    const adapter = createInstanceLifecycleAdapter({ brandedExports, prepareExports: prepare });
    const first = adapter.enrollInstance(a.wasm);
    const second = adapter.enrollInstance(b.wasm);
    expect(first).not.toBe(second);
    adapter.installEnrolledInstance(second);
    adapter.installEnrolledInstance(first);
    adapter.installEnrolledInstance(first);
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(prepare.mock.calls[0]![0]).toBe(b.raw);
    expect(prepare.mock.calls[1]![0]).toBe(a.raw);
    expect(prepare.mock.calls[2]![0]).toBe(a.raw);
    expect(adapter.callbackState.getExports()).toBe(a.raw);
  });
});

// Compile-only opacity checks; not executed and not a runtime authority proof.
function enrollmentTypes(adapter: InstanceLifecycleAdapter) {
  // @ts-expect-error Enrollment cannot be constructed structurally by callers.
  const forged: InstanceLifecycleEnrollment = {};
  // @ts-expect-error Raw instance is not an adapter-owned enrollment handle.
  adapter.installEnrolledInstance(instance());
  return forged;
}
void enrollmentTypes;
