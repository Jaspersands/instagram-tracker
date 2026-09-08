import yauzl from 'yauzl';
import { Readable } from 'node:stream';
import { parser } from 'stream-json';
import { pick } from 'stream-json/filters/pick.js';
import { streamArray } from 'stream-json/streamers/stream-array.js';

export const STREAM_THRESHOLD_BYTES = 8 * 1024 * 1024;

export interface JsonSource {
  path: string;
  size: number;
  /** Streams the file's array items; safe at any size. */
  items(): AsyncIterable<unknown>;
  /**
   * The whole parsed document. Only for shapes items() cannot express — a DM
   * thread's `participants` and `messages` are siblings, and items() would
   * unwrap to whichever array comes first. Throws above STREAM_THRESHOLD_BYTES.
   */
  raw(): Promise<unknown>;
}

/** Find the single array-valued wrapper key from the head of a JSON document. */
export function detectWrapperKey(head: string): string | null {
  const m = /^\s*\{\s*"([^"]+)"\s*:\s*\[/.exec(head);
  return m ? m[1] : null;
}

function bufferOf(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c) => chunks.push(c as Buffer));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/** Read only the first `bytes` and abandon the stream — never buffer a huge file. */
async function headOf(stream: Readable, bytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let len = 0;
  for await (const c of stream) {
    chunks.push(c as Buffer);
    len += (c as Buffer).length;
    if (len >= bytes) break;
  }
  stream.destroy();
  return Buffer.concat(chunks).subarray(0, bytes).toString('utf8');
}

async function* streamItems(open: () => Promise<Readable>, wrapperKey: string | null) {
  const src = await open();
  let p = src.pipe(parser.asStream());
  if (wrapperKey) p = p.pipe(pick.asStream({ filter: wrapperKey }));
  const out = p.pipe(streamArray.asStream());
  for await (const chunk of out as AsyncIterable<{ value: unknown }>) {
    yield chunk.value;
  }
}

export function eachJsonEntry(
  zipPath: string,
  onEntry: (src: JsonSource) => Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) return reject(err);

      zip.on('error', reject);
      zip.on('end', resolve);

      zip.on('entry', (entry) => {
        if (!/\.json$/i.test(entry.fileName)) return zip.readEntry();

        const openStream = () =>
          new Promise<Readable>((res, rej) =>
            zip.openReadStream(entry, (e, s) => (e || !s ? rej(e) : res(s as Readable))),
          );

        const size: number = entry.uncompressedSize;

        const src: JsonSource = {
          path: entry.fileName,
          size,
          items: () => ({
            async *[Symbol.asyncIterator]() {
              if (size <= STREAM_THRESHOLD_BYTES) {
                const buf = await bufferOf(await openStream());
                const json = JSON.parse(buf.toString('utf8'));
                const arr = Array.isArray(json)
                  ? json
                  : Object.values(json ?? {}).find(Array.isArray) ?? [];
                yield* arr as unknown[];
              } else {
                const head = await headOf(await openStream(), 4096);
                yield* streamItems(openStream, detectWrapperKey(head));
              }
            },
          }),
          raw: async () => {
            if (size > STREAM_THRESHOLD_BYTES) {
              throw new Error(`refusing to buffer ${entry.fileName} (${size} bytes)`);
            }
            return JSON.parse((await bufferOf(await openStream())).toString('utf8'));
          },
        };

        onEntry(src)
          .then(() => zip.readEntry())
          .catch(reject);
      });

      zip.readEntry();
    });
  });
}
