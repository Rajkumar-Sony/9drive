const MAX_PROVIDER_RETRY_MS = 60 * 60 * 1000

// Telegram Bot API and MTProto expose flood-wait durations on errors. Preserve that provider
// guidance in the durable job schedule while bounding it to one hour per retry.
export function providerRetryAfterMs(error: unknown) {
  const seen = new Set<unknown>()
  let candidate: unknown = error
  for (let depth = 0; depth < 5 && candidate && typeof candidate === 'object' && !seen.has(candidate); depth++) {
    seen.add(candidate)
    const value = candidate as { retryAfterSeconds?: unknown; seconds?: unknown; retry_after?: unknown; cause?: unknown }
    for (const raw of [value.retryAfterSeconds, value.seconds, value.retry_after]) {
      const seconds = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN
      if (Number.isSafeInteger(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_PROVIDER_RETRY_MS)
    }
    candidate = value.cause
  }
  return null
}
