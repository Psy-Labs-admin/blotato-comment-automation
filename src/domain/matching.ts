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
// Only explicit prose separators split tokens. Unsupported Unicode and symbols inside a token
// must fail validation rather than expose an email-shaped suffix or a shortened domain.
const EMAIL_TOKEN_RE = /[^\s<>()\[\]",;:]+/gu;
// Emoji are allowed around an address, never removed from inside its local or domain part.
const EMAIL_EMOJI_RE = /\p{Extended_Pictographic}(?:[\uFE0E\uFE0F]|\p{Emoji_Modifier}|\u200d\p{Extended_Pictographic})*/gu;
const LOCAL_PART_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~+-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~+-]+)*$/;
const DOMAIN_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

function stripEmailEdgeEmoji(candidate: string): string {
  let prefixEnd = 0;
  let suffixStart = candidate.length;
  let previousEnd = -1;
  // Scan once instead of repeatedly searching for an emoji suffix in a long malformed token.
  for (const match of candidate.matchAll(EMAIL_EMOJI_RE)) {
    const end = match.index + match[0].length;
    if (match.index === prefixEnd) prefixEnd = end;
    if (match.index !== previousEnd) suffixStart = match.index;
    previousEnd = end;
  }
  const end = previousEnd === candidate.length ? suffixStart : candidate.length;
  return candidate.slice(prefixEnd, Math.max(prefixEnd, end));
}

function stripEmailPunctuation(token: string): string {
  const text = token.replace(/[.!?]+$/, '').replace(/^[“‘«]+|[”’»]+$/gu, '');
  // A pair of straight quotes wraps the address; an apostrophe inside the local part belongs to it.
  return text.startsWith("'") && text.endsWith("'") ? text.slice(1, -1) : text;
}

function emailFromToken(candidate: string): string | undefined {
  // A user may put quotes around an emoji or the emoji around the quotes.
  const raw = stripEmailPunctuation(stripEmailEdgeEmoji(stripEmailPunctuation(candidate)));
  const at = raw.indexOf('@');
  if (at < 1 || at > 64 || raw.length > 254) return undefined;
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  if (!LOCAL_PART_RE.test(local) || !DOMAIN_RE.test(domain)) return undefined;
  return `${local}@${domain.toLowerCase()}`;
}

/** Finds exactly one distinct email address in free text; never guesses between several. */
export function extractEmail(text: string): EmailExtraction {
  // A URL can contain @ in userinfo or query parameters. It is not an email reply.
  const normalizedText = text.normalize('NFKC').replace(/\S+/g, (chunk) => chunk.includes('://') ? ' ' : chunk);
  const tokens = [...normalizedText.matchAll(EMAIL_TOKEN_RE)];
  const distinct = new Map<string, string>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const candidate = token[0];
    if (!candidate.includes('@')) continue;
    const previous = tokens[i - 1];
    const next = tokens[i + 1];
    // Whitespace around @ or a following .label is a broken token, not a request to repair it.
    // A complete address before a sentence dot is independent, including before another address.
    // Mentions (including dotted handles) are independent prose; standalone @ is a broken fragment.
    if (previous && /^\s+$/.test(normalizedText.slice(previous.index + previous[0].length, token.index))) {
      const before = previous[0];
      if (before.endsWith('@') || (before.includes('@') && before.endsWith('.') && !emailFromToken(before))) continue;
    }
    if (next && /^\s+$/.test(normalizedText.slice(token.index + candidate.length, next.index))) {
      const after = next[0];
      if (after === '@' || /^\.[\p{L}\p{N}]/u.test(after)) continue;
    }
    const normalised = emailFromToken(candidate);
    if (!normalised) continue;
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
