/**
 * Tolerant unwrapping for captured servicestudio texts (fixtures only; the live client unwraps
 * before the extractor sees the text). Accepts:
 *  - raw C# text,
 *  - a ```csharp fenced block,
 *  - a JSON envelope `{"result":"```csharp ..."}`.
 */
export function unfence(raw: string): string {
  let text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  text = text.trim();
  if (text.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && "result" in parsed) {
        const result = (parsed as { result: unknown }).result;
        if (typeof result === "string") text = result.trim();
      }
    } catch {
      /* not JSON: fall through and treat as raw text */
    }
  }
  const fence = /^```[a-zA-Z#]*\s*\r?\n([\s\S]*?)\r?\n?```\s*$/.exec(text);
  if (fence) text = fence[1];
  return text.replace(/\r\n/g, "\n");
}
