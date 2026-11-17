// Function words ignored for matching only; negations and "per" are deliberately excluded.
const words = new Set<string>([
  'a', 'an', 'the',
  'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how',
  'am', 'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did', 'doing', 'have', 'has', 'had', 'having',
  'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must',
  'i', 'me', 'my', 'mine', 'myself', 'we', 'us', 'our', 'ours', 'you', 'your', 'yours', 'he', 'him', 'his',
  'she', 'her', 'hers', 'it', 'its', 'they', 'them', 'their', 'theirs', 'this', 'that', 'these', 'those',
  'and', 'or', 'but', 'if', 'then', 'than', 'so', 'as', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'from', 'with', 'about', 'into',
  'much', 'many', 'there', 'here',
]);
for (const method of ['add', 'delete', 'clear'] as const) {
  Object.defineProperty(words, method, { value: () => { throw new TypeError('groundingStopWords is read-only'); } });
}
export const groundingStopWords: ReadonlySet<string> = Object.freeze(words);
