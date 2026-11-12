export function chunkText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += maxChars) {
    chunks.push(text.slice(offset, offset + maxChars));
  }
  return chunks;
}
