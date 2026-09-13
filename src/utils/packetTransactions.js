export function redactSensitive(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (value instanceof ArrayBuffer) return `[二进制 ${value.byteLength} B]`;
  if (ArrayBuffer.isView(value)) return `[二进制 ${value.byteLength} B]`;
  if (seen.has(value)) return '[循环引用]';
  if (depth >= 10) return '[层级过深]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => redactSensitive(item, depth + 1, seen));
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    const sensitive = /(token|password|passwd|secret|authorization|cookie|session|credential|openid|unionid)/i.test(key);
    result[key] = sensitive ? '[已脱敏]' : redactSensitive(item, depth + 1, seen);
  }
  return result;
}

export function sameProtocolId(left, right) {
  if (left === undefined || left === null || right === undefined || right === null) return false;
  return String(left) === String(right);
}

export function pairObservedPacket(entries, entry) {
  if (entry.direction === 'receive' && entry.resp !== undefined && entry.resp !== null) {
    const request = entries.find(candidate => (
      candidate.direction === 'send'
      && candidate.connectionId === entry.connectionId
      && sameProtocolId(candidate.seq, entry.resp)
      && !candidate.response
    ));
    if (request) {
      request.response = entry;
      request.rtt = Math.max(0, entry.capturedAt - request.capturedAt);
      entry.requestKey = request.key;
    }
    return request || null;
  }

  if (entry.direction === 'send' && entry.seq !== undefined && entry.seq !== null) {
    const response = entries.find(candidate => (
      candidate.direction === 'receive'
      && candidate.connectionId === entry.connectionId
      && sameProtocolId(candidate.resp, entry.seq)
      && !candidate.requestKey
    ));
    if (response) {
      entry.response = response;
      entry.rtt = Math.max(0, response.capturedAt - entry.capturedAt);
      response.requestKey = entry.key;
    }
    return response || null;
  }

  return null;
}
