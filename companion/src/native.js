// Chrome Native Messaging framing: 32-bit little-endian length + UTF-8 JSON.
export const MAX_HOST_MESSAGE_BYTES = 1024 * 1024; // Chrome's limit for host -> extension

export function encodeMessage(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  if (body.length > MAX_HOST_MESSAGE_BYTES) {
    throw new Error(`native message too large (${body.length} bytes)`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export function createDecoder(onMessage) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const body = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      let msg;
      try { msg = JSON.parse(body.toString('utf8')); } catch { continue; }
      onMessage(msg);
    }
  };
}

export function createNativeChannel(input, output, onMessage) {
  input.on('data', createDecoder(onMessage));
  return { send: (msg) => output.write(encodeMessage(msg)) };
}
