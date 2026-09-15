/**
 * OpenAI Compatible Provider (§21)。
 * LM Studio / llama.cpp / OpenAI 互換 API の chat/completions を対象とする。
 * 文字数制御は max_tokens ではなく Prompt 側で行う。
 */

import type { OpenAiCompatibleSettings } from "../shared/types";
import { truncate } from "../shared/utils";
import { LlmError, readErrorBody, type LlmProvider, type SummaryOptions } from "./provider";

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly kind = "openai-compatible";

  constructor(
    private readonly settings: OpenAiCompatibleSettings,
    private readonly apiKey: string | null,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  get endpoint(): string {
    return this.settings.endpoint;
  }

  get model(): string {
    return this.settings.model;
  }

  async summarize(text: string, options: SummaryOptions): Promise<string> {
    const body = {
      model: options.model || this.settings.model,
      messages: [
        { role: "system", content: options.instruction },
        { role: "user", content: text },
      ],
      temperature: options.temperature,
      stream: false,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    let res: Response;
    try {
      res = await this.fetchFn(this.settings.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
      });
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

    const content = (json as {
      choices?: Array<{ message?: { content?: unknown } }>;
    })?.choices?.[0]?.message?.content;

    if (typeof content !== "string" || content.length === 0) {
      throw new LlmError(
        "LLM 応答に choices[0].message.content が見つかりません",
      );
    }
    return content;
  }

  /** 接続テスト用。/chat/completions → /models へ差し替えられる場合は GET する。 */
  async testConnection(): Promise<string> {
    const modelsUrl = deriveModelsUrl(this.settings.endpoint);
    const headers: Record<string, string> = {};
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    if (modelsUrl) {
      let res: Response;
      try {
        res = await this.fetchFn(modelsUrl, { method: "GET", headers });
      } catch (e) {
        throw new LlmError(
          `接続失敗: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      if (!res.ok) {
        throw new LlmError(`HTTP ${res.status}`, await readErrorBody(res));
      }
      try {
        const json = (await res.json()) as { data?: Array<{ id?: string }> };
        const ids = (json.data ?? [])
          .map((m) => m.id)
          .filter((id): id is string => typeof id === "string")
          .slice(0, 5);
        return ids.length > 0
          ? `接続OK。利用可能モデル: ${ids.join(", ")}`
          : "接続OK（モデル一覧は空でした）";
      } catch {
        return "接続OK";
      }
    }

    // models URL を導出できない endpoint は最小の要約リクエストで確認する。
    await this.summarize("接続テストです。「OK」とだけ返してください。", {
      targetChars: 10,
      instruction: "「OK」とだけ返してください。",
      model: this.settings.model,
      temperature: 0,
    });
    return "接続OK";
  }
}

export function deriveModelsUrl(endpoint: string): string | null {
  try {
    const u = new URL(endpoint);
    if (u.pathname.endsWith("/chat/completions")) {
      u.pathname = u.pathname.replace(/\/chat\/completions$/, "/models");
      u.search = "";
      return u.toString();
    }
    return null;
  } catch {
    return null;
  }
}
