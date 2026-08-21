/** Return Web API constructors that are supplied by the active JS host. */
export function getWebHostConstructors(): Record<string, Function> {
  return Object.fromEntries(
    "MessageChannel MessagePort ReadableStream WritableStream TransformStream TextEncoder TextDecoder Headers Request Response FormData Blob File AbortController AbortSignal IntersectionObserver"
      .split(" ")
      .filter((name) => typeof (globalThis as any)[name] === "function")
      .map((name) => [name, (globalThis as any)[name]]),
  );
}
