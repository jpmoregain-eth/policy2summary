/**
 * A small amount of shared state, which serverless does not give you for free.
 *
 * Vercel spreads invocations across instances, so an in-memory counter cannot
 * rate limit anything — two requests a second apart may land on two different
 * machines that have never heard of each other. Anything that must hold across
 * requests goes through here.
 *
 * Backed by Upstash Redis over its REST API (no driver, just fetch) when
 * KV_REST_API_URL and KV_REST_API_TOKEN are set. Without them it falls back to
 * a per-instance Map so local development works — that fallback is NOT a real
 * limiter in production, and `isShared()` reports which one you are on.
 */

const URL_ENV = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const TOKEN_ENV = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

const memory = new Map();

function isShared() {
  return Boolean(URL_ENV && TOKEN_ENV);
}

/** Runs a pipeline of Redis commands, returning one result per command. */
async function pipeline(commands) {
  const response = await fetch(`${URL_ENV.replace(/\/$/, '')}/pipeline`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN_ENV}`
    },
    body: JSON.stringify(commands)
  });

  if (!response.ok) {
    throw new Error(`KV pipeline failed: ${response.status}`);
  }
  const body = await response.json();
  return body.map(entry => entry.result);
}

/* ---------- in-memory fallback ---------- */

function memoryGet(key) {
  const entry = memory.get(key);
  if (!entry) return null;
  if (entry.expires && entry.expires < Date.now()) {
    memory.delete(key);
    return null;
  }
  return entry.value;
}

function memorySet(key, value, ttlSeconds) {
  memory.set(key, { value, expires: ttlSeconds ? Date.now() + ttlSeconds * 1000 : 0 });
}

/**
 * Increments a counter and returns its new value, setting the TTL on first use
 * so the window rolls rather than growing forever.
 */
async function increment(key, ttlSeconds) {
  if (!isShared()) {
    const next = (memoryGet(key) || 0) + 1;
    memorySet(key, next, ttlSeconds);
    return next;
  }

  const [count] = await pipeline([['INCR', key], ['EXPIRE', key, String(ttlSeconds), 'NX']]);
  return Number(count);
}

/**
 * Claims a key exactly once. Returns true for the caller that set it and false
 * for everyone after — the primitive behind "this payment has been redeemed".
 */
async function claimOnce(key, ttlSeconds) {
  if (!isShared()) {
    if (memoryGet(key)) return false;
    memorySet(key, 1, ttlSeconds);
    return true;
  }

  const [result] = await pipeline([['SET', key, '1', 'NX', 'EX', String(ttlSeconds)]]);
  return result === 'OK';
}

/** Gives a counted run back when the work it paid for never happened. */
async function decrement(key) {
  if (!isShared()) {
    const current = memoryGet(key);
    if (typeof current === 'number' && current > 0) {
      const entry = memory.get(key);
      memory.set(key, { value: current - 1, expires: entry.expires });
    }
    return;
  }
  await pipeline([['DECR', key]]);
}

/** Releases a claim, so a failed job does not burn the payment behind it. */
async function release(key) {
  if (!isShared()) {
    memory.delete(key);
    return;
  }
  await pipeline([['DEL', key]]);
}

/**
 * Fixed-window rate limit. Returns { allowed, count, limit, resetSeconds }.
 * Fails open: if the store is unreachable the request proceeds, because a
 * flaky Redis should not take the whole app down.
 */
async function rateLimit(key, limit, windowSeconds) {
  try {
    const count = await increment(`rl:${key}`, windowSeconds);
    return {
      allowed: count <= limit,
      count,
      limit,
      resetSeconds: windowSeconds,
      enforced: true,
      refund: () => decrement(`rl:${key}`).catch(() => { /* best effort */ })
    };
  } catch (err) {
    console.error('Rate limit store unavailable, allowing request:', err.message);
    return { allowed: true, count: 0, limit, resetSeconds: windowSeconds, enforced: false, refund: async () => {} };
  }
}

/** Best-effort client identity for anonymous rate limiting. */
function clientKey(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded || '')
    .split(',')[0]
    .trim();
  return ip || req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

module.exports = { isShared, increment, decrement, claimOnce, release, rateLimit, clientKey };
