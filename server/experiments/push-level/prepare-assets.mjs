import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { assetDirectory, assetLock } from './offline-runtime.mjs';

// The public website loader uses this format for its downloadable game bundles.
function decrypt(bytes, keyBytes) {
  const values = new Uint32Array(Math.ceil(bytes.length / 4));
  const key = new Uint32Array(4);
  for (let i = 0; i < bytes.length; i++) values[i >>> 2] |= bytes[i] << ((i & 3) * 8);
  for (let i = 0; i < Math.min(keyBytes.length, 16); i++) key[i >>> 2] |= keyBytes[i] << ((i & 3) * 8);
  const n = values.length - 1;
  let y = values[0];
  let rounds = Math.floor(6 + 52 / values.length);
  let sum = (rounds * 0x9e3779b9) >>> 0;
  const mix = (z, p, e) => ((((z >>> 5) ^ (y << 2)) + ((y >>> 3) ^ (z << 4))) ^ ((sum ^ y) + (key[(p & 3) ^ e] ^ z)));
  while (rounds-- > 0) {
    const e = (sum >>> 2) & 3;
    for (let p = n; p > 0; p--) y = values[p] -= mix(values[p - 1], p, e);
    y = values[0] -= mix(values[n], 0, e);
    sum = (sum - 0x9e3779b9) >>> 0;
  }
  const length = values[n];
  if (length < n * 4 - 3 || length > n * 4) throw new Error('Invalid decoded length');
  return Buffer.from(values.buffer).subarray(0, length);
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const results = await Promise.allSettled(assetLock.files.map(async file => {
  const target = new URL(file.path, assetDirectory);
  try {
    if (sha256(await readFile(target)) === file.sha256) return `${file.path}: verified existing file`;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const response = await fetch(file.url, {signal:AbortSignal.timeout(60000)});
  if (!response.ok) throw new Error(`${file.path}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const decoded = file.encoding === 'xxtea' ? decrypt(bytes, Buffer.from(assetLock.publicBundleKey)) : bytes;
  if (sha256(decoded) !== file.sha256) throw new Error(`Downloaded asset hash mismatch: ${file.path}`);
  await mkdir(new URL('./', target), {recursive:true});
  await writeFile(target, decoded);
  return `${file.path}: downloaded and verified`;
}));
for (const result of results) {
  if (result.status === 'fulfilled') console.log(result.value);
  else { console.error(result.reason.message); process.exitCode = 1; }
}
