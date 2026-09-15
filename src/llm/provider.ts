/** LLM Provider 抽象 (§20)。 */

export interface SummaryOptions {
  targetChars: number;
  /** 置換済みの指示文（system prompt 相当） */
  instruction: string;
  model: string;
  temperature: number;
  signal?: AbortSignal;
}

export interface LlmProvider {
  readonly kind: string;
  /** 警告表示・permission 判定に使う接続先 URL */
  readonly endpoint: string;
  readonly model: string;

  summarize(text: string, options: SummaryOptions): Promise<string>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 500);
  } catch {
    return "";
  }
}
