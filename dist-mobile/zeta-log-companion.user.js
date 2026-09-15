// ==UserScript==
// @name         Zeta Log Companion Mobile
// @namespace    zeta-log-companion
// @version      0.1.4
// @description  Zeta の会話ログを取得・自動保存し、統合テキストをコピーできる浮動パネル（モバイル向け）
// @match        https://zeta-ai.io/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

"use strict";
(() => {
  // src/content/conversation-capture.ts
  function partitionVariantSlots(items, anchorCenterX) {
    const groups = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const current = groups[groups.length - 1];
      if (current) {
        const rep = items[current[0]];
        const overlap = Math.min(rep.top + rep.height, item.top + item.height) - Math.max(rep.top, item.top);
        const minHeight = Math.max(1, Math.min(rep.height, item.height));
        if (overlap > minHeight * 0.5) {
          current.push(i);
          continue;
        }
      }
      groups.push([i]);
    }
    const visible = [];
    const displaced = [];
    for (const group of groups) {
      if (group.length === 1) {
        visible.push(group[0]);
        continue;
      }
      let best = group[0];
      for (const idx of group) {
        if (Math.abs(items[idx].centerX - anchorCenterX) < Math.abs(items[best].centerX - anchorCenterX)) {
          best = idx;
        }
      }
      visible.push(best);
      for (const idx of group) {
        if (idx !== best) displaced.push(idx);
      }
    }
    return { visible, displaced };
  }
  var ConversationStore = class {
    byKey = /* @__PURE__ */ new Map();
    /** active なメッセージの時系列順 messageKey リスト（唯一の順序ソース） */
    order = [];
    pos = /* @__PURE__ */ new Map();
    dirtyKeys = /* @__PURE__ */ new Set();
    /** Full Sync の上→下パス中の旧順序退避 */
    rebuildBackup = null;
    lastWindow = [];
    /**
     * DB に保存済みの active メッセージ（index 昇順）で初期化する。
     * セッションを跨いだ順序の安定化に使う。dirty にはしない。
     * index の振り直しは行わない（最初の mergeWindow が dirty 付きで揃えるため、
     * DB 内の番号と食い違う中間状態を書き込まずに済む）。
     */
    seed(records) {
      for (const rec of records) {
        if (this.byKey.has(rec.messageKey)) continue;
        this.byKey.set(rec.messageKey, {
          ...rec,
          active: true,
          parts: rec.parts.map((p) => ({ ...p }))
        });
        this.order.push(rec.messageKey);
      }
      this.rebuildPositions();
    }
    /**
     * 画面上の縦位置順（上=古い）に並べたマウント済みウィンドウを取り込む。
     */
    mergeWindow(mounted, options = {}) {
      const stats = {
        added: 0,
        updated: 0,
        unchanged: 0,
        deactivated: 0
      };
      const mountedKeySet = new Set(mounted.map((m) => m.messageKey));
      if (options.displaced && options.displaced.length > 0) {
        const removePositions = [];
        for (const variant of options.displaced) {
          if (mountedKeySet.has(variant.messageKey)) continue;
          const existing = this.byKey.get(variant.messageKey);
          if (existing) {
            if (existing.active) {
              existing.active = false;
              this.dirtyKeys.add(existing.messageKey);
              stats.deactivated++;
            }
          } else {
            this.byKey.set(variant.messageKey, {
              ...variant,
              active: false,
              parts: variant.parts.map((p2) => ({ ...p2 }))
            });
            this.dirtyKeys.add(variant.messageKey);
          }
          const p = this.pos.get(variant.messageKey);
          if (p !== void 0) removePositions.push(p);
        }
        if (removePositions.length > 0) {
          removePositions.sort((a, b) => b - a);
          for (const p of removePositions) this.order.splice(p, 1);
          this.rebuildPositions();
          this.renumber();
        }
      }
      if (mounted.length === 0) return stats;
      for (const incoming of mounted) {
        const existing = this.byKey.get(incoming.messageKey);
        if (existing) {
          if (existing.contentHash !== incoming.contentHash) {
            existing.role = incoming.role;
            existing.speaker = incoming.speaker;
            existing.parts = incoming.parts;
            existing.contentHash = incoming.contentHash;
            existing.updatedAt = incoming.updatedAt;
            this.dirtyKeys.add(existing.messageKey);
            stats.updated++;
          } else {
            stats.unchanged++;
          }
          if (!existing.active) {
            existing.active = true;
            this.dirtyKeys.add(existing.messageKey);
          }
        } else {
          this.byKey.set(incoming.messageKey, {
            ...incoming,
            active: true,
            parts: incoming.parts.map((p) => ({ ...p }))
          });
          this.dirtyKeys.add(incoming.messageKey);
          stats.added++;
        }
      }
      const mountedKeys = mounted.map((m) => m.messageKey);
      if (this.order.length === 0) {
        this.order = [...mountedKeys];
      } else {
        const anchorPositions = [];
        for (const key of mountedKeys) {
          const p = this.pos.get(key);
          if (p !== void 0) anchorPositions.push(p);
        }
        if (anchorPositions.length === 0) {
          if (this.rebuildBackup !== null || options.atBottom) {
            this.order.push(...mountedKeys);
          } else {
            const previousPositions = this.lastWindow.flatMap((key) => {
              const position = this.pos.get(key);
              return position === void 0 ? [] : [position];
            });
            if (options.scrollDirection && previousPositions.length > 0) {
              const insertAt = options.scrollDirection === "older" ? Math.min(...previousPositions) : Math.max(...previousPositions) + 1;
              this.order.splice(insertAt, 0, ...mountedKeys);
            } else {
              this.insertDisjoint(mountedKeys);
            }
          }
        } else {
          let start = Math.min(...anchorPositions);
          let end = Math.max(...anchorPositions);
          if (options.atBottom) {
            end = this.order.length - 1;
          }
          const mountedSet = new Set(mountedKeys);
          for (let i = start; i <= end; i++) {
            const key = this.order[i];
            if (!mountedSet.has(key)) {
              const rec = this.byKey.get(key);
              if (rec && rec.active) {
                rec.active = false;
                this.dirtyKeys.add(key);
                stats.deactivated++;
              }
            }
          }
          this.order.splice(start, end - start + 1, ...mountedKeys);
        }
      }
      this.rebuildPositions();
      this.renumber();
      this.lastWindow = mountedKeys;
      return stats;
    }
    /**
     * Full Sync の上→下パス開始時に呼ぶ。順序リストを空にして
     * パス中の mergeWindow が純粋な遭遇順で再構築できるようにする。
     * メッセージ本体 (byKey) は保持する。
     */
    beginRebuild() {
      if (this.rebuildBackup !== null) return;
      this.rebuildBackup = this.order;
      this.lastWindow = [];
      this.order = [];
      this.rebuildPositions();
    }
    /**
     * Full Sync 終了時（中断時も必ず）に呼ぶ。
     * パス中に遭遇しなかった active な既知メッセージ
     * を旧順序の隣接アンカーに沿って戻す。ID の大小は使用しない。
     */
    finishRebuild() {
      this.lastWindow = [];
      const backup = this.rebuildBackup;
      if (backup === null) return;
      this.rebuildBackup = null;
      let pending = [];
      let previousAnchor = null;
      for (const key of backup) {
        if (!this.byKey.get(key)?.active) continue;
        const position = this.pos.get(key);
        if (position === void 0) {
          pending.push(key);
          continue;
        }
        if (pending.length > 0) {
          this.order.splice(position, 0, ...pending);
          this.rebuildPositions();
          pending = [];
        }
        previousAnchor = key;
      }
      if (pending.length > 0) {
        const insertAt = previousAnchor === null ? 0 : this.pos.get(previousAnchor) + 1;
        this.order.splice(insertAt, 0, ...pending);
      }
      this.rebuildPositions();
      this.renumber();
    }
    /** active なメッセージを時系列順で返す。 */
    getActiveSorted() {
      const out = [];
      for (const key of this.order) {
        const rec = this.byKey.get(key);
        if (rec && rec.active) out.push(rec);
      }
      return out;
    }
    /** 前回 drain 以降に追加・更新・番号変更・無効化されたレコードを返す。 */
    drainDirty() {
      const out = [];
      for (const key of this.dirtyKeys) {
        const rec = this.byKey.get(key);
        if (rec) out.push({ ...rec, parts: rec.parts.map((p) => ({ ...p })) });
      }
      this.dirtyKeys.clear();
      return out;
    }
    /** 送信失敗時に dirty へ戻す。 */
    markDirty(records) {
      for (const rec of records) {
        if (this.byKey.has(rec.messageKey)) this.dirtyKeys.add(rec.messageKey);
      }
    }
    hasDirty() {
      return this.dirtyKeys.size > 0;
    }
    get size() {
      return this.byKey.size;
    }
    get activeCount() {
      return this.order.length;
    }
    clear() {
      this.lastWindow = [];
      this.byKey.clear();
      this.order = [];
      this.pos.clear();
      this.dirtyKeys.clear();
      this.rebuildBackup = null;
    }
    /* ------------------------------------------------------------------ */
    rebuildPositions() {
      this.pos.clear();
      for (let i = 0; i < this.order.length; i++) {
        this.pos.set(this.order[i], i);
      }
    }
    /** order 上の位置 (1-based) を index として振り直す。変更分は dirty。 */
    renumber() {
      for (let i = 0; i < this.order.length; i++) {
        const rec = this.byKey.get(this.order[i]);
        if (!rec) continue;
        const next = i + 1;
        if (rec.index !== next) {
          rec.index = next;
          this.dirtyKeys.add(rec.messageKey);
        }
      }
    }
    insertDisjoint(mountedKeys) {
      const myId = numericIdOf(mountedKeys[0]);
      let insertAt = this.order.length;
      if (myId !== null) {
        for (let i = 0; i < this.order.length; i++) {
          const otherId = numericIdOf(this.order[i]);
          if (otherId !== null && compareNumericIds(otherId, myId) > 0) {
            insertAt = i;
            break;
          }
        }
      }
      this.order.splice(insertAt, 0, ...mountedKeys);
    }
  };
  function numericIdOf(messageKey) {
    const m = /(\d{6,})/.exec(messageKey);
    return m ? m[1] : null;
  }
  function compareNumericIds(a, b) {
    if (a.length !== b.length) return a.length - b.length;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  // src/lorebook/markdown.ts
  function parseLoreMarkdown(source) {
    const lines = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
    const sections = [];
    for (const line of lines) {
      const heading = /^##[ \t]+(.+?)\s*$/.exec(line);
      if (heading) sections.push({ title: heading[1], lines: [] });
      else if (sections.length) sections[sections.length - 1].lines.push(line);
      else if (line.trim() && !/^#\s+/.test(line)) throw new Error("\u672C\u6587\u306F\u300C## \u984C\u540D\u300D\u304B\u3089\u59CB\u3081\u3066\u304F\u3060\u3055\u3044\u3002");
    }
    if (!sections.length || sections.length > 50) throw new Error("\u9805\u76EE\u6570\u306F1\u301C50\u4EF6\u306B\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
    return sections.map((section, i) => {
      while (section.lines.length && !section.lines[0].trim()) section.lines.shift();
      const keywordLine = /^キーワード[：:][ \t]*(.*)$/.exec(section.lines.shift() ?? "");
      if (!keywordLine) throw new Error(`\u9805\u76EE${i + 1}: \u984C\u540D\u306E\u6B21\u306B\u300C\u30AD\u30FC\u30EF\u30FC\u30C9: \u2026\u300D\u3092\u8A18\u8FF0\u3057\u3066\u304F\u3060\u3055\u3044\u3002`);
      const entry = {
        title: section.title,
        keywords: keywordLine[1].split(/[,、]/).map((s) => s.trim()).filter(Boolean),
        content: section.lines.join("\n").trim()
      };
      validateLoreEntry(entry, i + 1);
      return entry;
    });
  }
  function validateLoreEntry(entry, number) {
    const fail = (message) => {
      throw new Error(`\u9805\u76EE${number}: ${message}`);
    };
    if (!entry.title.trim() || entry.title.length > 20) fail("\u984C\u540D\u306F1\u301C20\u6587\u5B57\u306B\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
    if (!entry.keywords.length || entry.keywords.length > 5 || entry.keywords.some((k) => !k.trim() || k.length > 20)) {
      fail("\u30AD\u30FC\u30EF\u30FC\u30C9\u306F\u54041\u301C20\u6587\u5B57\u30011\u301C5\u500B\u306B\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
    }
    if (!entry.content.trim() || entry.content.length > 500) fail("\u5185\u5BB9\u306F1\u301C500\u6587\u5B57\u306B\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
  }

  // src/lorebook/form.ts
  var ROW = '[data-sentry-component="LorebookItemRow"]';
  var rows = (root) => Array.from(root.querySelectorAll(ROW));
  var field = (row, key) => row.querySelector(`[name^="items."][name$=".${key}"]`);
  function findLorebookRoot(doc = document) {
    const matches = Array.from(doc.querySelectorAll(ROW)).map((r) => r.parentElement?.parentElement);
    return matches.find((root) => root && findAddButton(root)) ?? null;
  }
  function findAddButton(root) {
    return Array.from(root.querySelectorAll("button")).find((button) => /^\+?\s*項目追加\s*[（(]/.test(button.textContent?.trim() ?? ""));
  }
  async function fillLorebook(root, entries, onProgress = () => {
  }, signal) {
    if (!entries.length || entries.length > 50) throw new Error("\u9805\u76EE\u6570\u306F1\u301C50\u4EF6\u306B\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
    entries.forEach((entry, i) => validateLoreEntry(entry, i + 1));
    const initialUrl = root.ownerDocument.location.href;
    const check = () => {
      if (signal?.aborted) throw new Error("\u5165\u529B\u3092\u4E2D\u6B62\u3057\u307E\u3057\u305F\u3002\u5165\u529B\u6E08\u307F\u306E\u9805\u76EE\u306F\u6B8B\u3063\u3066\u3044\u307E\u3059\u3002");
      if (!root.isConnected || root.ownerDocument.location.href !== initialUrl) throw new Error("\u7DE8\u96C6\u753B\u9762\u304C\u5909\u308F\u3063\u305F\u305F\u3081\u505C\u6B62\u3057\u307E\u3057\u305F\u3002");
    };
    const wait = async (condition) => {
      const deadline = Date.now() + 3e3;
      while (true) {
        check();
        if (condition()) return;
        if (Date.now() >= deadline) throw new Error("\u5165\u529B\u6B04\u306E\u8868\u793A\u5F85\u3061\u304C\u30BF\u30A4\u30E0\u30A2\u30A6\u30C8\u3057\u307E\u3057\u305F\u3002");
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    };
    const open = async (index) => {
      check();
      const row = rows(root)[index];
      if (!row) throw new Error("\u9805\u76EE\u306E\u69CB\u9020\u304C\u5909\u308F\u308A\u307E\u3057\u305F\u3002");
      if (!field(row, "name")) {
        const toggle = row.querySelector('button[data-sentry-element="RawButton"]');
        if (!toggle) throw new Error("\u9805\u76EE\u3092\u5C55\u958B\u3059\u308B\u30DC\u30BF\u30F3\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3002");
        toggle.click();
      }
      await wait(() => ["name", "keywords", "content"].every((key) => !!field(rows(root)[index], key)));
    };
    const read = (index) => ["name", "keywords", "content"].map((key) => field(rows(root)[index], key)?.value ?? "");
    const empty = (values) => values.every((value) => value === "");
    const originalCount = rows(root).length;
    if (originalCount > 50) throw new Error("\u753B\u9762\u306E\u9805\u76EE\u6570\u304C\u4E0A\u9650\u3092\u8D85\u3048\u3066\u3044\u307E\u3059\u3002");
    const blanks = [];
    const original = [];
    for (let i = 0; i < originalCount; i++) {
      await open(i);
      const values = read(i);
      original.push(values);
      if (empty(values)) blanks.push(i);
    }
    if (entries.length > blanks.length + 50 - originalCount) throw new Error("\u5165\u529B\u6E08\u307F\u9805\u76EE\u3092\u6B8B\u3059\u306850\u4EF6\u3092\u8D85\u3048\u307E\u3059\u3002\u30D5\u30A1\u30A4\u30EB\u306E\u9805\u76EE\u6570\u3092\u6E1B\u3089\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
    onProgress(0, entries.length);
    const expected = /* @__PURE__ */ new Map();
    original.forEach((values, i) => expected.set(i, values));
    const verify = async () => {
      for (const [index, values] of expected) {
        await open(index);
        if (JSON.stringify(read(index)) !== JSON.stringify(values)) throw new Error("\u753B\u9762\u306E\u5165\u529B\u5185\u5BB9\u304C\u5909\u308F\u3063\u305F\u305F\u3081\u505C\u6B62\u3057\u307E\u3057\u305F\u3002\u5165\u529B\u7D50\u679C\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
      }
    };
    let count = originalCount;
    for (let i = 0; i < entries.length; i++) {
      check();
      if (rows(root).length !== count) throw new Error("\u9805\u76EE\u6570\u304C\u5909\u308F\u3063\u305F\u305F\u3081\u505C\u6B62\u3057\u307E\u3057\u305F\u3002");
      let index = blanks[i];
      if (index === void 0) {
        const add = findAddButton(root);
        if (!add || add.disabled || count >= 50) throw new Error("\u9805\u76EE\u3092\u8FFD\u52A0\u3067\u304D\u307E\u305B\u3093\u3002");
        add.click();
        await wait(() => rows(root).length === count + 1);
        index = count++;
      }
      await open(index);
      if (!empty(read(index))) throw new Error("\u5165\u529B\u5148\u306B\u65E2\u5B58\u306E\u5185\u5BB9\u304C\u3042\u308B\u305F\u3081\u505C\u6B62\u3057\u307E\u3057\u305F\u3002");
      const values = [entries[i].title, entries[i].keywords.join("\u3001"), entries[i].content];
      for (const [n, key] of ["name", "keywords", "content"].entries()) {
        check();
        const input = field(rows(root)[index], key);
        if (input.disabled || input.readOnly) throw new Error("\u5165\u529B\u6B04\u304C\u7DE8\u96C6\u3067\u304D\u307E\u305B\u3093\u3002");
        const proto = input.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(input, values[n]);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
        input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 40));
        check();
        if (field(rows(root)[index], key)?.value !== values[n]) throw new Error("\u5165\u529B\u304C\u753B\u9762\u306B\u53CD\u6620\u3055\u308C\u307E\u305B\u3093\u3067\u3057\u305F\u3002\u51E6\u7406\u3092\u505C\u6B62\u3057\u307E\u3057\u305F\u3002");
      }
      expected.set(index, values);
      onProgress(i + 1, entries.length);
    }
    await verify();
  }

  // src/lorebook/importer.ts
  function startLorebookImporter() {
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
    </style><details><summary>Markdown\u304B\u3089\u30ED\u30A2\u30D6\u30C3\u30AF\u3092\u53D6\u308A\u8FBC\u3080</summary>
    <p>\u5165\u529B\u6E08\u307F\u9805\u76EE\u3092\u6B8B\u3057\u3001\u7A7A\u6B04\u3092\u5229\u7528\u3057\u3066\u8FFD\u52A0\u3057\u307E\u3059\u3002\u767B\u9332\u30FB\u5B8C\u6210\u306F\u5165\u529B\u5F8C\u306B\u884C\u3063\u3066\u304F\u3060\u3055\u3044\u3002</p>
    <label>Markdown\u30D5\u30A1\u30A4\u30EB<input type="file" accept=".md,.markdown,text/markdown,text/plain"></label>
    <p>\u66F8\u5F0F\uFF1A## \u984C\u540D \u2192 \u30AD\u30FC\u30EF\u30FC\u30C9: \u5358\u8A9E\u3001\u5358\u8A9E \u2192 \u7A7A\u884C\u3068\u672C\u6587</p>
    <pre hidden></pre><p role="status" aria-live="polite"></p>
    <button data-action="fill" disabled>\u78BA\u8A8D\u3057\u305F\u5185\u5BB9\u3092\u5165\u529B\u3059\u308B</button><button data-action="cancel" hidden>\u4E2D\u6B62</button>
    </details>`;
      const file = shadow.querySelector("input");
      const preview = shadow.querySelector("pre");
      const status = shadow.querySelector('[role="status"]');
      const fill = shadow.querySelector('[data-action="fill"]');
      const cancel = shadow.querySelector('[data-action="cancel"]');
      let entries = [];
      let controller = null;
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
          if (selected.size > 1024 * 1024) throw new Error("\u30D5\u30A1\u30A4\u30EB\u306F1MB\u4EE5\u4E0B\u306B\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
          const source = await selected.text();
          if (ticket !== selection) return;
          entries = parseLoreMarkdown(source);
          preview.textContent = entries.map((entry, i) => `${i + 1}. ${entry.title}
\u30AD\u30FC\u30EF\u30FC\u30C9: ${entry.keywords.join("\u3001")}
${entry.content}`).join("\n\n");
          preview.hidden = false;
          status.textContent = `${entries.length}\u4EF6\u3092\u8AAD\u307F\u8FBC\u307F\u307E\u3057\u305F\u3002\u5185\u5BB9\u3092\u78BA\u8A8D\u3057\u3066\u5165\u529B\u3057\u3066\u304F\u3060\u3055\u3044\u3002`;
          fill.disabled = false;
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : String(error);
        }
      });
      cancel.addEventListener("click", () => controller?.abort());
      fill.addEventListener("click", async () => {
        fill.disabled = true;
        file.disabled = true;
        cancel.hidden = false;
        controller = new AbortController();
        status.textContent = "\u7A7A\u6B04\u3068\u9805\u76EE\u6570\u3092\u78BA\u8A8D\u3057\u3066\u3044\u307E\u3059\u3002\u5165\u529B\u4E2D\u306F\u7DE8\u96C6\u753B\u9762\u3092\u64CD\u4F5C\u305B\u305A\u304A\u5F85\u3061\u304F\u3060\u3055\u3044\u3002";
        try {
          await fillLorebook(root, entries, (done, total) => {
            status.textContent = `\u5165\u529B\u4E2D: ${done}/${total}\u4EF6\u3002\u7DE8\u96C6\u753B\u9762\u3092\u64CD\u4F5C\u305B\u305A\u304A\u5F85\u3061\u304F\u3060\u3055\u3044\u3002`;
          }, controller.signal);
          status.textContent = `${entries.length}\u4EF6\u306E\u5165\u529B\u3092\u78BA\u8A8D\u3057\u307E\u3057\u305F\u3002Zeta\u4E0A\u3067\u78BA\u8A8D\u3057\u3001\u767B\u9332\u3057\u3066\u304F\u3060\u3055\u3044\u3002`;
        } catch (error) {
          status.textContent = `${error instanceof Error ? error.message : String(error)} \u5165\u529B\u6E08\u307F\u306E\u6B04\u306F\u6B8B\u3063\u3066\u3044\u307E\u3059\u3002\u518D\u5B9F\u884C\u524D\u306B\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044\u3002`;
        } finally {
          file.disabled = false;
          cancel.hidden = true;
          controller = null;
        }
      });
      root.prepend(host);
    };
    mount();
    window.setInterval(mount, 1e3);
  }

  // src/shared/utils.ts
  function countChars(text) {
    let n = 0;
    for (const _ of text) n++;
    return n;
  }
  function fnv1a(input) {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }
  function formatDateLocal(timestamp) {
    const d = new Date(timestamp);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  function formatTimeLocal(timestamp) {
    const d = new Date(timestamp);
    const h = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${h}:${min}`;
  }
  function debounce(fn, waitMs) {
    let timer = null;
    let lastArgs = null;
    const debounced = (...args) => {
      lastArgs = args;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const a = lastArgs;
        lastArgs = null;
        if (a) fn(...a);
      }, waitMs);
    };
    debounced.cancel = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      lastArgs = null;
    };
    debounced.flush = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
        const a = lastArgs;
        lastArgs = null;
        if (a) fn(...a);
      }
    };
    return debounced;
  }
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // src/content/zeta-adapter.ts
  var ZETA_SELECTORS = {
    plotName: '[data-testid="chat-header-profile"]',
    logContainer: '[role="log"][aria-label="Chat messages"]',
    logContainerFallback: '[role="log"]',
    messageNodes: '[data-key^="message-"][data-index]',
    chat: ".chat",
    userContent: '[data-sentry-component="RightTextContent"]',
    aiContent: '[data-sentry-component="LeftTextContent"]',
    narration: '[data-sentry-component="NarratorBubble"]',
    speaker: "span.caption1"
  };
  var ROOM_PATH_RE = /^(?:\/[A-Za-z0-9-]+)?\/rooms\/([0-9a-fA-F-]{8,64})(?:\/|$)/;
  function getRoomId(pathname) {
    const p = pathname ?? (typeof location !== "undefined" ? location.pathname : "");
    const m = ROOM_PATH_RE.exec(p);
    return m ? m[1] : null;
  }
  function getPlotName(root = document) {
    const el = root.querySelector(ZETA_SELECTORS.plotName);
    const text = el?.textContent?.trim();
    return text ? text : null;
  }
  function findLogContainer(root = document) {
    const strict = root.querySelector(ZETA_SELECTORS.logContainer);
    if (strict) return strict;
    return root.querySelector(ZETA_SELECTORS.logContainerFallback);
  }
  function findMessageNodes(root = document) {
    const container = findLogContainer(root) ?? root;
    const nodes = Array.from(
      container.querySelectorAll(ZETA_SELECTORS.messageNodes)
    );
    return nodes.filter(
      (n) => (n.getAttribute("data-key") ?? "").startsWith("message-")
    );
  }
  function parseMessage(node, roomId, now = Date.now()) {
    const messageKey = node.getAttribute("data-key");
    const indexRaw = node.getAttribute("data-index");
    if (!messageKey || !messageKey.startsWith("message-")) return null;
    if (indexRaw === null) return null;
    const index = Number.parseInt(indexRaw, 10);
    if (!Number.isFinite(index)) return null;
    const parts = [];
    const chats = Array.from(node.querySelectorAll(ZETA_SELECTORS.chat));
    for (const chat of chats) {
      const text = extractText(chat);
      if (!text) continue;
      if (chat.closest(ZETA_SELECTORS.narration)) {
        parts.push({ type: "narration", text });
        continue;
      }
      const userContainer = chat.closest(ZETA_SELECTORS.userContent);
      if (userContainer) {
        const speaker2 = findSpeaker(userContainer);
        parts.push(speaker2 ? { type: "user", speaker: speaker2, text } : { type: "user", text });
        continue;
      }
      const aiContainer = chat.closest(ZETA_SELECTORS.aiContent);
      if (aiContainer) {
        const speaker2 = findSpeaker(aiContainer);
        parts.push(
          speaker2 ? { type: "character", speaker: speaker2, text } : { type: "character", text }
        );
        continue;
      }
      if (looksRightAligned(chat, node)) {
        parts.push({ type: "user", text });
      } else {
        parts.push({ type: "character", text });
      }
    }
    if (parts.length === 0) return null;
    const role = parts.some((p) => p.type === "user") ? "user" : "ai";
    const speaker = parts.find((p) => p.speaker)?.speaker ?? findSpeaker(node) ?? null;
    return {
      roomId,
      messageKey,
      index,
      role,
      speaker,
      parts,
      capturedAt: now,
      updatedAt: now,
      contentHash: hashContent(role, parts),
      active: true
    };
  }
  function hashContent(role, parts) {
    const canonical = JSON.stringify([
      role,
      parts.map((p) => [p.type, p.speaker ?? "", p.text])
    ]);
    return fnv1a(canonical);
  }
  function findSpeaker(scope) {
    const el = scope.querySelector(ZETA_SELECTORS.speaker);
    const text = el?.textContent?.trim();
    return text ? text : null;
  }
  function looksRightAligned(chat, boundary) {
    let el = chat;
    while (el && el !== boundary.parentElement) {
      const cls = el.getAttribute("class") ?? "";
      if (/(?:^|\s)(?:items-end|justify-end|self-end|text-right)(?:\s|$)/.test(cls)) {
        return true;
      }
      if (el === boundary) break;
      el = el.parentElement;
    }
    return false;
  }
  function extractText(el) {
    const maybe = el.innerText;
    const raw = typeof maybe === "string" && maybe.length > 0 ? maybe : fallbackInnerText(el);
    return normalizeText(raw);
  }
  var SKIP_TAGS = /* @__PURE__ */ new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEMPLATE",
    "BUTTON",
    "IMG",
    "SVG",
    "AUDIO",
    "VIDEO",
    "INPUT",
    "TEXTAREA",
    "SELECT"
  ]);
  var BLOCK_TAGS = /* @__PURE__ */ new Set([
    "P",
    "DIV",
    "SECTION",
    "ARTICLE",
    "LI",
    "UL",
    "OL",
    "BLOCKQUOTE",
    "PRE",
    "TR",
    "TABLE",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "HEADER",
    "FOOTER",
    "FIGURE",
    "HR"
  ]);
  function fallbackInnerText(root) {
    let out = "";
    const ensureBreaks = (count) => {
      if (out.length === 0) return;
      let trailing = 0;
      while (trailing < out.length && out[out.length - 1 - trailing] === "\n") {
        trailing++;
      }
      for (let i = trailing; i < count; i++) out += "\n";
    };
    const walk = (node) => {
      if (node.nodeType === 3) {
        out += node.nodeValue ?? "";
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node;
      const tag = el.tagName.toUpperCase();
      if (SKIP_TAGS.has(tag)) return;
      if (el.getAttribute("aria-hidden") === "true") return;
      if (tag === "BR") {
        out += "\n";
        return;
      }
      const isBlock = BLOCK_TAGS.has(tag);
      const breaks = tag === "P" ? 2 : isBlock ? 1 : 0;
      if (breaks > 0) ensureBreaks(breaks);
      for (const child of Array.from(node.childNodes)) walk(child);
      if (breaks > 0) ensureBreaks(breaks);
    };
    for (const child of Array.from(root.childNodes)) walk(child);
    return out;
  }
  function normalizeText(raw) {
    return raw.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  // src/content/capture-window.ts
  function captureVisibleWindow(roomId) {
    const now = Date.now();
    const entries = [];
    for (const node of findMessageNodes()) {
      try {
        const rec = parseMessage(node, roomId, now);
        if (!rec) continue;
        const rect = node.getBoundingClientRect();
        entries.push({
          rec,
          top: rect.top,
          height: rect.height,
          centerX: rect.left + rect.width / 2,
          domOrder: entries.length
        });
      } catch (e) {
        console.warn("[ZetaLogCompanion] parseMessage failed:", e);
      }
    }
    const hasLayout = entries.some((e) => e.height > 0);
    if (!hasLayout) {
      entries.sort(
        (a, b) => a.rec.index !== b.rec.index ? a.rec.index - b.rec.index : a.domOrder - b.domOrder
      );
      return { records: entries.map((e) => e.rec), displaced: [] };
    }
    const usable = entries.filter((e) => e.height > 0);
    usable.sort((a, b) => {
      if (Math.abs(a.top - b.top) > 0.5) return a.top - b.top;
      if (a.rec.index !== b.rec.index) return a.rec.index - b.rec.index;
      return a.domOrder - b.domOrder;
    });
    const logRect = findLogContainer()?.getBoundingClientRect();
    const anchorCenterX = logRect && logRect.width > 0 ? logRect.left + logRect.width / 2 : window.innerWidth / 2;
    const partition = partitionVariantSlots(
      usable.map((e) => ({ top: e.top, height: e.height, centerX: e.centerX })),
      anchorCenterX
    );
    return {
      records: partition.visible.map((i) => usable[i].rec),
      displaced: partition.displaced.map((i) => usable[i].rec)
    };
  }

  // src/content/passive-capture.ts
  function batchLiveUpdates(update, waitMs = 120) {
    let timer = null;
    const schedule = () => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        update();
      }, waitMs);
    };
    schedule.cancel = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    return schedule;
  }
  var PassiveCapture = class {
    constructor(log, scan) {
      this.log = log;
      this.scan = scan;
      this.observer = new MutationObserver(() => this.schedule());
      this.observer.observe(log, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["data-key", "data-index"]
      });
      log.ownerDocument.addEventListener("scroll", this.onScroll, { capture: true, passive: true });
    }
    frame = null;
    observer;
    stopped = false;
    onScroll = (event) => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.contains(this.log) || this.log.contains(target))) this.schedule();
    };
    schedule() {
      if (this.stopped || this.frame !== null) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = null;
        if (!this.stopped) this.scan();
      });
    }
    stop() {
      this.stopped = true;
      this.observer.disconnect();
      this.log.ownerDocument.removeEventListener("scroll", this.onScroll, true);
      if (this.frame !== null) cancelAnimationFrame(this.frame);
      this.frame = null;
    }
  };
  var CaptureScrollTracker = class {
    previous = null;
    observe(container, keys) {
      if (keys.length === 0) return void 0;
      const signature = JSON.stringify(keys);
      const previous = this.previous;
      if (previous?.container === container && previous.keys === signature) return void 0;
      this.previous = { container, keys: signature, top: container.scrollTop, height: container.scrollHeight };
      if (!previous || previous.container !== container || previous.height !== container.scrollHeight) return void 0;
      const delta = container.scrollTop - previous.top;
      return Math.abs(delta) < 1 ? void 0 : delta < 0 ? "older" : "newer";
    }
    reset() {
      this.previous = null;
    }
  };

  // src/content/full-sync.ts
  function findScrollContainer(log) {
    let el = log;
    while (el && el !== document.body && el !== document.documentElement) {
      if (el.scrollHeight > el.clientHeight + 10) {
        const overflowY = getComputedStyle(el).overflowY;
        if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
          return el;
        }
      }
      el = el.parentElement;
    }
    return log;
  }
  function isNearBottom(container, thresholdPx = 80) {
    const style = getComputedStyle(container);
    if (style.flexDirection === "column-reverse") {
      return Math.abs(container.scrollTop) <= thresholdPx;
    }
    return container.scrollHeight - container.clientHeight - container.scrollTop <= thresholdPx;
  }
  async function runFullSync(options) {
    const {
      container,
      collect,
      onProgress,
      shouldAbort = () => false,
      settleMs = 450,
      loadWaitMs = 2500,
      stagnantLimit = 3,
      maxSteps = 600,
      maxTopJumps = 150
    } = options;
    const originalScrollTop = container.scrollTop;
    let steps = 0;
    let collected = 0;
    let collectionFailed = false;
    const safeCollect = () => {
      try {
        collected = Math.max(collected, collect());
      } catch (e) {
        collectionFailed = true;
        console.warn("[ZetaLogCompanion] full-sync collect failed:", e);
      }
      return collected;
    };
    const report = (phase) => {
      onProgress?.({ phase, collectedMessages: collected, steps });
    };
    const jumpToTop = () => {
      container.scrollTop = -1e9;
    };
    const windowSignature = () => {
      if (typeof container.querySelectorAll !== "function") return null;
      const nodes = container.querySelectorAll('[data-key^="message-"][data-index]');
      if (nodes.length === 0) return null;
      return JSON.stringify(Array.from(nodes, (node) => [node.dataset.key, node.textContent]));
    };
    const waitForRender = async (before) => {
      const deadline = Date.now() + settleMs;
      let last = before;
      let changed = false;
      let stableSince = Date.now();
      while (Date.now() < deadline) {
        await sleep(Math.min(40, deadline - Date.now()));
        if (shouldAbort()) return;
        const current = windowSignature();
        if (current !== last) {
          last = current;
          stableSince = Date.now();
          changed = true;
        }
        if (changed && current !== null && Date.now() - stableSince >= 80) return;
      }
    };
    const waitForLoad = async () => {
      const baseHeight = container.scrollHeight;
      const baseTop = container.scrollTop;
      const deadline = Date.now() + loadWaitMs;
      while (Date.now() < deadline) {
        await sleep(Math.min(50, deadline - Date.now()));
        if (shouldAbort()) return false;
        if (container.scrollHeight !== baseHeight || Math.abs(container.scrollTop - baseTop) > 1) {
          let height = container.scrollHeight;
          let top = container.scrollTop;
          let stableSince = Date.now();
          const settleDeadline = Date.now() + settleMs;
          while (Date.now() < settleDeadline) {
            await sleep(Math.min(50, settleDeadline - Date.now()));
            if (shouldAbort()) return false;
            if (height !== container.scrollHeight || Math.abs(top - container.scrollTop) > 1) {
              height = container.scrollHeight;
              top = container.scrollTop;
              stableSince = Date.now();
            }
            if (Date.now() - stableSince >= 100) break;
          }
          return true;
        }
      }
      return false;
    };
    let completed = false;
    try {
      let stagnantA = 0;
      let jumps = 0;
      while (stagnantA < 2 && jumps < maxTopJumps) {
        if (shouldAbort()) break;
        jumpToTop();
        jumps++;
        steps = jumps;
        report("loading");
        const grew = await waitForLoad();
        if (shouldAbort()) break;
        if (grew) {
          stagnantA = 0;
        } else {
          stagnantA++;
        }
      }
      if (!shouldAbort()) {
        const beforeTop = windowSignature();
        jumpToTop();
        await waitForRender(beforeTop);
        let stagnantB = 0;
        let scanSteps = 0;
        while (stagnantB < stagnantLimit && scanSteps < maxSteps) {
          if (shouldAbort()) break;
          const prevCount = collected;
          safeCollect();
          report("scanning");
          const before = container.scrollTop;
          const beforeWindow = windowSignature();
          container.scrollTop = before + Math.max(120, container.clientHeight * 0.6);
          steps++;
          scanSteps++;
          await waitForRender(beforeWindow);
          if (shouldAbort()) break;
          const after = container.scrollTop;
          const moved = Math.abs(after - before) >= 1;
          const grew = collected > prevCount;
          if (!moved && !grew) {
            stagnantB++;
          } else {
            stagnantB = 0;
          }
        }
        if (!shouldAbort()) {
          safeCollect();
          completed = stagnantA >= 2 && stagnantB >= stagnantLimit && !collectionFailed;
        }
      }
    } finally {
      report("restoring");
      try {
        container.scrollTop = originalScrollTop;
        await sleep(Math.min(settleMs, 300));
        container.scrollTop = originalScrollTop + 1;
        await sleep(80);
        container.scrollTop = originalScrollTop;
        await sleep(Math.min(settleMs, 300));
      } catch (e) {
        console.warn("[ZetaLogCompanion] full-sync scroll restore failed:", e);
      }
    }
    if (!completed) {
      report("aborted");
      return { aborted: true, collectedMessages: collected, steps };
    }
    report("done");
    return { aborted: false, collectedMessages: collected, steps };
  }

  // src/storage/database.ts
  var DB_NAME = "zetaLogCompanion";
  var DB_VERSION = 2;
  var STORE_ROOMS = "rooms";
  var STORE_MESSAGES = "messages";
  var STORE_SNAPSHOTS = "snapshots";
  var STORE_SUMMARIES = "summaries";
  function openDatabase(name = DB_NAME) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = req.result;
        const upgradeTx = req.transaction;
        if (event.oldVersion > 0 && event.oldVersion < 2 && upgradeTx) {
          for (const storeName of Array.from(db.objectStoreNames)) {
            upgradeTx.objectStore(storeName).clear();
          }
        }
        if (!db.objectStoreNames.contains(STORE_ROOMS)) {
          db.createObjectStore(STORE_ROOMS, { keyPath: "roomId" });
        }
        if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
          const messages = db.createObjectStore(STORE_MESSAGES, {
            keyPath: ["roomId", "messageKey"]
          });
          messages.createIndex("byRoom", "roomId", { unique: false });
          messages.createIndex("byRoomIndex", ["roomId", "index"], {
            unique: false
          });
        }
        if (!db.objectStoreNames.contains(STORE_SNAPSHOTS)) {
          const snapshots = db.createObjectStore(STORE_SNAPSHOTS, {
            keyPath: "id"
          });
          snapshots.createIndex("byRoom", "roomId", { unique: false });
          snapshots.createIndex("byUpdatedAt", "updatedAt", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_SUMMARIES)) {
          const summaries = db.createObjectStore(STORE_SUMMARIES, {
            keyPath: "id"
          });
          summaries.createIndex("byRoom", "roomId", { unique: false });
          summaries.createIndex("bySnapshot", "snapshotId", { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
    });
  }
  function requestToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
    });
  }
  function transactionDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    });
  }

  // src/shared/text-format.ts
  var MESSAGE_SEPARATOR = "\n\n---\n\n";
  var DEFAULT_FORMAT_OPTIONS = {
    speakerLabels: true,
    narrationLabels: true
  };
  function formatMessage(record, options = DEFAULT_FORMAT_OPTIONS) {
    const blocks = [];
    if (record.role === "user") {
      blocks.push(
        options.speakerLabels && record.speaker ? `[USER: ${record.speaker}]` : "[USER]"
      );
      for (const part of record.parts) {
        if (part.text) blocks.push(part.text);
      }
    } else {
      blocks.push(
        options.speakerLabels && record.speaker ? `[AI: ${record.speaker}]` : "[AI]"
      );
      for (const part of record.parts) {
        if (!part.text) continue;
        if (options.narrationLabels) {
          if (part.type === "narration") {
            blocks.push("[NARRATION]");
          } else {
            const speaker = options.speakerLabels ? part.speaker ?? record.speaker : null;
            blocks.push(speaker ? `[CHARACTER: ${speaker}]` : "[CHARACTER]");
          }
        }
        blocks.push(part.text);
      }
    }
    return blocks.join("\n\n");
  }
  function formatTranscript(records, options = DEFAULT_FORMAT_OPTIONS) {
    return formatMessageBlocks(records, options).join(MESSAGE_SEPARATOR);
  }
  function formatMessageBlocks(records, options = DEFAULT_FORMAT_OPTIONS) {
    return records.filter((r) => r.active).slice().sort((a, b) => a.index - b.index).map((r) => formatMessage(r, options)).filter((block) => block.length > 0);
  }

  // src/storage/archive-repository.ts
  function snapshotIdOf(roomId, date) {
    return `${roomId}:${date}`;
  }
  var ArchiveRepository = class {
    constructor(dbPromise) {
      this.dbPromise = dbPromise;
    }
    db() {
      return this.dbPromise;
    }
    async upsertRoom(room, now) {
      const db = await this.db();
      const tx = db.transaction(STORE_ROOMS, "readwrite");
      const store = tx.objectStore(STORE_ROOMS);
      const existing = await requestToPromise(store.get(room.roomId));
      const record = {
        roomId: room.roomId,
        plotName: room.plotName || existing?.plotName || "",
        url: room.url || existing?.url || "",
        firstSeenAt: existing?.firstSeenAt ?? now,
        lastSeenAt: now
      };
      store.put(record);
      await transactionDone(tx);
      return record;
    }
    /**
     * メッセージ差分を保存する。
     * 順序 (index) と active フラグは content script 側の ConversationStore が
     * 一元管理して確定済みの値を送ってくるため、ここではそれを信頼して
     * そのまま永続化する（capturedAt のみ初回値を保持）。
     */
    async upsertMessages(roomId, records) {
      if (records.length === 0) return;
      const db = await this.db();
      const tx = db.transaction(STORE_MESSAGES, "readwrite");
      const store = tx.objectStore(STORE_MESSAGES);
      for (const incoming of records) {
        if (incoming.roomId !== roomId) continue;
        const existing = await requestToPromise(
          store.get([roomId, incoming.messageKey])
        );
        const merged = existing ? {
          ...existing,
          index: incoming.index,
          role: incoming.role,
          speaker: incoming.speaker,
          parts: incoming.parts,
          contentHash: incoming.contentHash,
          updatedAt: incoming.updatedAt,
          active: incoming.active
        } : incoming;
        store.put(merged);
      }
      await transactionDone(tx);
    }
    async getMessagesForRoom(roomId) {
      const db = await this.db();
      const tx = db.transaction(STORE_MESSAGES, "readonly");
      const index = tx.objectStore(STORE_MESSAGES).index("byRoom");
      const all = await requestToPromise(index.getAll(roomId));
      await transactionDone(tx);
      return all;
    }
    async getActiveMessages(roomId) {
      const all = await this.getMessagesForRoom(roomId);
      return all.filter((m) => m.active).sort((a, b) => a.index - b.index);
    }
    /**
     * 自動保存 (§14)。同一 Room・同一日付では同じ Snapshot を更新する。
     * 全文は複製せず messageKeys から再構成できる形で保持する (§15)。
     */
    async saveSnapshot(room, date, format, now) {
      await this.upsertRoom(room, now);
      const active = await this.getActiveMessages(room.roomId);
      if (active.length === 0) return null;
      const text = formatTranscript(active, format);
      const id = snapshotIdOf(room.roomId, date);
      const db = await this.db();
      const tx = db.transaction(STORE_SNAPSHOTS, "readwrite");
      const store = tx.objectStore(STORE_SNAPSHOTS);
      const existing = await requestToPromise(store.get(id));
      const record = {
        id,
        roomId: room.roomId,
        date,
        displayName: `${room.plotName || "\u7121\u984C"}_${date}`,
        messageKeys: active.map((m) => m.messageKey),
        messageCount: active.length,
        characterCount: countChars(text),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      store.put(record);
      await transactionDone(tx);
      return record;
    }
    async listSnapshots() {
      const db = await this.db();
      const tx = db.transaction(STORE_SNAPSHOTS, "readonly");
      const all = await requestToPromise(
        tx.objectStore(STORE_SNAPSHOTS).getAll()
      );
      await transactionDone(tx);
      return all.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    async getSnapshot(id) {
      const db = await this.db();
      const tx = db.transaction(STORE_SNAPSHOTS, "readonly");
      const rec = await requestToPromise(tx.objectStore(STORE_SNAPSHOTS).get(id));
      await transactionDone(tx);
      return rec ?? null;
    }
    /** Snapshot の messageKeys から全文を再構成する (§15)。 */
    async buildSnapshotText(snapshot, format) {
      const db = await this.db();
      const tx = db.transaction(STORE_MESSAGES, "readonly");
      const store = tx.objectStore(STORE_MESSAGES);
      const records = [];
      for (const key of snapshot.messageKeys) {
        const rec = await requestToPromise(store.get([snapshot.roomId, key]));
        if (rec) records.push({ ...rec, active: true, index: records.length + 1 });
      }
      await transactionDone(tx);
      return formatTranscript(records, format);
    }
    async deleteSnapshot(id) {
      const db = await this.db();
      const tx = db.transaction([STORE_SNAPSHOTS, STORE_SUMMARIES], "readwrite");
      tx.objectStore(STORE_SNAPSHOTS).delete(id);
      const bySnapshot = tx.objectStore(STORE_SUMMARIES).index("bySnapshot");
      const summaries = await requestToPromise(bySnapshot.getAll(id));
      for (const s of summaries) {
        tx.objectStore(STORE_SUMMARIES).delete(s.id);
      }
      await transactionDone(tx);
    }
    async saveSummary(summary) {
      const db = await this.db();
      const tx = db.transaction(STORE_SUMMARIES, "readwrite");
      tx.objectStore(STORE_SUMMARIES).put(summary);
      await transactionDone(tx);
    }
    async listSummariesForRoom(roomId) {
      const db = await this.db();
      const tx = db.transaction(STORE_SUMMARIES, "readonly");
      const all = await requestToPromise(
        tx.objectStore(STORE_SUMMARIES).index("byRoom").getAll(roomId)
      );
      await transactionDone(tx);
      return all.sort((a, b) => b.createdAt - a.createdAt);
    }
    async listSummariesForSnapshot(snapshotId) {
      const db = await this.db();
      const tx = db.transaction(STORE_SUMMARIES, "readonly");
      const all = await requestToPromise(
        tx.objectStore(STORE_SUMMARIES).index("bySnapshot").getAll(snapshotId)
      );
      await transactionDone(tx);
      return all.sort((a, b) => b.createdAt - a.createdAt);
    }
  };

  // src/mobile/mobile-panel.css
  var mobile_panel_default = '/* Zeta Log Companion Mobile \u2014 Shadow DOM \u5185\u306E\u307F\u3067\u9069\u7528 */\n\n:host {\n  all: initial;\n}\n\n* {\n  box-sizing: border-box;\n  margin: 0;\n  padding: 0;\n}\n\n[hidden] {\n  display: none !important;\n}\n\n.zlm-root {\n  --bg: #14161a;\n  --bg-2: #1c2027;\n  --bg-3: #242a33;\n  --border: #313845;\n  --text: #e7e9ee;\n  --muted: #9aa3b2;\n  --accent: #7aa2ff;\n  --accent-2: #2e4a8f;\n  --ok: #5dd39e;\n  --warn: #ffcf6b;\n  --danger: #ff7a7a;\n\n  font-family: "Hiragino Kaku Gothic ProN", "Noto Sans JP", system-ui,\n    sans-serif;\n  font-size: 14px;\n  line-height: 1.55;\n  color: var(--text);\n}\n\n/* ---- \u30D5\u30ED\u30FC\u30C6\u30A3\u30F3\u30B0\u30DC\u30BF\u30F3 ---- */\n\nbutton.zlm-fab {\n  position: fixed;\n  left: 8px;\n  bottom: calc(env(safe-area-inset-bottom, 0px) + 128px);\n  z-index: 2147483646;\n  display: flex;\n  align-items: center;\n  gap: 4px;\n  padding: 4px 8px;\n  border: 1px solid var(--border);\n  border-radius: 999px;\n  background: rgba(20, 22, 26, 0.72);\n  -webkit-backdrop-filter: blur(6px);\n  backdrop-filter: blur(6px);\n  color: var(--text);\n  font-size: 10.5px;\n  font-weight: 700;\n  cursor: pointer;\n  touch-action: manipulation;\n}\nbutton.zlm-fab .count {\n  color: var(--accent);\n}\n\n/* ---- \u30B7\u30FC\u30C8 ---- */\n\n.zlm-sheet {\n  position: fixed;\n  inset: 0;\n  z-index: 2147483647;\n  display: flex;\n  flex-direction: column;\n  justify-content: flex-end;\n  background: rgba(0, 0, 0, 0.5);\n}\n\n.zlm-sheet-body {\n  display: flex;\n  flex-direction: column;\n  gap: 10px;\n  height: min(88dvh, 88vh);\n  padding: 12px 14px calc(env(safe-area-inset-bottom, 0px) + 12px);\n  background: var(--bg);\n  border-top: 1px solid var(--border);\n  border-radius: 14px 14px 0 0;\n}\n\n.zlm-header {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 8px;\n}\n\n.zlm-title {\n  font-size: 16px;\n  font-weight: 700;\n  word-break: break-all;\n  min-width: 0;\n}\n\nbutton.zlm-close {\n  flex: none;\n  width: 32px;\n  height: 32px;\n  border: 1px solid var(--border);\n  border-radius: 8px;\n  background: var(--bg-3);\n  color: var(--text);\n  font-size: 15px;\n  cursor: pointer;\n  touch-action: manipulation;\n}\n\n.zlm-stats {\n  color: var(--muted);\n  font-size: 12px;\n}\n\n.zlm-save-row {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  font-size: 11.5px;\n  color: var(--muted);\n}\n\n.zlm-badge {\n  display: inline-block;\n  padding: 1px 8px;\n  border-radius: 999px;\n  border: 1px solid var(--ok);\n  color: var(--ok);\n  font-size: 10.5px;\n  font-weight: 700;\n}\n.zlm-badge.off {\n  border-color: var(--border);\n  color: var(--muted);\n}\n\n.zlm-btn-row {\n  display: flex;\n  gap: 8px;\n}\n\nbutton.zlm-btn {\n  flex: 1 1 0;\n  padding: 10px 8px;\n  border: 1px solid var(--border);\n  border-radius: 9px;\n  background: var(--bg-3);\n  color: var(--text);\n  font-size: 13.5px;\n  font-weight: 700;\n  cursor: pointer;\n  touch-action: manipulation;\n}\nbutton.zlm-btn.primary {\n  background: var(--accent-2);\n  border-color: var(--accent-2);\n}\nbutton.zlm-btn:disabled {\n  opacity: 0.5;\n}\n\n.zlm-progress {\n  padding: 7px 9px;\n  border: 1px solid var(--accent-2);\n  border-radius: 8px;\n  background: rgba(122, 162, 255, 0.08);\n  color: var(--accent);\n  font-size: 12px;\n}\n\n.zlm-status {\n  min-height: 1.2em;\n  font-size: 12px;\n  word-break: break-word;\n}\n.zlm-status.ok {\n  color: var(--ok);\n}\n.zlm-status.error {\n  color: var(--danger);\n}\n.zlm-status.busy {\n  color: var(--warn);\n}\n\ntextarea.zlm-text {\n  flex: 1 1 auto;\n  min-height: 100px;\n  width: 100%;\n  resize: none;\n  padding: 9px;\n  border: 1px solid var(--border);\n  border-radius: 9px;\n  background: var(--bg-2);\n  color: var(--text);\n  font-family: inherit;\n  font-size: 12.5px;\n  line-height: 1.6;\n  -webkit-overflow-scrolling: touch;\n}\n\n.zlm-note {\n  color: var(--muted);\n  font-size: 10.5px;\n}\n';

  // src/mobile/mobile-panel.ts
  var MOBILE_HOST_ID = "zeta-log-companion-mobile-host";
  var TEMPLATE = `
<div class="zlm-root">
  <button class="zlm-fab" data-el="fab" type="button">
    <span>LOG</span>
    <span class="count" data-el="fabCount">0</span>
  </button>

  <div class="zlm-sheet" data-el="sheet" hidden>
    <div class="zlm-sheet-body">
      <div class="zlm-header">
        <div class="zlm-title" data-el="plotName">\u2014</div>
        <button class="zlm-close" data-el="btnClose" type="button">\u2715</button>
      </div>
      <div class="zlm-stats" data-el="stats">0 messages \u30FB 0 characters</div>
      <div class="zlm-save-row">
        <span class="zlm-badge" data-el="saveBadge">\u25CF Auto Save</span>
        <span data-el="lastSaved">\u672A\u4FDD\u5B58</span>
      </div>
      <div class="zlm-btn-row">
        <button class="zlm-btn primary" data-el="btnFullSync" type="button">\u5168\u5C65\u6B74\u3092\u540C\u671F</button>
        <button class="zlm-btn" data-el="btnCopy" type="button">\u30B3\u30D4\u30FC</button>
      </div>
      <div class="zlm-progress" data-el="syncProgress" hidden></div>
      <div class="zlm-status" data-el="status"></div>
      <textarea class="zlm-text" data-el="liveText" readonly spellcheck="false"></textarea>
      <div class="zlm-note">Zeta Log Companion Mobile \u2014 \u53D6\u5F97\u3057\u305F\u30ED\u30B0\u306F\u3053\u306E\u7AEF\u672B\u5185\u306B\u306E\u307F\u4FDD\u5B58\u3055\u308C\u307E\u3059</div>
    </div>
  </div>
</div>
`;
  var MobilePanel = class {
    constructor(hostApi) {
      this.hostApi = hostApi;
    }
    hostEl;
    els = /* @__PURE__ */ new Map();
    mount() {
      if (document.getElementById(MOBILE_HOST_ID)) return;
      this.hostEl = document.createElement("div");
      this.hostEl.id = MOBILE_HOST_ID;
      const shadow = this.hostEl.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = mobile_panel_default;
      shadow.appendChild(style);
      const wrapper = document.createElement("div");
      wrapper.innerHTML = TEMPLATE;
      const root = wrapper.querySelector(".zlm-root");
      shadow.appendChild(root);
      root.querySelectorAll("[data-el]").forEach((el) => {
        this.els.set(el.dataset.el, el);
      });
      this.el("fab").addEventListener("click", () => {
        this.el("sheet").hidden = false;
      });
      this.el("btnClose").addEventListener("click", () => {
        this.el("sheet").hidden = true;
      });
      this.el("sheet").addEventListener("click", (ev) => {
        if (ev.target === this.el("sheet")) this.el("sheet").hidden = true;
      });
      this.el("btnFullSync").addEventListener("click", () => {
        this.hostApi.requestFullSync();
      });
      this.el("btnCopy").addEventListener("click", () => {
        void this.copyLiveText();
      });
      (document.body ?? document.documentElement).appendChild(this.hostEl);
    }
    el(name) {
      const el = this.els.get(name);
      if (!el) throw new Error(`mobile panel element not found: ${name}`);
      return el;
    }
    setVisible(visible) {
      if (!this.hostEl) return;
      this.hostEl.style.display = visible ? "" : "none";
      if (!visible) this.el("sheet").hidden = true;
    }
    setPlotName(name) {
      this.el("plotName").textContent = name ?? "\u2014";
    }
    updateLive(messageCount, charCount, text) {
      this.el("fabCount").textContent = String(messageCount);
      this.el("stats").textContent = `${messageCount} messages \u30FB ${charCount.toLocaleString("en-US")} characters`;
      const ta = this.el("liveText");
      const nearBottom = ta.scrollTop + ta.clientHeight >= ta.scrollHeight - 40;
      ta.value = text;
      if (nearBottom) ta.scrollTop = ta.scrollHeight;
    }
    setLastSaved(savedAt) {
      this.el("lastSaved").textContent = savedAt === null ? "\u672A\u4FDD\u5B58" : `Last saved ${formatTimeLocal(savedAt)}`;
    }
    /** 保存が使えない環境（プライベートブラウズ等）でバッジを落とす。 */
    setSaveAvailable(available) {
      const badge = this.el("saveBadge");
      badge.textContent = available ? "\u25CF Auto Save" : "\u25CB \u4FDD\u5B58\u4E0D\u53EF";
      badge.classList.toggle("off", !available);
    }
    setSyncProgress(message) {
      const box = this.el("syncProgress");
      const btn = this.el("btnFullSync");
      if (message === null) {
        box.hidden = true;
        btn.disabled = false;
      } else {
        box.hidden = false;
        box.textContent = message;
        btn.disabled = true;
      }
    }
    setStatus(message, kind = "") {
      const el = this.el("status");
      el.textContent = message;
      el.classList.remove("ok", "error", "busy");
      if (kind) el.classList.add(kind);
    }
    async copyLiveText() {
      const text = this.hostApi.getLiveText();
      if (!text) {
        this.setStatus("\u30B3\u30D4\u30FC\u3059\u308B\u4F1A\u8A71\u304C\u3042\u308A\u307E\u305B\u3093", "error");
        return false;
      }
      let ok = false;
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {
        try {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          ta.setSelectionRange(0, ta.value.length);
          ok = document.execCommand("copy");
          ta.remove();
        } catch {
          ok = false;
        }
      }
      this.setStatus(
        ok ? "\u30B3\u30D4\u30FC\u3057\u307E\u3057\u305F" : "\u30B3\u30D4\u30FC\u306B\u5931\u6557\u3057\u307E\u3057\u305F\uFF08\u672C\u6587\u3092\u9577\u62BC\u3057\u3067\u9078\u629E\u3057\u3066\u304F\u3060\u3055\u3044\uFF09",
        ok ? "ok" : "error"
      );
      return ok;
    }
  };

  // src/mobile/mobile-main.ts
  var ROUTE_POLL_MS = 1e3;
  var CONTAINER_POLL_MS = 500;
  var CONTAINER_POLL_LIMIT = 40;
  var AUTO_SAVE_DEBOUNCE_MS = 2e3;
  var MobileApp = class {
    store = new ConversationStore();
    repo = new ArchiveRepository(openDatabase());
    panel;
    currentRoomId = null;
    plotName = null;
    liveText = "";
    passiveCapture = null;
    scrollTracker = new CaptureScrollTracker();
    lastCaptureSignature = "";
    containerPollTimer = null;
    containerPollCount = 0;
    fullSyncRunning = false;
    scheduleLiveUpdate = batchLiveUpdates(() => this.updatePanelLive());
    /** IndexedDB が使えない環境（プライベートブラウズ等）では false に落とす */
    storageAvailable = true;
    scheduleSave = debounce(
      () => void this.persist(),
      AUTO_SAVE_DEBOUNCE_MS
    );
    start() {
      this.panel = new MobilePanel({
        getLiveText: () => this.liveText,
        requestFullSync: () => void this.runFullSyncFlow()
      });
      this.panel.mount();
      window.setInterval(() => this.handleRouteChange(), ROUTE_POLL_MS);
      window.addEventListener("popstate", () => this.handleRouteChange());
      const flush = () => {
        if (this.store.hasDirty()) this.scheduleSave.flush();
      };
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flush();
      });
      window.addEventListener("pagehide", flush);
      this.handleRouteChange();
    }
    /* ------------------------------------------------------------------ */
    /* Room lifecycle                                                      */
    handleRouteChange() {
      const roomId = getRoomId(location.pathname);
      if (roomId === this.currentRoomId) return;
      this.teardownRoom();
      this.currentRoomId = roomId;
      this.panel.setVisible(roomId !== null);
      if (roomId) this.initRoom();
    }
    teardownRoom() {
      this.passiveCapture?.stop();
      this.passiveCapture = null;
      this.scrollTracker.reset();
      this.lastCaptureSignature = "";
      this.scheduleLiveUpdate.cancel();
      if (this.containerPollTimer !== null) {
        window.clearTimeout(this.containerPollTimer);
        this.containerPollTimer = null;
      }
      this.containerPollCount = 0;
      if (this.currentRoomId && this.store.hasDirty()) {
        this.scheduleSave.flush();
      }
      this.scheduleSave.cancel();
      this.store.clear();
      this.plotName = null;
      this.liveText = "";
      if (this.panel) {
        this.panel.setPlotName(null);
        this.panel.updateLive(0, 0, "");
        this.panel.setLastSaved(null);
        this.panel.setSyncProgress(null);
        this.panel.setStatus("");
      }
    }
    initRoom() {
      this.containerPollCount = 0;
      const poll = () => {
        this.containerPollTimer = null;
        if (!this.currentRoomId) return;
        const container = findLogContainer();
        if (container) {
          void this.attachToRoom(container);
          return;
        }
        this.containerPollCount++;
        if (this.containerPollCount >= CONTAINER_POLL_LIMIT) {
          this.panel.setStatus("Zeta conversation not detected", "error");
          return;
        }
        this.containerPollTimer = window.setTimeout(poll, CONTAINER_POLL_MS);
      };
      poll();
    }
    async attachToRoom(container) {
      const roomId = this.currentRoomId;
      if (!roomId) return;
      try {
        const seeded = await this.repo.getActiveMessages(roomId);
        if (this.currentRoomId !== roomId) return;
        if (seeded.length > 0) this.store.seed(seeded);
      } catch {
        this.storageAvailable = false;
        this.panel.setSaveAvailable(false);
      }
      this.scanAndUpdate();
      if (this.store.hasDirty()) this.scheduleSave();
      this.passiveCapture = new PassiveCapture(container, () => {
        if (this.fullSyncRunning) return;
        this.scanAndUpdate();
        if (this.store.hasDirty()) this.scheduleSave();
      });
    }
    /* ------------------------------------------------------------------ */
    /* capture                                                             */
    captureAndMerge(roomId) {
      if (this.currentRoomId !== roomId) return this.store.activeCount;
      const name = getPlotName();
      if (name) this.plotName = name;
      const nodeCount = findMessageNodes().length;
      const { records, displaced } = captureVisibleWindow(roomId);
      if (nodeCount > 0 && records.length === 0 && displaced.length === 0) {
        this.panel.setStatus(
          "Zeta\u306E\u30DA\u30FC\u30B8\u69CB\u9020\u304C\u5909\u66F4\u3055\u308C\u305F\u53EF\u80FD\u6027\u304C\u3042\u308A\u307E\u3059\u3002",
          "error"
        );
      }
      if (records.length > 0 || displaced.length > 0) {
        const log = findLogContainer();
        const scroll = log ? findScrollContainer(log) : null;
        const atBottom = scroll ? isNearBottom(scroll) : false;
        const scrollDirection = scroll && !this.fullSyncRunning ? this.scrollTracker.observe(scroll, records.map((r) => r.messageKey)) : void 0;
        const signature = JSON.stringify([
          records.map((r) => [r.messageKey, r.contentHash]),
          displaced.map((r) => [r.messageKey, r.contentHash]),
          atBottom
        ]);
        if (signature === this.lastCaptureSignature) return this.store.activeCount;
        this.lastCaptureSignature = signature;
        this.store.mergeWindow(records, { atBottom, displaced, scrollDirection });
      }
      if (!this.fullSyncRunning) this.scheduleLiveUpdate();
      return this.store.activeCount;
    }
    scanAndUpdate() {
      const roomId = this.currentRoomId;
      if (!roomId) return 0;
      if (this.fullSyncRunning) return this.store.activeCount;
      return this.captureAndMerge(roomId);
    }
    updatePanelLive() {
      const active = this.store.getActiveSorted();
      const text = formatTranscript(active, DEFAULT_FORMAT_OPTIONS);
      this.panel.setPlotName(this.plotName);
      if (text !== this.liveText) {
        this.liveText = text;
        this.panel.updateLive(active.length, countChars(text), text);
      }
    }
    /* ------------------------------------------------------------------ */
    /* save                                                                */
    async persist() {
      const roomId = this.currentRoomId;
      if (!roomId || !this.storageAvailable) return;
      const room = {
        roomId,
        plotName: this.plotName ?? "",
        url: location.origin + location.pathname
      };
      const dirty = this.store.drainDirty();
      if (dirty.length === 0) return;
      try {
        const now = Date.now();
        await this.repo.upsertRoom(room, now);
        await this.repo.upsertMessages(roomId, dirty);
        const snapshot = await this.repo.saveSnapshot(
          room,
          formatDateLocal(now),
          DEFAULT_FORMAT_OPTIONS,
          now
        );
        if (snapshot) this.panel.setLastSaved(now);
      } catch {
        this.store.markDirty(dirty);
        this.storageAvailable = false;
        this.panel.setSaveAvailable(false);
        this.panel.setStatus(
          "\u3053\u306E\u74B0\u5883\u3067\u306F\u4FDD\u5B58\u3067\u304D\u307E\u305B\u3093\uFF08\u30B3\u30D4\u30FC\u306F\u4F7F\u7528\u3067\u304D\u307E\u3059\uFF09",
          "error"
        );
      }
    }
    /* ------------------------------------------------------------------ */
    /* Full Sync                                                           */
    async runFullSyncFlow() {
      if (this.fullSyncRunning) return;
      const roomAtStart = this.currentRoomId;
      if (!roomAtStart) return;
      const log = findLogContainer();
      if (!log) {
        this.panel.setStatus("Zeta conversation not detected", "error");
        return;
      }
      this.fullSyncRunning = true;
      this.lastCaptureSignature = "";
      this.scheduleLiveUpdate.cancel();
      this.scrollTracker.reset();
      this.store.beginRebuild();
      this.panel.setSyncProgress("\u5C65\u6B74\u540C\u671F\u3092\u958B\u59CB\u2026");
      this.panel.setStatus("");
      let result = null;
      try {
        result = await runFullSync({
          container: findScrollContainer(log),
          collect: () => this.captureAndMerge(roomAtStart),
          onProgress: (p) => {
            if (p.phase === "loading") {
              this.panel.setSyncProgress(`\u904E\u53BB\u30ED\u30B0\u3092\u8AAD\u307F\u8FBC\u307F\u4E2D\u2026 (${p.steps})`);
            } else if (p.phase === "scanning") {
              this.panel.setSyncProgress(
                `\u5C65\u6B74\u53D6\u5F97\u4E2D\u2026 ${p.collectedMessages} messages`
              );
            } else if (p.phase === "restoring") {
              this.panel.setSyncProgress("\u30B9\u30AF\u30ED\u30FC\u30EB\u4F4D\u7F6E\u3092\u5FA9\u5143\u4E2D\u2026");
            }
          },
          shouldAbort: () => this.currentRoomId !== roomAtStart
        });
      } finally {
        this.store.finishRebuild();
        this.fullSyncRunning = false;
        this.lastCaptureSignature = "";
        this.panel.setSyncProgress(null);
        this.updatePanelLive();
      }
      if (result === null) {
        this.panel.setStatus("\u540C\u671F\u4E2D\u306B\u30A8\u30E9\u30FC\u304C\u767A\u751F\u3057\u307E\u3057\u305F", "error");
        return;
      }
      if (result.aborted) {
        this.panel.setStatus("\u540C\u671F\u306F\u672A\u5B8C\u4E86\u3067\u3059\uFF08\u4E2D\u65AD\u30FB\u8D70\u67FB\u4E0A\u9650\u30FB\u53D6\u5F97\u30A8\u30E9\u30FC\uFF09\u3002\u53D6\u5F97\u6E08\u307F\u306E\u30ED\u30B0\u306F\u4FDD\u6301\u3057\u307E\u3057\u305F\u3002", "error");
      } else {
        this.panel.setStatus(
          `\u540C\u671F\u5B8C\u4E86: ${result.collectedMessages} messages \u53D6\u5F97`,
          "ok"
        );
      }
      if (this.currentRoomId === roomAtStart && this.store.hasDirty()) {
        await this.persist();
      }
    }
  };
  (() => {
    if (window.__zetaLogCompanionMobileLoaded) return;
    if (document.getElementById(MOBILE_HOST_ID)) return;
    window.__zetaLogCompanionMobileLoaded = true;
    const boot = () => {
      startLorebookImporter();
      const app = new MobileApp();
      app.start();
    };
    if (document.readyState === "complete") {
      boot();
    } else {
      window.addEventListener("load", boot, { once: true });
    }
  })();
})();
