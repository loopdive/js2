// (#7013) Worker thread for `runStandaloneUpstreamTestsIsolated`: runs one
// zero-import standalone test module from `startIndex`, posting each result.
import { parentPort, workerData } from "node:worker_threads";

import { standaloneRunWorkerMain } from "./upstream-standalone-lane.mjs";

await standaloneRunWorkerMain(workerData, (message) => parentPort.postMessage(message));
