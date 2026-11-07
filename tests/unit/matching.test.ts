import { describe, expect, it } from 'vitest';
import { extractEmail, isStopCommand, matchesKeyword } from '../../src/domain/matching';

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
  it('normalises full-width characters (NFKC)', () => {
    expect(matchesKeyword('ｐｒｉｃｉｎｇ', 'pricing')).toBe(true);
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
});

describe('isStopCommand', () => {
  it('accepts STOP and unsubscribe as the whole message', () => {
    expect(isStopCommand(' STOP ')).toBe(true);
    expect(isStopCommand('Unsubscribe.')).toBe(true);
  });
  it('ignores stop inside a sentence', () => {
    expect(isStopCommand("don't stop sending")).toBe(false);
  });
});
