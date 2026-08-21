/**
 * The PCM codec: the byte-level conversions both directions of the audio
 * transport need, and nothing else.
 *
 * Split out of `recorder.ts` because the player imported half of it, which made
 * the playback path depend on the microphone for no reason other than where the
 * functions happened to be written. These are pure functions over buffers; they
 * are the easiest thing in the audio layer to test and the easiest to get subtly
 * wrong, so they live together and are tested together.
 *
 * Everything here assumes **little-endian** samples. `Int16Array` uses the
 * platform's byte order, and the WAV header written below declares LE
 * unconditionally — a correct pairing on every platform a browser runs on, and
 * one worth stating rather than discovering.
 */

/**
 * Float32 in [-1, 1] -> signed 16-bit.
 *
 * Clamped before scaling: a sample slightly outside the range — which the
 * browser's own resampler can produce around a transient — would wrap to the
 * opposite polarity as an int16 and click audibly. Asymmetric scaling (0x8000
 * negative, 0x7fff positive) because the int16 range is asymmetric; using 0x7fff
 * for both wastes the bottom code, using 0x8000 for both clips full-scale
 * positive to -32768, which is the loudest possible click.
 */
export function floatToPcm16(sample: number): number {
  const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
}

/** Convert a whole Float32 block. Allocates; use the framer for hot paths. */
export function floatBlockToPcm16(block: Float32Array): Int16Array {
  const out = new Int16Array(block.length);
  for (let i = 0; i < block.length; i += 1) out[i] = floatToPcm16(block[i]);
  return out;
}

/**
 * Base64-encode PCM samples for the Live API's `audio.data` field.
 *
 * Chunked because `String.fromCharCode(...array)` blows the argument limit on
 * anything larger than a few tens of kB — a failure that only shows up once
 * someone speaks for a while, which is the worst time to find it.
 */
export function int16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Decode base64 PCM (Gemini's audio output) back into samples.
 *
 * An odd byte count cannot be a whole number of 16-bit samples. That should
 * never arrive, but `new Int16Array(bytes.buffer)` *throws* on one, and a throw
 * here lands in the middle of a `serverContent` handler — so one malformed chunk
 * would take down the message pump and with it the rest of the épreuve. The
 * trailing byte is dropped instead: a third of a millisecond of audio against a
 * dead session.
 */
export function base64ToInt16(base64: string): Int16Array {
  const binary = atob(base64);
  const usable = binary.length - (binary.length % 2);
  const bytes = new Uint8Array(usable);
  for (let i = 0; i < usable; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

/**
 * Wrap raw PCM16 in a 44-byte canonical WAV header.
 *
 * Needed because the archive is headerless samples: Gemini's file API, an
 * <audio> element and every desktop player all need the header to know the
 * sample rate. Written by hand rather than pulled from a dependency — it is 44
 * bytes of well-specified format.
 */
export function pcm16ToWav(samples: Int16Array, sampleRate: number): Blob {
  const dataBytes = samples.byteLength;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true); // file size minus the first 8 bytes
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // format 1 = PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate = rate * channels * 2
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);

  new Uint8Array(buffer, 44).set(
    new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength),
  );

  return new Blob([buffer], { type: "audio/wav" });
}

/** What a WAV says about itself, once it has been checked for saying it twice. */
export interface WavFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Bytes of audio actually present, which is not always what the header claims. */
  dataBytes: number;
  /** Measured: `dataBytes` divided by the rate the format fields imply. */
  durationSeconds: number;
}

/**
 * Read a WAV's format and its true length out of the file itself.
 *
 * The counterpart to `pcm16ToWav`, and the reason it lives here: the duration
 * that feeds the DELF duration penalty must be *measured*, and the strongest
 * available measurement is the one taken from the bytes that were received
 * rather than from a number a browser sent alongside them. The recorder counts
 * its own samples too; this is the reader checking that count against the
 * artefact instead of trusting it.
 *
 * Two things it deliberately does not take on faith:
 *
 *  - **The declared data size**, which is clamped to what the file actually
 *    contains. A truncated upload is short audio, not a long recording with a
 *    promise attached.
 *  - **The declared `byteRate`**, which is not used to compute anything. It is a
 *    redundant field — `sampleRate × channels × bitsPerSample / 8` says the same
 *    thing — and a file whose two copies disagree is rejected rather than
 *    measured. Dividing by the declared one would mean a hand-built header
 *    claiming 100 bytes a second could turn a two-second file into a five-minute
 *    recording, which is exactly the "take the client's word for it" this exists
 *    to avoid. The format fields are still the file's own claim; what a caller
 *    does about that is `checkWavFormat`'s business.
 *
 * Walks the chunk list rather than assuming the canonical 44-byte header, so a
 * file that picked up a `LIST` or `fact` chunk on the way still measures.
 *
 * Returns null when this is not a WAV we can measure — the caller then knows it
 * has no duration rather than a plausible zero.
 */
export function readWavFormat(bytes: ArrayBuffer): WavFormat | null {
  if (bytes.byteLength < 12) return null;
  const view = new DataView(bytes);

  const ascii = (offset: number, length: number) => {
    let text = "";
    for (let i = 0; i < length; i += 1) text += String.fromCharCode(view.getUint8(offset + i));
    return text;
  };

  if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE") return null;

  let format: {
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    byteRate: number;
  } | null = null;
  let dataBytes: number | null = null;

  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;

    if (id === "fmt " && size >= 16 && body + 16 <= bytes.byteLength) {
      format = {
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        byteRate: view.getUint32(body + 8, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      dataBytes = Math.min(size, bytes.byteLength - body);
      break;
    }

    // Chunks are word-aligned: an odd size carries a pad byte that is not part
    // of it. Skipping it is what keeps the walk in step on a file that has one.
    offset = body + size + (size % 2);
  }

  if (!format || dataBytes === null) return null;

  const { sampleRate, channels, bitsPerSample, byteRate } = format;
  if (sampleRate <= 0 || channels <= 0 || bitsPerSample <= 0) return null;

  const bytesPerSecond = (sampleRate * channels * bitsPerSample) / 8;
  // The header contradicting itself is a forged or corrupt file either way, and
  // there is no honest way to pick which half to believe.
  if (byteRate !== bytesPerSecond) return null;

  return {
    sampleRate,
    channels,
    bitsPerSample,
    dataBytes,
    durationSeconds: dataBytes / bytesPerSecond,
  };
}

/**
 * Whether a WAV is one this application could have produced.
 *
 * `readWavFormat` establishes that a file is internally consistent; this is the
 * separate question of whether it is *ours* — mono 16-bit PCM at the capture
 * rate, which is the only thing `pcm16ToWav` is ever handed. Anything else
 * reaching a server that grades on duration is a file nobody in this codebase
 * wrote, and measuring it would be answering a question that was not asked.
 */
export function checkWavFormat(format: WavFormat, sampleRate: number): boolean {
  return format.sampleRate === sampleRate && format.channels === 1 && format.bitsPerSample === 16;
}

/** The measured length of a WAV, or null if it cannot be measured. See
 *  {@link readWavFormat}. */
export function wavDurationSeconds(bytes: ArrayBuffer): number | null {
  return readWavFormat(bytes)?.durationSeconds ?? null;
}
