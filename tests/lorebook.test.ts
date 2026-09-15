// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLoreMarkdown, type LoreEntry } from "../src/lorebook/markdown";
import { fillLorebook, findLorebookRoot } from "../src/lorebook/form";
import { startLorebookImporter } from "../src/lorebook/importer";

const entry = (title = "王都"): LoreEntry => ({ title, keywords: ["王都", "アルマ"], content: "王国の中心。\n城があります。" });
beforeEach(() => { vi.useFakeTimers(); document.body.replaceChildren(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("ロアブックのMarkdown", () => {
  it("BOM・CRLF・複数項目・日本語区切りを読み取り、本文の改行を保持する", () => {
    expect(parseLoreMarkdown("\uFEFF# 設定集\r\n\r\n## 王都\r\nキーワード： 王都, アルマ\r\n\r\n王国の中心。\r\n城があります。\r\n\r\n## 学院\r\nキーワード: 学院、学校\r\n\r\n学びの場。"))
      .toEqual([entry(), { title: "学院", keywords: ["学院", "学校"], content: "学びの場。" }]);
  });
  it.each([
    "", "説明だけ", "## 題名\n本文だけ", "## 題名\nキーワード:\n本文",
    `## ${"題".repeat(21)}\nキーワード: 単語\n本文`,
    `## 題名\nキーワード: ${"語".repeat(21)}\n本文`,
    "## 題名\nキーワード: a,b,c,d,e,f\n本文",
    `## 題名\nキーワード: 単語\n${"文".repeat(501)}`,
    "## 題名\nキーワード: 単語\n",
    Array.from({ length: 51 }, (_, i) => `## 題${i}\nキーワード: 単語\n本文`).join("\n"),
  ])("不正・制限超過のファイルを拒否する %#", (source) => {
    expect(() => parseLoreMarkdown(source)).toThrow();
  });
});

function form(values: (LoreEntry | null)[], collapsed = false) {
  const root = document.createElement("section");
  const list = document.createElement("div");
  const add = document.createElement("button");
  add.textContent = "項目追加(1/50)";
  const submitted = vi.fn();
  const submit = document.createElement("button");
  submit.textContent = "登録";
  submit.onclick = submitted;
  const events: string[] = [];
  const append = (value: LoreEntry | null, folded = false) => {
    const index = list.children.length;
    const row = document.createElement("div");
    row.dataset.sentryComponent = "LorebookItemRow";
    const toggle = document.createElement("button");
    toggle.dataset.sentryElement = "RawButton";
    const trash = document.createElement("button");
    trash.onclick = () => { throw new Error("削除してはいけない"); };
    const expand = () => {
      if (row.querySelector("input")) return;
      for (const [i, key] of ["name", "keywords", "content"].entries()) {
        const input = document.createElement(i === 0 ? "input" : "textarea");
        input.name = `items.${index}.${key}`;
        input.value = value ? [value.title, value.keywords.join("、"), value.content][i] : "";
        input.addEventListener("input", () => {
          events.push(input.name);
          // React等の更新後も値が保持されることを模擬する。
          const replacement = input.cloneNode() as HTMLInputElement;
          replacement.value = input.value;
          input.replaceWith(replacement);
        });
        row.append(input);
      }
    };
    toggle.onclick = expand;
    row.append(toggle, trash);
    list.append(row);
    if (!folded) expand();
  };
  values.forEach((value) => append(value, collapsed));
  add.onclick = () => { append(null); add.textContent = `項目追加(${list.children.length}/50)`; };
  root.append(list, add);
  document.body.append(root, submit);
  return { root, list, add, submitted, events };
}

async function settle(promise: Promise<void>) {
  const result = promise.then(() => null, (error: Error) => error);
  await vi.runAllTimersAsync();
  return result;
}

describe("ロアブックへの入力", () => {
  it("ファイル選択後に内容を確認でき、入力ボタンを押して初めて反映する", async () => {
    const { root, events } = form([null]);
    startLorebookImporter();
    const shadow = root.querySelector("[data-zlc-lore-import]")!.shadowRoot!;
    const input = shadow.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [{ size: 100, text: async () => "## テスト\nキーワード: 単語\n\n<img src=x onerror=alert(1)>" }] });
    input.dispatchEvent(new Event("change"));
    await vi.advanceTimersByTimeAsync(0);
    expect(shadow.querySelector("pre")!.textContent).toContain("<img");
    expect(shadow.querySelector("img")).toBeNull();
    expect(events).toHaveLength(0);
    const fill = shadow.querySelector<HTMLButtonElement>('[data-action="fill"]')!;
    expect(fill.disabled).toBe(false);
    fill.click();
    await vi.advanceTimersByTimeAsync(500);
    expect(events).toHaveLength(3);
    expect(shadow.querySelector('[role="status"]')!.textContent).toContain("1件の入力を確認");
    expect(fill.disabled).toBe(true);
  });

  it("折りたたまれた入力済み項目を保持し、空項目と追加項目へ入力する", async () => {
    const { root, list, submitted, events } = form([entry("既存"), null], true);
    expect(findLorebookRoot()).toBe(root);
    expect(await settle(fillLorebook(root, [entry("新規1"), entry("新規2")]))).toBeNull();
    expect(list.children.length).toBe(3);
    expect(Array.from(root.querySelectorAll<HTMLInputElement>("input")).map((e) => e.value))
      .toEqual(["既存", "新規1", "新規2"]);
    expect(events).toHaveLength(6);
    expect(submitted).not.toHaveBeenCalled();
  });

  it("最大50件を追加して最後の内容まで検証する", async () => {
    const { root, list } = form([null, null]);
    const entries = Array.from({ length: 50 }, (_, i) => entry(`項目${i + 1}`));
    expect(await settle(fillLorebook(root, entries))).toBeNull();
    expect(list.children.length).toBe(50);
    expect(root.querySelector<HTMLTextAreaElement>('[name="items.49.content"]')!.value).toBe(entries[49].content);
  });

  it("既存内容を含めて上限を超える場合は書き込まない", async () => {
    const { root, list, events } = form(Array.from({ length: 50 }, () => entry()));
    expect((await settle(fillLorebook(root, [entry()])))?.message).toContain("50件");
    expect(list.children.length).toBe(50);
    expect(events).toHaveLength(0);
  });

  it("入力前のキャンセルでは変更しない", async () => {
    const { root, events } = form([null]);
    const controller = new AbortController();
    controller.abort();
    expect((await settle(fillLorebook(root, [entry()], undefined, controller.signal)))?.message).toContain("中止");
    expect(events).toHaveLength(0);
  });

  it("画面が閉じられたら残りの入力を停止する", async () => {
    const { root } = form([null]);
    setTimeout(() => root.remove(), 10);
    expect((await settle(fillLorebook(root, [entry()])))?.message).toContain("画面が変わった");
  });
});
