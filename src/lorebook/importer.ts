import { findLorebookRoot, fillLorebook } from "./form";
import { type LoreEntry, parseLoreMarkdown } from "./markdown";

export function startLorebookImporter(): void {
  const mount = () => {
    const root = findLorebookRoot();
    if (!root || root.querySelector("[data-zlc-lore-import]")) return;
    const host = document.createElement("div");
    host.setAttribute("data-zlc-lore-import", "");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>
      :host{display:block;margin:12px 0;color:#eee;font:14px/1.5 system-ui}
      details{background:#222;border:1px solid #555;border-radius:10px;padding:12px}
      summary{cursor:pointer;font-weight:600}button,input{font:inherit;max-width:100%}
      button{padding:8px 12px;border:1px solid #777;border-radius:6px;background:#333;color:white;cursor:pointer;margin:4px}
      button:disabled{opacity:.45;cursor:default}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto;background:#171717;padding:10px}
      p{margin:10px 0}input{display:block}button:focus-visible,summary:focus-visible{outline:2px solid #8bf}
    </style><details><summary>Markdownからロアブックを取り込む</summary>
    <p>入力済み項目を残し、空欄を利用して追加します。登録・完成は入力後に行ってください。</p>
    <label>Markdownファイル<input type="file" accept=".md,.markdown,text/markdown,text/plain"></label>
    <p>書式：## 題名 → キーワード: 単語、単語 → 空行と本文</p>
    <pre hidden></pre><p role="status" aria-live="polite"></p>
    <button data-action="fill" disabled>確認した内容を入力する</button><button data-action="cancel" hidden>中止</button>
    </details>`;
    const file = shadow.querySelector<HTMLInputElement>("input")!;
    const preview = shadow.querySelector("pre")!;
    const status = shadow.querySelector<HTMLElement>('[role="status"]')!;
    const fill = shadow.querySelector<HTMLButtonElement>('[data-action="fill"]')!;
    const cancel = shadow.querySelector<HTMLButtonElement>('[data-action="cancel"]')!;
    let entries: LoreEntry[] = [];
    let controller: AbortController | null = null;
    let selection = 0;
    file.addEventListener("change", async () => {
      const ticket = ++selection;
      fill.disabled = true;
      entries = [];
      preview.hidden = true;
      status.textContent = "";
      try {
        const selected = file.files?.[0];
        if (!selected) return;
        if (selected.size > 1024 * 1024) throw new Error("ファイルは1MB以下にしてください。");
        const source = await selected.text();
        if (ticket !== selection) return;
        entries = parseLoreMarkdown(source);
        preview.textContent = entries.map((entry, i) => `${i + 1}. ${entry.title}\nキーワード: ${entry.keywords.join("、")}\n${entry.content}`).join("\n\n");
        preview.hidden = false;
        status.textContent = `${entries.length}件を読み込みました。内容を確認して入力してください。`;
        fill.disabled = false;
      } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
    });
    cancel.addEventListener("click", () => controller?.abort());
    fill.addEventListener("click", async () => {
      fill.disabled = true;
      file.disabled = true;
      cancel.hidden = false;
      controller = new AbortController();
      status.textContent = "空欄と項目数を確認しています。入力中は編集画面を操作せずお待ちください。";
      try {
        await fillLorebook(root, entries, (done, total) => {
          status.textContent = `入力中: ${done}/${total}件。編集画面を操作せずお待ちください。`;
        }, controller.signal);
        status.textContent = `${entries.length}件の入力を確認しました。Zeta上で確認し、登録してください。`;
      } catch (error) {
        status.textContent = `${error instanceof Error ? error.message : String(error)} 入力済みの欄は残っています。再実行前に確認してください。`;
      } finally {
        file.disabled = false;
        cancel.hidden = true;
        controller = null;
      }
    });
    root.prepend(host);
  };
  // PC版とユーザースクリプトが同居してもUIを重複させない。
  mount();
  window.setInterval(mount, 1000);
}
