export interface LoreEntry { title: string; keywords: string[]; content: string }

export function parseLoreMarkdown(source: string): LoreEntry[] {
  const lines = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  const sections: { title: string; lines: string[] }[] = [];
  for (const line of lines) {
    const heading = /^##[ \t]+(.+?)\s*$/.exec(line);
    if (heading) sections.push({ title: heading[1], lines: [] });
    else if (sections.length) sections[sections.length - 1].lines.push(line);
    else if (line.trim() && !/^#\s+/.test(line)) throw new Error("本文は「## 題名」から始めてください。");
  }
  if (!sections.length || sections.length > 50) throw new Error("項目数は1〜50件にしてください。");
  return sections.map((section, i) => {
    while (section.lines.length && !section.lines[0].trim()) section.lines.shift();
    const keywordLine = /^キーワード[：:][ \t]*(.*)$/.exec(section.lines.shift() ?? "");
    if (!keywordLine) throw new Error(`項目${i + 1}: 題名の次に「キーワード: …」を記述してください。`);
    const entry = {
      title: section.title,
      keywords: keywordLine[1].split(/[,、]/).map((s) => s.trim()).filter(Boolean),
      content: section.lines.join("\n").trim(),
    };
    validateLoreEntry(entry, i + 1);
    return entry;
  });
}

export function validateLoreEntry(entry: LoreEntry, number: number): void {
  // HTML maxlength と同じ UTF-16 単位で判定し、入力途中の切り捨てを防ぐ。
  const fail = (message: string): never => { throw new Error(`項目${number}: ${message}`); };
  if (!entry.title.trim() || entry.title.length > 20) fail("題名は1〜20文字にしてください。");
  if (!entry.keywords.length || entry.keywords.length > 5 || entry.keywords.some((k) => !k.trim() || k.length > 20)) {
    fail("キーワードは各1〜20文字、1〜5個にしてください。");
  }
  if (!entry.content.trim() || entry.content.length > 500) fail("内容は1〜500文字にしてください。");
}
