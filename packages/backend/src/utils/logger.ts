// Structured logger. Prefixes every line with an ISO timestamp + level.
// Keeps it simple — no external logging library needed at this scale.

const iso = () => new Date().toISOString();

export const logger = {
  info: (...args: unknown[]) => console.log(`[${iso()}] INFO`, ...args),
  warn: (...args: unknown[]) => console.warn(`[${iso()}] WARN`, ...args),
  error: (...args: unknown[]) => console.error(`[${iso()}] ERROR`, ...args),
};
