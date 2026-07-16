import { describe, expect, it } from 'vitest';
import { sniffImage } from '../src/lib/imageSniff';
import { fakeJpeg, fakePng, fakeWebp } from './helpers/fixtures';

describe('sniffImage (magic-byte validation, D-015)', () => {
  it('detects JPEG by signature', () => {
    expect(sniffImage(fakeJpeg())).toEqual({ ext: 'jpg', mime: 'image/jpeg' });
  });

  it('detects PNG by signature', () => {
    expect(sniffImage(fakePng())).toEqual({ ext: 'png', mime: 'image/png' });
  });

  it('detects WEBP by RIFF container + WEBP fourcc', () => {
    expect(sniffImage(fakeWebp())).toEqual({ ext: 'webp', mime: 'image/webp' });
  });

  it('rejects text content regardless of claimed type (renamed .txt -> .jpg)', () => {
    expect(sniffImage(Buffer.from('hello, definitely not an image'))).toBeNull();
  });

  it('rejects a GIF (not in the allowed set)', () => {
    expect(sniffImage(Buffer.from('GIF89a....'))).toBeNull();
  });

  it('rejects RIFF that is not WEBP (e.g. WAV audio)', () => {
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]);
    expect(sniffImage(wav)).toBeNull();
  });

  it('rejects empty and tiny buffers', () => {
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
    expect(sniffImage(Buffer.from([0xff]))).toBeNull();
  });
});
