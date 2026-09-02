/**
 * Turning a model's reply into an object without losing the whole analysis to
 * a stray character.
 *
 * The previous approach — strip ``` fences, JSON.parse, give up — threw away a
 * complete report whenever the model added a sentence of preamble or ran into
 * max_tokens one field from the end. Both are recoverable.
 */

/** Finds the outermost JSON object in a string that may carry prose around it. */
function extractObject(raw) {
  const start = raw.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }

  // Unbalanced: the response was cut off mid-object. Close what is open so the
  // fields that did arrive survive.
  return repairTruncated(raw.slice(start));
}

/** Closes an object truncated mid-generation, discarding the partial tail. */
function repairTruncated(fragment) {
  let inString = false;
  let escaped = false;
  const stack = [];
  let lastSafe = -1;

  for (let i = 0; i < fragment.length; i++) {
    const ch = fragment[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
    // a comma at depth means everything before it is a complete set of members
    else if (ch === ',' && stack.length > 0) lastSafe = i;
  }

  if (lastSafe === -1) return null;

  // Re-walk to the safe point to learn which containers are still open there.
  let truncatedAt = fragment.slice(0, lastSafe);
  const open = [];
  inString = false;
  escaped = false;
  for (let i = 0; i < truncatedAt.length; i++) {
    const ch = truncatedAt[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') open.push(ch);
    else if (ch === '}' || ch === ']') open.pop();
  }

  while (open.length) truncatedAt += open.pop() === '{' ? '}' : ']';
  return truncatedAt;
}

/**
 * Parses a model response into an object.
 * Returns { ok: true, data, repaired } or { ok: false, reason, sample }.
 */
function parseModelJson(content) {
  const raw = String(content || '').trim();
  if (!raw) return { ok: false, reason: 'empty_response', sample: '' };

  const withoutFences = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

  try {
    return { ok: true, data: JSON.parse(withoutFences), repaired: false };
  } catch (_) { /* fall through to extraction */ }

  const candidate = extractObject(withoutFences);
  if (!candidate) {
    return { ok: false, reason: 'no_json_found', sample: raw.slice(0, 300) };
  }

  try {
    return { ok: true, data: JSON.parse(candidate), repaired: candidate !== withoutFences };
  } catch (err) {
    return { ok: false, reason: 'invalid_json', sample: raw.slice(0, 300) };
  }
}

module.exports = { parseModelJson };
