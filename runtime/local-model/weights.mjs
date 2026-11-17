import { createHash } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { lstat, rename, statfs, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

async function regularFile(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new Error('The model cache must contain regular files. Check the Atlas model volume.');
    return info;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function verified(path, weights) {
  const info = await regularFile(path);
  if (!info || info.size !== weights.bytes) return false;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex') === weights.sha256;
}

// The caller holds the cache's exclusive flock. A stopped download can resume from its last written byte.
export async function prepareWeights(directory, weights, report, request = fetch) {
  const final = join(directory, weights.filename);
  const partial = final + '.part';
  if (await regularFile(final)) {
    report('verifying', 'Checking the saved model.');
    if (await verified(final, weights)) return final;
    await unlink(final);
  }
  let existing = await regularFile(partial);
  if (existing && (existing.size > weights.bytes || existing.nlink !== 1)) {
    await unlink(partial);
    existing = null;
  }
  let offset = existing?.size || 0;
  if (offset < weights.bytes) {
    const space = await statfs(directory, { bigint: true });
    if (space.bavail * space.bsize < BigInt(weights.bytes - offset)) throw new Error('There is not enough free space in Docker storage for the model. Free space and retry.');
    const percent = () => Math.floor(100 * offset / weights.bytes);
    let last = percent();
    report('downloading', 'Downloading the Atlas model.', last);
    const controller = new AbortController();
    let timeout;
    const watch = () => { clearTimeout(timeout); timeout = setTimeout(() => controller.abort(), 120_000); };
    watch();
    try {
      const headers = { 'accept-encoding': 'identity', ...(offset ? { range: 'bytes=' + offset + '-' } : {}) };
      const response = await request(weights.url, { headers, signal: controller.signal });
      if (![200, 206].includes(response.status) || !response.body) throw new Error('The model download returned HTTP ' + response.status + '. Retry when the download service is available.');
      if (response.status === 206 && response.headers.get('content-range') !== 'bytes ' + offset + '-' + (weights.bytes - 1) + '/' + weights.bytes) {
        throw new Error('The model server returned an invalid download range. Retry the download.');
      }
      if (response.status === 200) {
        offset = 0;
        const length = response.headers.get('content-length');
        if (length && Number(length) !== weights.bytes) throw new Error('The model server returned an unexpected file size. Retry the download.');
      }
      const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (offset ? constants.O_APPEND : constants.O_TRUNC);
      const progress = new Transform({ transform(chunk, encoding, done) {
        watch();
        offset += chunk.length;
        if (offset > weights.bytes) return done(new Error('The model file exceeded the expected size.'));
        const value = percent();
        if (value !== last) { last = value; report('downloading', 'Downloading the Atlas model.', value); }
        done(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(partial, { flags, mode: 0o600 }));
      if (offset < weights.bytes) throw new Error('The download was interrupted. Retry to resume it.');
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }
  report('verifying', 'Verifying the downloaded model.');
  if (!await verified(partial, weights)) {
    await unlink(partial);
    throw new Error('The model checksum did not match. Retry to download a fresh copy.');
  }
  await rename(partial, final);
  return final;
}
