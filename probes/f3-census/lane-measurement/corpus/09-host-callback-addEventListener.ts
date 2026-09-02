export function install(target: EventTarget, sink: HTMLElement, value: number): void {
  target.addEventListener("tick", () => {
    sink.textContent = value.toString();
  });
}
