/**
 * Generic JSON HTTP Provider (§22)。
 * 任意の JSON API に対し、テンプレート置換でリクエストを組み立てる。
 * eval() は使用しない。JSON.parse と再帰的文字列置換のみで実装する。
 */

import type { GenericJsonSettings } from "../shared/types";
import { getByPath, substitutePlaceholders, truncate } from "../shared/utils";
import { LlmError, readErrorBody, type LlmProvider, type SummaryOptions } from "./provider";

export class GenericJsonProvider implements LlmProvider {
  readonly kind = "generic-json";

  constructor(
    private readonly settings: GenericJsonSettings,
    private readonly apiKey: string | null,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  get endpoint(): string {
    return this.settings.url;
  }

  get model(): string {
    return "";
  }

  async summarize(text: string, options: SummaryOptions): Promise<string> {
    const values: Record<string, string> = {
      text,
      targetChars: String(options.targetChars),
      instruction: options.instruction,
      model: options.model,
      apiKey: this.apiKey ?? "",
    };

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(this.settings.headers ?? {})) {
      headers[name] = substitutePlaceholders(value, values);
    }

    const init: RequestInit = {
      method: this.settings.method,
      headers,
      signal: options.signal,
    };

    if (this.settings.method !== "GET") {
      const body = buildRequestBody(this.settings.requestTemplate, values);
      init.body = JSON.stringify(body);
      if (!hasHeader(headers, "content-type")) {
        headers["Content-Type"] = "application/json";
      }
    }

    let res: Response;
    try {
      res = await this.fetchFn(this.settings.url, init);
    } catch (e) {
      throw new LlmError(
        `LLM へ接続できません: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    if (!res.ok) {
      const detail = await readErrorBody(res);
      throw new LlmError(`LLM が HTTP ${res.status} を返しました`, truncate(detail, 300));
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new LlmError("LLM 応答が JSON として解析できません");
    }

    const value = getByPath(json, this.settings.responsePath);
    if (typeof value !== "string" || value.length === 0) {
      throw new LlmError(
        `Response JSON Path "${this.settings.responsePath}" から文字列を取得できません`,
      );
    }
    return value;
  }
}

/**
 * テンプレート JSON を parse し、文字列値の {{placeholder}} を再帰的に置換する。
 * 置換はプレースホルダ名の一致のみで行い、置換後の再展開はしない。
 */
export function buildRequestBody(
  template: string,
  values: Record<string, string>,
): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(template);
  } catch (e) {
    throw new LlmError(
      `JSON Request Template を解析できません: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return substituteDeep(parsed, values);
}

function substituteDeep(node: unknown, values: Record<string, string>): unknown {
  if (typeof node === "string") {
    return substitutePlaceholders(node, values);
  }
  if (Array.isArray(node)) {
    return node.map((item) => substituteDeep(item, values));
  }
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = substituteDeep(v, values);
    }
    return out;
  }
  return node;
}

function hasHeader(headers: Record<string, string>, lowerName: string): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === lowerName);
}
