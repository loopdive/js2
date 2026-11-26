// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { realmLayoutFixture } from "./helpers/native-realm-object-layouts.js";
import {
  fillNativeRealmObjectLayouts,
  requireCompletedNativeRealmObjectLayouts,
} from "../src/backend/wasmgc/resources/native-realm-object-layouts.js";

// The layout audit runs at the seal (#7354 Perf4): a global altered during the canonical comparison is reported there,
// so only an unsealed ledger can still report it.
for (const sealed of [false, true]) {
  for (const attack of sealed ? (["none"] as const) : (["none", "realm", "functionPrototype"] as const)) {
    it(`completes through the canonical comparison, sealed=${sealed}, attack=${attack}`, () => {
      const { tx, pack } = realmLayoutFixture();
      let armed = false;
      let visits = 0;
      const fill = tx.fillFunction.bind(tx);
      tx.fillFunction = (token, definition) =>
        fill(
          token,
          token === pack.sourceInitializer
            ? {
                ...definition,
                body: new Proxy(definition.body, {
                  ownKeys(target) {
                    if (armed && visits === 0) {
                      visits++;
                      if (attack !== "none") pack.anchors[attack].object.init.push({ op: "nop" });
                    }
                    return Reflect.ownKeys(target);
                  },
                }),
              }
            : definition,
        );
      tx.freezeReservations();
      fillNativeRealmObjectLayouts(tx, pack);
      expect(requireCompletedNativeRealmObjectLayouts(tx, pack)).toBe(pack);
      if (sealed) tx.seal();
      let completionAudited = false;
      const audit = tx.assertCompletedReservation.bind(tx);
      tx.assertCompletedReservation = (token) => {
        audit(token);
        if (token === pack.sourceInitializer) completionAudited = true;
      };
      const index = tx.physicalIndex.bind(tx);
      tx.physicalIndex = (token) => {
        const result = index(token);
        // Arm only after the genuine final lookup used to build the expected initializer.
        if (completionAudited && token === pack.types.state) armed = true;
        return result;
      };
      expect(requireCompletedNativeRealmObjectLayouts(tx, pack)).toBe(pack);
      expect(visits).toBe(1);
      if (attack === "none") {
        expect(tx.state).toBe(sealed ? "sealed" : "filling");
      } else {
        expect(() => tx.seal()).toThrow(`altered completed global ${pack.anchors[attack].key}`);
        expect(tx.state).toBe("failed");
      }
    });
  }
}
