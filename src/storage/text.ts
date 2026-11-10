import { z } from 'zod';

/** PostgreSQL UTF-8 text cannot represent NUL or unpaired UTF-16 surrogates. */
function isStorableText(value: string): boolean {
  return !/\u0000|\p{Cs}/u.test(value);
}

export const storableText = z.string().refine(isStorableText, 'Remove the invalid text character and try again.');
