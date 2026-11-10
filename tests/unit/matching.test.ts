import { describe, expect, it } from 'vitest';
import { classifyKeywordMatch, extractEmail, isStopCommand, matchesKeyword, tokenize } from '../../src/domain/matching';

describe('matchesKeyword (whole word, case-insensitive)', () => {
  it('matches the keyword wrapped in punctuation and a hashtag', () => {
    expect(matchesKeyword('#Pricing!', 'pricing')).toBe(true);
  });
  it('matches upper case with a question mark', () => {
    expect(matchesKeyword('PRICING?', 'pricing')).toBe(true);
  });
  it('does not match the keyword inside another word', () => {
    expect(matchesKeyword('pricingplan', 'pricing')).toBe(false);
  });
  it('matches the keyword in a sentence', () => {
    expect(matchesKeyword('hey, what is the pricing for teams', 'pricing')).toBe(true);
  });
  it('matches a multi-word keyword only as a contiguous phrase', () => {
    expect(matchesKeyword('send me the price list please', 'price list')).toBe(true);
    expect(matchesKeyword('price of the list', 'price list')).toBe(false);
  });
  it.each(['prcing', 'pric ing', 'surpricing', '   ', '🫶'])('ignores an incomplete or unrelated keyword: %s', (comment) => {
    expect(matchesKeyword(comment, 'pricing')).toBe(false);
  });
  it('matches a Cyrillic whole word with surrounding emoji', () => {
    expect(matchesKeyword('Привет! 💬 ЦЕНА?', 'цена')).toBe(true);
  });
  it('normalises full-width characters (NFKC)', () => {
    expect(matchesKeyword('ｐｒｉｃｉｎｇ', 'pricing')).toBe(true);
  });
});

describe('classifyKeywordMatch', () => {
  const classify = (text: string, keyword = 'pricing', allowTypos = true) =>
    classifyKeywordMatch(tokenize(text), keyword, allowTypos);

  it.each(['#PRICING!', 'ｐｒｉｃｉｎｇ', 'send pricing please'])(
    'preserves normalized exact matches with either setting: %s', (text) => {
      expect(classify(text)).toBe('exact');
      expect(classify(text, 'pricing', false)).toBe('exact');
    },
  );
  it.each(['prcing', 'priicng', 'pricign', 'rpicing', 'priicing', 'pricingg', 'ppricing'])(
    'accepts one eligible typing error: %s', (text) => {
      expect(classify(text)).toBe('typo');
      expect(classify(text, 'pricing', false)).toBeNull();
      expect(matchesKeyword(text, 'pricing')).toBe(false);
    },
  );
  it.each([
    'priz ing', 'prizing', 'pricingplan', 'surpricing', 'rpricing', 'priciingg',
    'prcingg', 'pricngg', 'ricing', 'pricin', 'pricnigx', 'pric ing',
    'pricxng', 'pricxing', 'prіcing', 'pric1ng', '', '🫶',
  ])('rejects unsupported errors or partial tokens: %s', (text) => {
    expect(classify(text)).toBeNull();
  });
  it.each(['go', 'цена', '123456', 'price1', 'prіcing'])(
    'keeps short, numeric and mixed-script exact matches: %s', (keyword) => {
      expect(classify(keyword, keyword)).toBe('exact');
      expect(classify(keyword, keyword, false)).toBe('exact');
      expect(classify(keyword + keyword.at(-1), keyword)).toBeNull();
    },
  );
  it('only accepts contiguous phrases with one altered word across the entire phrase', () => {
    expect(classify('send prcing details please', 'pricing details')).toBe('typo');
    expect(classify('send pricing detials please', 'pricing details')).toBe('typo');
    expect(classify('prcing detials', 'pricing details')).toBeNull();
    expect(classify('pricing extra details', 'pricing details')).toBeNull();
    expect(classify('prcing extra details', 'pricing details')).toBeNull();
    expect(classify('pricing detials', 'pricing details', false)).toBeNull();
  });
  it('prefers an exact occurrence even after an earlier typo occurrence', () => {
    expect(classify('prcing details then pricing details', 'pricing details')).toBe('exact');
    expect(classify('pricing details then prcing details', 'pricing details')).toBe('exact');
    expect(classify('prcing details then pricing details', 'pricing details', false)).toBe('exact');
  });
  it('normalizes the keyword and handles empty keywords', () => {
    expect(classify('pricing', 'ＰＲＩＣＩＮＧ!')).toBe('exact');
    expect(classify('prcing', 'ＰＲＩＣＩＮＧ!')).toBe('typo');
    expect(classify('pricing', '🫶')).toBeNull();
    expect(classify('', 'pricing')).toBeNull();
  });
  it.each(['стоимсть', 'сотимость', 'тсоимость', 'стоимосьт', 'стооимость', 'стоимостьь'])(
    'supports the same conservative edits in Cyrillic: %s', (text) => {
      expect(classify(text, 'СТОИМОСТЬ')).toBe('typo');
    },
  );
  it.each(['стоимасть', 'тоимость', 'стоимост', 'стоимостb', 'стоимос2ть'])(
    'rejects unsupported Cyrillic edits: %s', (text) => {
      expect(classify(text, 'стоимость')).toBeNull();
    },
  );
  it('rejects deletions of repeated edge letters even when the outer letters look unchanged', () => {
    expect(classify('pricing', 'ppricing')).toBeNull();
    expect(classify('pricing', 'pricingg')).toBeNull();
  });
  it('accepts every eligible interior deletion, adjacent transposition and duplicate in a distinct-letter word', () => {
    const keyword = 'abcdefghi';
    for (let i = 1; i < keyword.length - 1; i++) {
      expect(classify(keyword.slice(0, i) + keyword.slice(i + 1), keyword)).toBe('typo');

    }
    for (let i = 0; i + 1 < keyword.length; i++) {
      const swapped = keyword.slice(0, i) + keyword[i + 1] + keyword[i] + keyword.slice(i + 2);
      expect(classify(swapped, keyword)).toBe('typo');
    }
    for (let i = 0; i < keyword.length; i++) {
      expect(classify(keyword.slice(0, i) + keyword[i] + keyword.slice(i), keyword)).toBe('typo');
      expect(classify(keyword.slice(0, i) + 'z' + keyword.slice(i + 1), keyword)).toBeNull();
    }
  });
});

