import { parentPort } from "node:worker_threads";
import { serveNodeEvalWorker } from "../../src/runtime-node-eval-worker.ts";

if (parentPort === null) throw new Error("eval Worker fixture requires worker_threads");

serveNodeEvalWorker(parentPort);
