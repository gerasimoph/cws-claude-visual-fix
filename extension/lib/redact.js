// Sensitive-data filtering shared by the extension and the companion.
// Plain script (no import/export) so it can run as a classic content script
// and be imported for its side effect from Node. Exposes globalThis.BFRedact.
(function (root) {
  'use strict';

  const SENSITIVE_NAME = /(^|[^a-z])(pass(word|wd|phrase|code)?|pwd|secret|token|api-?key|apikey|auth|authorization|cookie|set-cookie|session-?id|sid|credential|credentials|private-?key|ssn|cvv|cvc|card-?number|cc-?number|iban)([^a-z]|$)/i;

  const TEXT_PATTERNS = [
    [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9\-._~+/]{8,}=*/g, '$1 [REDACTED]'],
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED_JWT]'],
    [/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{10,}/g, '[REDACTED_KEY]'],
    [/\bsk-[A-Za-z0-9_-]{16,}/g, '[REDACTED_KEY]'],
    [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED_KEY]'],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED_KEY]'],
    [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_KEY]'],
    [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED_KEY]'],
    [/\bAIza[0-9A-Za-z_-]{35}/g, '[REDACTED_KEY]'],
    [/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|token|password|passwd)["']?\s*[:=]\s*["']?)([^\s"'&,;]{4,})/gi, '$1[REDACTED]'],
  ];

  const CARD_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g;

  function normalizeName(name) {
    return String(name).replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-');
  }

  function isSensitiveName(name) {
    return SENSITIVE_NAME.test(normalizeName(name));
  }

  function luhn(digits) {
    let sum = 0;
    let dbl = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let d = digits.charCodeAt(i) - 48;
      if (dbl) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
      dbl = !dbl;
    }
    return sum % 10 === 0;
  }

  function redactText(value) {
    if (typeof value !== 'string' || !value) return value;
    let out = value;
    for (const [re, repl] of TEXT_PATTERNS) out = out.replace(re, repl);
    out = out.replace(CARD_CANDIDATE, (m) => {
      const digits = m.replace(/[ -]/g, '');
      return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? '[REDACTED_CARD]' : m;
    });
    return out;
  }

  function redactUrl(value) {
    if (typeof value !== 'string' || !value) return value;
    try {
      const url = new URL(value, 'http://placeholder.invalid');
      let touched = false;
      if (url.username || url.password) { url.username = ''; url.password = ''; touched = true; }
      for (const key of [...url.searchParams.keys()]) {
        if (isSensitiveName(key)) { url.searchParams.set(key, 'REDACTED'); touched = true; }
      }
      if (!touched) return redactText(value);
      const s = url.toString();
      return redactText(s.startsWith('http://placeholder.invalid') ? s.slice('http://placeholder.invalid'.length) : s);
    } catch {
      return redactText(value);
    }
  }

  // Recursively redacts strings; values under sensitive-looking keys are dropped.
  // `skipKeys` lists keys whose values are passed through untouched.
  function redactDeep(value, options, depth) {
    const opts = options || {};
    const d = depth || 0;
    if (d > 12) return undefined;
    if (typeof value === 'string') return redactText(value);
    if (Array.isArray(value)) return value.map((v) => redactDeep(v, opts, d + 1));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        if (opts.skipKeys && opts.skipKeys.includes(k)) { out[k] = v; continue; }
        if (isSensitiveName(k) && typeof v !== 'object') { out[k] = '[REDACTED]'; continue; }
        out[k] = redactDeep(v, opts, d + 1);
      }
      return out;
    }
    return value;
  }

  root.BFRedact = { isSensitiveName, redactText, redactUrl, redactDeep, luhn };
})(typeof globalThis !== 'undefined' ? globalThis : this);