describe('extractEmail', () => {
  it('captures an email wrapped in prose and punctuation, lower-casing only the domain', () => {
    expect(extractEmail('sure: Alice@Example.COM.')).toEqual({ kind: 'valid', email: 'Alice@example.com' });
  });
  it('reports two different addresses as ambiguous instead of guessing', () => {
    expect(extractEmail('a@x.io or b@y.io')).toEqual({ kind: 'ambiguous', count: 2 });
  });
  it('treats the same address repeated in different case as one', () => {
    expect(extractEmail('A@x.io and a@X.io').kind).toBe('valid');
  });
  it('returns none when there is no address', () => {
    expect(extractEmail('no idea')).toEqual({ kind: 'none' });
  });
  it('rejects an address without a top-level domain', () => {
    expect(extractEmail('me@localhost').kind).toBe('none');
  });
  it.each(['.alice@example.com', 'alice.@example.com', 'a..b@example.com', 'a@-example.com', 'a@example-.com', 'a@example.com123', 'a@@example.com', 'пользователь@example.com'])('rejects the malformed candidate %s without extracting a valid-looking substring', (text) => {
    expect(extractEmail(text)).toEqual({ kind: 'none' });
  });
  it.each([
    'alice@example.com@other.io', 'alice@example.com@', 'alice@example.com@@',
    'alice@ @example.com',
    'alice@ bob@example.com', 'alice@example.com .org', 'alice@example. com@other.io',
    'alice @example.com', 'alice@ example.com', 'alice@example .com', 'alice@example. com',
    'al\u200bice@example.com', 'al\u200dice@example.com', 'al\u0301ice@example.com', 'a\u034flice@example.com',
    'alice@exam\u200bple.com', 'alice@example.com\u0301',
    'alice@example.com/extra', 'alice@example.com_foo', 'alice@example..com',
    'o’connor@example.com', 'al👋ice@example.com', 'alice@exam👋ple.com',
    'alice@exam’ple.com', 'https://example.org/?email=bob@example.org',
    'https://example.org/?email=(bob@example.org)',
  ])('does not salvage part of a broken email token: %s', (text) => {
    expect(extractEmail(text)).toEqual({ kind: 'none' });
  });
  it.each([
    ["'Alice@Example.COM'", 'Alice@example.com'],
    ["(alice@example.com), thanks", 'alice@example.com'],
    ['alice@example.com! Thanks', 'alice@example.com'],
    ['alice@example.com. Thanks', 'alice@example.com'],
    ['❤️alice@example.com👩‍💻', 'alice@example.com'],
    ['“alice@example.com”', 'alice@example.com'],
    ['‘alice@example.com’', 'alice@example.com'],
    ["'❤️alice@example.com👩‍💻'", 'alice@example.com'],
    ["❤️'alice@example.com'👩‍💻", 'alice@example.com'],
    ['Email:alice@example.com', 'alice@example.com'],
    ['почта:alice@example.com', 'alice@example.com'],
    ['mailto:alice@example.com', 'alice@example.com'],
    ["o'connor+list@example.co.uk", "o'connor+list@example.co.uk"],
    ['ａｌｉｃｅ＠ｅｘａｍｐｌｅ．ｃｏｍ', 'alice@example.com'],
  ])('preserves supported addresses in free text: %s', (text, email) => {
    expect(extractEmail(text)).toEqual({ kind: 'valid', email });
  });
  it.each([
    'first@example.com. second@example.net',
    'first@example.com, second@example.net',
    'first@example.com! second@example.net',
    'first@example.com. @handle second@example.net',
    'first@example.com. @first.last or second@example.org',
  ])('never chooses between independent adjacent addresses: %s', (text) => {
    expect(extractEmail(text)).toEqual({ kind: 'ambiguous', count: 2 });
  });
  it.each(['Alice@Example.com. alice@example.com', 'Alice@Example.com, alice@example.com'])('deduplicates repeated addresses after sentence punctuation: %s', (text) => {
    expect(extractEmail(text)).toEqual({ kind: 'valid', email: 'Alice@example.com' });
  });
  it.each(['alice@example.com @handle', 'alice@example.com @first.last', 'alice@example.com @other.io'])('preserves an email followed by a prose mention: %s', (text) => {
    expect(extractEmail(text)).toEqual({ kind: 'valid', email: 'alice@example.com' });
  });
  it('keeps independent valid addresses after malformed tokens', () => {
    expect(extractEmail('alice@example.com@bad.io; use bob@example.com')).toEqual({ kind: 'valid', email: 'bob@example.com' });
  });
  it('ignores URLs while preserving an independent email in surrounding prose', () => {
    expect(extractEmail('https://example.org/?email=bob@example.org or alice@example.com')).toEqual({ kind: 'valid', email: 'alice@example.com' });
  });
  it('rejects excessive lengths and long malformed runs without substring extraction', () => {
    expect(extractEmail(`${'a'.repeat(65)}@example.com`)).toEqual({ kind: 'none' });
    expect(extractEmail(`${'a@'.repeat(20_000)}example.com`)).toEqual({ kind: 'none' });
  });
  it('never captures a different address when a pasted character splits the local part or domain', () => {
    const original = 'Alice+list@example.co.uk';
    for (const inserted of ['\u200b', '\u200d', '\u034f', '👋', '’']) {
      for (let boundary = 1; boundary < original.length; boundary++) {
        const reply = original.slice(0, boundary) + inserted + original.slice(boundary);
        expect(extractEmail(reply), `character at offset ${boundary}`).toEqual({ kind: 'none' });
      }
    }
  });
  it('accepts a plausible address exactly as typed, including a misspelled domain', () => {
    expect(extractEmail('alex@gmial.com')).toEqual({ kind: 'valid', email: 'alex@gmial.com' });
  });
  it('checks local-part, label and total length without taking a shorter substring', () => {
    const local = 'a'.repeat(64);
    const label = 'b'.repeat(63);
    const maxAddress = `${local}@${label}.${label}.${'c'.repeat(60)}`;
    expect(maxAddress).toHaveLength(253);
    expect(extractEmail(maxAddress + 'd')).toEqual({ kind: 'valid', email: maxAddress + 'd' });
    for (const text of [maxAddress + 'dd', `x${local}@example.com`, `person@${label}x.org`]) {
      expect(extractEmail(text)).toEqual({ kind: 'none' });
    }
  });
  it('accepts plus addressing and punctuation around the whole email', () => {
    expect(extractEmail('Use <alice+pricing@example.com>.')).toEqual({ kind: 'valid', email: 'alice+pricing@example.com' });
  });
});

describe('isStopCommand', () => {
  it('accepts STOP and unsubscribe as the whole message', () => {
    expect(isStopCommand(' STOP ')).toBe(true);
    expect(isStopCommand('Unsubscribe.')).toBe(true);
  });
  it('honours STOP with trailing punctuation or emoji (review finding)', () => {
    expect(isStopCommand('STOP!!')).toBe(true);
    expect(isStopCommand('Stop 🙏')).toBe(true);
    expect(isStopCommand('unsubscribe ❤️')).toBe(true);
  });
  it('ignores stop inside a sentence', () => {
    expect(isStopCommand("don't stop sending")).toBe(false);
  });
});
