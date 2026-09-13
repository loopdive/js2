// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyObservation } from "../scripts/audit-javascript-soundness.mjs";

function observe(source: string, lane = "node"): Promise<any> {
  return new Promise((resolve, reject) => {
    const worker = fork(fileURLToPath(new URL("../scripts/audit-javascript-soundness-probe.ts", import.meta.url)), [], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let observation: unknown;
    let stderr = "";
    const timeout = setTimeout(() => {
      worker.kill();
      reject(new Error("Worker control timed out"));
    }, 30_000);
    worker.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    worker.on("message", (message: any) => {
      if (message.type === "observation") observation = message.observation;
    });
    worker.on("error", reject);
    worker.on("exit", () => {
      clearTimeout(timeout);
      if (observation) resolve(observation);
      else reject(new Error(`Worker ended without observation: ${stderr}`));
    });
    worker.send({
      specimen: { id: "worker-control", source, sourceHash: createHash("sha256").update(source).digest("hex") },
      lane,
      timeoutMs: 25_000,
      maxOutput: 100_000,
    });
  });
}

describe("#5393: real worker observation controls", () => {
  it.each(["node", "host", "standalone"])("proves empty output completed on %s", async (lane) => {
    const row = await observe("const x = 1;", lane);
    expect(row.status).toBe("normal");
    expect(row.syncComplete).toBe(true);
    expect(row.stdout).toBe("");
    expect(row.stderr).toBe("");
  });

  it("records an uncaught primitive with its actual type", async () => {
    const row = await observe('console.log("before"); throw 7;');
    expect(row.status).toBe("abrupt");
    expect(row.stdout).toBe("before\n");
    expect(row.syncComplete).toBe(false);
    expect(row.thrown).toEqual({ comparable: true, identity: { type: "number", value: "7" } });
  });

  it("records an uncaught native error class", async () => {
    const row = await observe('throw new TypeError("control");');
    expect(row.status).toBe("abrupt");
    expect(row.thrown).toEqual({ comparable: true, identity: { type: "error", name: "TypeError" } });
  });

  it("does not execute an Error name getter while observing the throw", async () => {
    const row = await observe(
      'const e=new Error("control");Object.defineProperty(e,"name",{get(){console.log("GETTER RAN");return "TypeError";}});throw e;',
    );
    expect(row.status).toBe("abrupt");
    expect(row.stdout).toBe("");
    expect(row.thrown.comparable).toBe(false);
    expect(classifyObservation(row, row)).toBe("inconclusive");
  });

  it("keeps opaque object throws inconclusive without invoking getters", async () => {
    const row = await observe('throw {get name(){console.log("GETTER RAN");return "Error";}};');
    expect(row.status).toBe("abrupt");
    expect(row.stdout).toBe("");
    expect(row.thrown.comparable).toBe(false);
    expect(classifyObservation(row, row)).toBe("inconclusive");
  });

  it("never compares a compiler exception as a program exception", () => {
    const abrupt = {
      status: "abrupt",
      stdout: "",
      stderr: "",
      thrown: { comparable: true, identity: { type: "error", name: "TypeError" } },
    };
    expect(classifyObservation(abrupt, { ...abrupt, status: "compiler_exception" })).toBe("compiler_exception");
  });
});
