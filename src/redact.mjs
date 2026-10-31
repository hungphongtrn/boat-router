export function redact(value) {
  return String(value)
    .replace(/(?:https?:\/\/|\/)[^\s"\\<>?]*\?[^\s"\\<>]*/gi, match => match.slice(0, match.indexOf('?')) + '?[REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|hnk_[A-Za-z0-9_]+|eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){0,2})\b/gi, '[REDACTED]')
    .replace(/\bBearer\s+[^\s"\\,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(token|code|state|jit|encoded_jit_config)(=|%3d|["']\s*:\s*["'])([^\s&"'\\,;}]+)/gi, '$1$2[REDACTED]')
    .replace(/\b[A-Za-z0-9+/_=-]{41,}\b/g, '[REDACTED]');
}

export function safeLogger(logger) {
  return (...args) => logger(...args.map(value => {
    if (typeof value !== 'string') return redact(value);
    try {
      const data = JSON.parse(value);
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        for (const key of ['code', 'text', 'error', 'infra']) if (key in data) data[key] = '[REDACTED]';
        return redact(JSON.stringify(data));
      }
    } catch { /* Non-JSON log lines still need token masking. */ }
    return redact(value);
  }));
}
