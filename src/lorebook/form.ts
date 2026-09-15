import { type LoreEntry, validateLoreEntry } from "./markdown";

const ROW = '[data-sentry-component="LorebookItemRow"]';
type Field = HTMLInputElement | HTMLTextAreaElement;
const rows = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>(ROW));
const field = (row: HTMLElement, key: string) => row.querySelector<Field>(`[name^="items."][name$=".${key}"]`);

export function findLorebookRoot(doc: Document = document): HTMLElement | null {
  const matches = Array.from(doc.querySelectorAll<HTMLElement>(ROW)).map((r) => r.parentElement?.parentElement);
  return matches.find((root) => root && findAddButton(root)) ?? null;
}

function findAddButton(root: HTMLElement): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll<HTMLButtonElement>("button"))
    .find((button) => /^\+?\s*項目追加\s*[（(]/.test(button.textContent?.trim() ?? ""));
}

export async function fillLorebook(
  root: HTMLElement, entries: LoreEntry[],
  onProgress: (completed: number, total: number) => void = () => {},
  signal?: AbortSignal,
): Promise<void> {
  if (!entries.length || entries.length > 50) throw new Error("項目数は1〜50件にしてください。");
  entries.forEach((entry, i) => validateLoreEntry(entry, i + 1));
  const initialUrl = root.ownerDocument.location.href;
  const check = () => {
    if (signal?.aborted) throw new Error("入力を中止しました。入力済みの項目は残っています。");
    if (!root.isConnected || root.ownerDocument.location.href !== initialUrl) throw new Error("編集画面が変わったため停止しました。");
  };
  const wait = async (condition: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (true) {
      check();
      if (condition()) return;
      if (Date.now() >= deadline) throw new Error("入力欄の表示待ちがタイムアウトしました。");
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  };
  const open = async (index: number) => {
    check();
    const row = rows(root)[index];
    if (!row) throw new Error("項目の構造が変わりました。");
    if (!field(row, "name")) {
      // ゴミ箱ではなく、HTML資料で確認したヘッダーの展開ボタンのみ操作する。
      const toggle = row.querySelector<HTMLButtonElement>('button[data-sentry-element="RawButton"]');
      if (!toggle) throw new Error("項目を展開するボタンが見つかりません。");
      toggle.click();
    }
    await wait(() => ["name", "keywords", "content"].every((key) => !!field(rows(root)[index], key)));
  };
  const read = (index: number) => ["name", "keywords", "content"].map((key) => field(rows(root)[index], key)?.value ?? "");
  const empty = (values: string[]) => values.every((value) => value === "");

  // 全項目を確認してから書き始める。折りたたまれた入力済み項目も保持する。
  const originalCount = rows(root).length;
  if (originalCount > 50) throw new Error("画面の項目数が上限を超えています。");
  const blanks: number[] = [];
  const original: string[][] = [];
  for (let i = 0; i < originalCount; i++) {
    await open(i);
    const values = read(i);
    original.push(values);
    if (empty(values)) blanks.push(i);
  }
  if (entries.length > blanks.length + 50 - originalCount) throw new Error("入力済み項目を残すと50件を超えます。ファイルの項目数を減らしてください。");
  onProgress(0, entries.length);
  const expected = new Map<number, string[]>();
  original.forEach((values, i) => expected.set(i, values));
  const verify = async () => {
    for (const [index, values] of expected) {
      await open(index);
      if (JSON.stringify(read(index)) !== JSON.stringify(values)) throw new Error("画面の入力内容が変わったため停止しました。入力結果を確認してください。");
    }
  };
  let count = originalCount;
  for (let i = 0; i < entries.length; i++) {
    check();
    if (rows(root).length !== count) throw new Error("項目数が変わったため停止しました。");
    let index = blanks[i];
    if (index === undefined) {
      const add = findAddButton(root);
      if (!add || add.disabled || count >= 50) throw new Error("項目を追加できません。");
      add.click();
      await wait(() => rows(root).length === count + 1);
      index = count++;
    }
    await open(index);
    if (!empty(read(index))) throw new Error("入力先に既存の内容があるため停止しました。");
    const values = [entries[i].title, entries[i].keywords.join("、"), entries[i].content];
    for (const [n, key] of ["name", "keywords", "content"].entries()) {
      check();
      const input = field(rows(root)[index], key)!;
      if (input.disabled || input.readOnly) throw new Error("入力欄が編集できません。");
      const proto = input.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, values[n]);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 40));
      check();
      if (field(rows(root)[index], key)?.value !== values[n]) throw new Error("入力が画面に反映されませんでした。処理を停止しました。");
    }
    expected.set(index, values);
    onProgress(i + 1, entries.length);
  }
  await verify();
}
