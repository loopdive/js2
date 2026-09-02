export function install(target: EventTarget, sink: HTMLElement): void {
  target.addEventListener("tick", () => {
    sink.textContent = "exact";
  });
}
