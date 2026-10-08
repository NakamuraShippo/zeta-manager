// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startSpeakerShortcuts } from "../src/content/speaker-shortcuts";
let stop: () => void;
let input: HTMLTextAreaElement;
let buttons: HTMLButtonElement[];
let clicked: ReturnType<typeof vi.fn>[];
beforeEach(() => {
  document.body.innerHTML = `<div data-sentry-component="ChatComposer"><div data-sentry-component="SpeakerRecommendationStrip">${Array.from({ length: 10 }, (_, i) => `<button data-sentry-component="LogRawButton">${i ? `人物${i}` : "ナレーター"}</button>`).join("")}</div><textarea name="message">@</textarea></div><input id="other">`;
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  input = document.querySelector("textarea")!;
  buttons = Array.from(document.querySelectorAll("button"));
  clicked = buttons.map((button) => { const fn = vi.fn(); button.onclick = fn; return fn; });
  stop = startSpeakerShortcuts();
  input.focus();
});
afterEach(() => { stop(); vi.restoreAllMocks(); });
function key(key: string, code = key, extra: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true, ...extra });
  document.activeElement!.dispatchEvent(event);
  return event;
}
it("左右で移動しEnterでクリック、入力欄へ戻る", () => {
  expect(key("ArrowRight").defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(buttons[0]);
  key("ArrowRight");
  expect(document.activeElement).toBe(buttons[1]);
  key("ArrowLeft");
  key("Enter");
  expect(clicked[0]).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(input);
});
it.each(["Digit", "Numpad"])("%s の1〜9、0で対応する候補を選ぶ", (prefix) => {
  for (let n = 0; n < 10; n++) {
    key(String(n), `${prefix}${n}`);
    expect(clicked[n === 0 ? 9 : n - 1]).toHaveBeenCalledTimes(1);
  }
});
it("左から開始すると末尾へ移動する", () => {
  key("ArrowLeft");
  expect(document.activeElement).toBe(buttons[9]);
  key("ArrowRight");
  expect(document.activeElement).toBe(buttons[0]);
});
it("候補が閉じていると数字・矢印を奪わない", () => {
  document.querySelector<HTMLElement>('[data-sentry-component="SpeakerRecommendationStrip"]')!.hidden = true;
  expect(key("1", "Digit1").defaultPrevented).toBe(false);
  expect(key("ArrowLeft").defaultPrevented).toBe(false);
});
it.each([{ isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { metaKey: true }])("IME・修飾キーを妨げない %j", (extra) => {
  expect(key("1", "Digit1", extra).defaultPrevented).toBe(false);
  expect(clicked[0]).not.toHaveBeenCalled();
});
it("無関係な入力欄・存在しない番号・通常Enterを妨げない", () => {
  expect(key("Enter").defaultPrevented).toBe(false);
  buttons[9].remove();
  expect(key("0", "Digit0").defaultPrevented).toBe(false);
  document.querySelector<HTMLInputElement>("#other")!.focus();
  expect(key("1", "Digit1").defaultPrevented).toBe(false);
});
it("数字の長押しと重複初期化で二重クリックしない", () => {
  startSpeakerShortcuts();
  key("1", "Digit1");
  key("1", "Digit1", { repeat: true });
  expect(clicked[0]).toHaveBeenCalledTimes(1);
});
it("遷移後の新しい入力欄も対象になる", () => {
  const composer = input.parentElement!;
  const clone = composer.cloneNode(true) as HTMLElement;
  composer.replaceWith(clone);
  const click = vi.fn();
  clone.querySelector("button")!.onclick = click;
  clone.querySelector("textarea")!.focus();
  key("1", "Digit1");
  expect(click).toHaveBeenCalledTimes(1);
});
