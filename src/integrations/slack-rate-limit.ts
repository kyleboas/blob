const channelTimestamps = new Map<string, number[]>();

let windowMs = 60_000;
let maxMessages = 20;

export function configureRateLimit(config?: { windowMs?: number; maxMessages?: number }): void {
  if (config?.windowMs && Number.isFinite(config.windowMs) && config.windowMs > 0) {
    windowMs = config.windowMs;
  }
  if (config?.maxMessages && Number.isFinite(config.maxMessages) && config.maxMessages > 0) {
    maxMessages = config.maxMessages;
  }
}

export function checkRateLimit(channelId: string, now: number): { allowed: boolean; retryAfterMs?: number } {
  const cutoff = now - windowMs;
  const recent = (channelTimestamps.get(channelId) ?? []).filter((ts) => ts > cutoff);

  if (recent.length >= maxMessages) {
    const oldest = recent[0];
    return {
      allowed: false,
      retryAfterMs: Math.max(0, windowMs - (now - oldest)),
    };
  }

  recent.push(now);
  channelTimestamps.set(channelId, recent);
  return { allowed: true };
}

export function clearRateLimitState(): void {
  channelTimestamps.clear();
  windowMs = 60_000;
  maxMessages = 20;
}
