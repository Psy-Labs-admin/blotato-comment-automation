/** The unauthenticated local demo must reject DNS rebinding and cross-site browser writes. */
export function localRequest(host: string | undefined, origin: string | undefined): boolean {
  if (!host || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) return false;
  return origin === undefined || origin === 'http://' + host || origin === 'https://' + host;
}
