import { expect, it } from "vitest";
import { compile, compileMulti } from "../src/index.ts";

for (const multi of [false, true]) {
  it(`re-exports the original mutable Symbol globals (multi=${multi})`, async () => {
    async function build(state: "export" | { module: string; reexport?: boolean }, imports = {}) {
      const source = `export function registered():any{return Symbol.for('shared');}
        export function fresh():any{return Symbol('fresh');}
        export function description(v:any):number{return v.description.length;}`;
      const options = {
        target: "standalone" as const,
        standaloneSymbolState: state,
        ...(state === "export" ? {} : { link: [state.module] }),
      };
      const r = multi
        ? await compileMulti({ "/state.ts": source }, "/state.ts", options)
        : await compile(source, options);
      expect(r.success, JSON.stringify(r.errors)).toBe(true);
      const e = (await WebAssembly.instantiate(r.binary as BufferSource, imports)).instance.exports;
      (e.__module_init as Function | undefined)?.();
      return e as Record<string, any>;
    }
    const owner = await build("export");
    const relay = await build({ module: "owner", reexport: true }, { owner });
    const peer = await build({ module: "relay" }, { relay });
    const names = [
      "__symbol_counter",
      "__symbol_desc_table",
      "__symbol_intern_table",
      "__symbol_reg_keys",
      "__symbol_reg_ids",
      "__symbol_reg_count",
    ];
    for (const name of names) {
      expect(owner[name]).toBeInstanceOf(WebAssembly.Global);
      expect(relay[name] === owner[name]).toBe(true);
    }
    expect(relay.registered() === owner.registered()).toBe(true);
    expect(peer.registered() === owner.registered()).toBe(true);
    const fresh = owner.fresh();
    expect(peer.description(fresh)).toBe(5);
    expect(peer.fresh() === fresh).toBe(false);
  });
}
