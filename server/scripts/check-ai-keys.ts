/**
 * Verifies HF_TOKEN and GCV_API_KEY against the live provider APIs with a tiny
 * generated image — run this once after setting keys to confirm the pipeline
 * will work before uploading anything.
 *
 *   cd server && npx tsx scripts/check-ai-keys.ts
 */
import { deflateSync } from 'node:zlib';

process.env.AI_PROVIDER = 'real';

const { getAiProvider } = await import('../src/providers/ai');
const { AiProviderError } = await import('../src/providers/ai/errors');

/** Minimal valid PNG: 96x64, horizontal orange→blue gradient (procedural, no deps). */
function generatePng(width = 96, height = 64): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB

  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const t = x / (width - 1);
      raw[row + 1 + x * 3] = Math.round(240 - 180 * t); // R
      raw[row + 2 + x * 3] = Math.round(160 - 100 * t); // G
      raw[row + 3 + x * 3] = Math.round(60 + 180 * t); // B
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const provider = getAiProvider();
const image = {
  data: generatePng(),
  mime: 'image/png',
  filename: 'keycheck.png',
  attempt: 1,
};

console.log(`provider: ${provider.name}\n`);

async function run(label: string, fn: () => Promise<unknown>): Promise<boolean> {
  const started = Date.now();
  try {
    const result = await fn();
    console.log(`✔ ${label} (${Date.now() - started}ms)`);
    console.log(`  ${JSON.stringify(result).slice(0, 300)}\n`);
    return true;
  } catch (err) {
    if (err instanceof AiProviderError) {
      console.error(
        `✘ ${label} — [${err.code}] ${err.message} (retryable: ${err.retryable}, status: ${err.status ?? 'n/a'})\n`,
      );
    } else {
      console.error(`✘ ${label} — ${(err as Error).message}\n`);
    }
    return false;
  }
}

const results = await Promise.all([
  run('HF caption', () => provider.caption(image)),
  run('GCV labels', () => provider.detectLabels(image)),
  run('GCV safety', () => provider.checkSafety(image)),
]);

process.exit(results.every(Boolean) ? 0 : 1);
