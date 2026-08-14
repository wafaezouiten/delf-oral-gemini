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
