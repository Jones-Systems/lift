import type { TextModerationPort } from '../extension-types.js';
import { BOARD_POLICY_VERSION, type BoardTextModeration } from '../board/types.js';
import { localLexicon } from './lexicon.js';
export type LocalModerationPolicy = Readonly<{ version: string; rejectedTokens: readonly string[]; allowedTokens: readonly string[]; directedProfanity: readonly string[] }>;
function normalize(text: string, one: 'i' | 'l'): string {
  return text.normalize('NFKC').normalize('NFKD').toLowerCase().replace(/[\p{M}\p{Cf}]/gu, '')
    .replace(/[013457@$]/g, value => ({ '0': 'o', '1': one, '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' })[value]!)
    .replace(/(.)\1{2,}/gu, '$1$1');
}
export function createLocalTextModeration(policy: LocalModerationPolicy | null = localLexicon): { community: TextModerationPort; board: BoardTextModeration } {
  const loaded = !!policy && !!policy.version && policy.rejectedTokens.length > 0;
  const check = (text: string): 'allowed' | 'rejected' | 'unavailable' => {
    if (!loaded || !policy) return 'unavailable';
    for (const one of ['i', 'l'] as const) {
      const normalized = normalize(text, one);
      const allowed = new Set(policy.allowedTokens.map(word => normalize(word, one)));
      const tokens = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
      const filtered = tokens.filter(word => !allowed.has(word));
      const compact = filtered.join('');
      if (policy.rejectedTokens.some(word => { const term = normalize(word, one).replace(/[^\p{L}\p{N}]/gu, ''); return term.length > 0 && (filtered.includes(term) || compact.includes(term)); })) return 'rejected';
      const words = tokens.join(' '), joined = tokens.join('');
      if (/(?:kill|hurt|hang)\s+(?:yourself|urself)|(?:i will|i ll|ill|im going to|i am going to)\s+(?:kill|hurt|shoot|stab)\s+(?:you|u)\b/.test(words)
        || /(?:killyourself|hurtyourself|hangyourself|illhurtyou|iwillkillyou|illshootyou)/.test(joined)) return 'rejected';
      let hits = 0;
      for (let i = 0; i < tokens.length; i++) if (policy.directedProfanity.some(word => normalize(word, one) === tokens[i]) && tokens.slice(Math.max(0, i - 2), i + 3).some(word => ['you', 'your', 'ur', 'u'].includes(word))) hits++;
      if (hits >= 2) return 'rejected';
    }
    return 'allowed';
  };
  return {
    community: { policyVersion: 'community-v1', checkText: input => input.purpose === 'safety' ? 'allowed' : input.policyVersion === 'community-v1' ? check(input.text) : 'unavailable' },
    board: { checkText: input => input.policyVersion === BOARD_POLICY_VERSION ? check(`${input.title}\n${input.description}`) : 'unavailable' },
  };
}
