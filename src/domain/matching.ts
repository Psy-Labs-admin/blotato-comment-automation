/** Tokenises text the same way for comments and keywords: NFKC, lower case, split on non letters/digits. */
export function tokenize(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Whole-word, case-insensitive match. A multi-word keyword must appear as a contiguous phrase.
 * "#Pricing!" matches "pricing"; "pricingplan" does not.
 */
export function matchesKeyword(text: string, keyword: string): boolean {
  const words = tokenize(text);
  const needle = tokenize(keyword);
  if (needle.length === 0) return false;
  outer: for (let i = 0; i + needle.length <= words.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (words[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

export type EmailExtraction =
  | { kind: 'valid'; email: string }
  | { kind: 'none' }
  | { kind: 'ambiguous'; count: number };

// Pragmatic format check (not RFC 5322): local@domain.tld, TLD letters only. Format validity is not
// proof of ownership; the lead is stored as `format_valid_unverified`.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/** Finds exactly one distinct email address in free text; never guesses between several. */
export function extractEmail(text: string): EmailExtraction {
  const matches = text.normalize('NFKC').match(EMAIL_RE) ?? [];
  const distinct = new Map<string, string>();
  for (const raw of matches) {
    const at = raw.lastIndexOf('@');
    const normalised = `${raw.slice(0, at)}@${raw.slice(at + 1).toLowerCase()}`;
    const key = normalised.toLowerCase();
    if (!distinct.has(key)) distinct.set(key, normalised);
  }
  if (distinct.size === 0) return { kind: 'none' };
  if (distinct.size > 1) return { kind: 'ambiguous', count: distinct.size };
  return { kind: 'valid', email: [...distinct.values()][0] };
}

/**
 * Opt-out commands are honoured when they are the whole message, ignoring trailing punctuation,
 * symbols and emoji ("STOP!!", "Stop 🙏"). "stop sending me these" is not matched (ambiguous).
 */
export function isStopCommand(text: string): boolean {
  return /^\s*(stop|unsubscribe)[\s\p{P}\p{S}\p{M}\u200d]*$/iu.test(text.normalize('NFKC'));
}
