// Own stdout is the worker's inherited pipe. Natural exit releases it.
process.send?.({ pid: process.pid, parentPid: process.ppid });
setTimeout(() => process.exit(0), 350);
