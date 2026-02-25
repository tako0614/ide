/**
 * Async utility helpers
 */

/**
 * Races a promise against a timeout, rejecting with 'Request timeout' if exceeded.
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs = 10000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('Request timeout')), timeoutMs)
    )
  ]);
}
