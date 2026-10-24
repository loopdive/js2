// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect } from "vitest";
import type { reserveRealmAsyncFrame } from "./native-realm-async-frame.js";
import {
  fillPreparedNativeAsyncFrame,
  type NativeFrameDependencies,
} from "../../src/backend/wasmgc/resources/prepared-native-async-frame.js";
import { PhysicalModuleReservations, type FunctionReservation } from "../../src/wasm/physical/module-reservations.js";

/** Production owner rejection checks; every failure must leave all four frame bodies unpublished. */
export function checkRealmFrameRejections(
  tx: PhysicalModuleReservations,
  control: ReturnType<typeof reserveRealmAsyncFrame>,
  alternate: FunctionReservation,
) {
  const { frame, dependencies: d } = control;
  const reject = (dependencies: NativeFrameDependencies, message?: RegExp) => {
    expect(() => fillPreparedNativeAsyncFrame(tx, frame, dependencies)).toThrow(message);
    expect(tx.state).toBe("filling");
    for (const role of ["entry", "resume", "fulfillStep", "rejectStep"] as const)
      expect(frame[role].object.body).toEqual([]);
  };
  reject({ ...d, objects: { ...d.objects, create: alternate } }, /foreign or copied/);
  reject({ ...d, objects: undefined! }, /foreign or copied/);
  reject({ ...d, objects: { ...d.objects } }, /foreign or copied/);
  for (const resolveValue of [undefined!, d.enqueue]) reject({ ...d, resolveValue });
  const bridges = new Map(d.bridges);
  bridges.set("number.box", bridges.get("number.unbox")!);
  reject({ ...d, bridges }, /signature mismatch/);
  reject(
    {
      ...d,
      assertAccepted() {
        throw Error("inventory incomplete");
      },
    },
    /inventory incomplete/,
  );
  reject({ ...d, reaction: d.promise }, /wrong native reaction layout/);
  let calls = 0;
  const changed = {
    ...d,
    assertAccepted() {
      if (++calls === 2) changed.objects = { ...d.objects };
    },
  };
  reject(changed, /changed dependency association/);
}
