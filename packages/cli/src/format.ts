export function formatTimestamp(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "invalid" : date.toISOString();
}

export function escapeControlCharacters(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f\u200e-\u200f\u202a-\u202e\u2066-\u2069]/g, (char) => {
    if (char === "\n") return "\\n";
    if (char === "\r") return "\\r";
    if (char === "\t") return "\\t";
    if (char.charCodeAt(0) > 0xff) {
      return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
    }
    return `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`;
  });
}
