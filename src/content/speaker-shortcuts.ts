/** 「@」で開く話者候補を操作する。本文やReactの状態を直接変更せず既存ボタンを押す。 */
export function startSpeakerShortcuts(doc: Document = document): () => void {
  const styleId = "zm-speaker-shortcuts";
  if (doc.getElementById(styleId)) return () => {};
  const style = doc.createElement("style");
  style.id = styleId;
  style.textContent = '[data-zm-speaker-selected]{outline:2px solid #7aa2ff!important;outline-offset:-2px}';
  doc.head.append(style);
  const clear = () => doc.querySelectorAll("[data-zm-speaker-selected]")
    .forEach((element) => element.removeAttribute("data-zm-speaker-selected"));
  const visible = (element: HTMLElement) => !element.closest('[hidden],[inert],[aria-hidden="true"]') &&
    element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
  const keydown = (event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229 || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const composer = target.closest('[data-sentry-component="ChatComposer"]');
    if (!composer) return;
    const input = composer.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
    const strip = composer.querySelector<HTMLElement>('[data-sentry-component="SpeakerRecommendationStrip"]');
    if (!input || input.disabled || input.readOnly || !strip || !visible(strip)) return;
    const buttons = Array.from(strip.querySelectorAll<HTMLButtonElement>('button[data-sentry-component="LogRawButton"]'))
      .filter((button) => !button.disabled && button.getAttribute("aria-disabled") !== "true" && visible(button));
    const current = buttons.indexOf(target as HTMLButtonElement);
    if (target !== input && current < 0) return;
    let index: number;
    let activate = false;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (!buttons.length) return;
      index = current < 0 ? (event.key === "ArrowRight" ? 0 : buttons.length - 1)
        : (current + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    } else if (/^[0-9]$/.test(event.key) && /^(Digit|Numpad)[0-9]$/.test(event.code)) {
      index = event.key === "0" ? 9 : Number(event.key) - 1;
      activate = true;
    } else if (event.key === "Enter" && current >= 0) {
      index = current;
      activate = true;
    } else return;
    const button = buttons[index];
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (activate && event.repeat) return;
    clear();
    if (activate) {
      button.click();
      if (input.isConnected) input.focus({ preventScroll: true });
    } else {
      button.setAttribute("data-zm-speaker-selected", "");
      button.focus({ preventScroll: true });
      button.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    }
  };
  const host = doc.defaultView!;
  host.addEventListener("keydown", keydown, true);
  doc.addEventListener("pointerdown", clear, true);
  return () => {
    host.removeEventListener("keydown", keydown, true);
    doc.removeEventListener("pointerdown", clear, true);
    clear();
    style.remove();
  };
}
