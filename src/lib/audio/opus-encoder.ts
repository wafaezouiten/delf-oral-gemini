/**
 * Compressing the candidate's recording, in the tab that captured it.
 *
 * The archive holds 16 kHz PCM16 — 32 kB a second, 38 MB for a full sitting —
 * and a serverless function will not accept a body a tenth that size. So the
 * artefact that leaves the browser is Opus in an Ogg stream: about 2 kB a
 * second, which puts the same sitting near 2.4 MB and inside the platform's
 * 4.5 MB ceiling (#24).
 *
 * **Encoded from the archive, not from a second microphone.** The obvious way to
 * get Opus out of a browser is `MediaRecorder`, which would mean a second branch
 * off the audio graph recording the device stream in parallel. That would give
 * back everything Phase 6 established: the phase boundaries are sample-exact
 * because they are cut in the archive's own frames, audio captured between
 * phases is discarded rather than filed, and the duration is the sample count.
 * A second recorder would have its own idea of all three. `AudioEncoder` takes
 * the samples we already hold, so the artefact is the archive, compressed —
 * the same audio, the same boundaries, in fewer bytes.
 *
 * **Discontinuous transmission is off, deliberately.** Opus can stop emitting
 * packets during silence, which would halve the file again — and would make the
 * server's measurement, which counts the audio the packets carry, report a
 * candidate who paused as a candidate who stopped speaking. The duration penalty
 * is computed from that number, so silence has to cost bytes.
 */

import { INPUT_SAMPLE_RATE } from "@/lib/gemini/constants";
import type { RecordingEncoder } from "./archive";
import { muxOggOpus } from "./ogg-opus";
import { pcm16ToWav } from "./pcm";

/**
 * 16 kbit/s, mono.
 *
 * Chosen against the ceiling rather than for its own sake: a 20-minute sitting
 * is 2.4 MB here, which leaves room for the transcript and the multipart
 * overhead under a 4.5 MB limit, and a longer-than-expected sitting still fits.
 * Opus at this rate is comfortably above telephony for wideband speech, which is
 * what phonologie is judged on — and well below what a candidate on hotel wifi
 * can be asked to upload before their results appear.
 */
export const RECORDING_BITRATE = 16_000;

/** 20 ms packets: the rate Opus is tuned for, and 50 packets a second rather
 *  than 400 for the muxer to lace. */
export const PACKET_MICROSECONDS = 20_000;

/** Samples handed to the encoder at a time. One second, so a 20-minute sitting
 *  is 1 200 buffers rather than one 77 MB float array. */
const BLOCK_SECONDS = 1;

/** How far the encoder is allowed to fall behind before we stop feeding it. */
const MAX_QUEUED_BLOCKS = 16;

const config = (sampleRate: number, bitrateMode?: BitrateMode): AudioEncoderConfig => ({
  codec: "opus",
  sampleRate,
  numberOfChannels: 1,
  bitrate: RECORDING_BITRATE,
  ...(bitrateMode ? { bitrateMode } : {}),
  opus: { frameDuration: PACKET_MICROSECONDS, usedtx: false },
});

/**
 * The configuration this browser will actually accept, or null if none.
 *
 * A constant bitrate is asked for first, and the reason is the bug this file
 * exists for: at 16 kbit/s constant, a sitting's size is arithmetic — 2 kB a
 * second, 2.4 MB for twenty minutes — and the ceiling can be checked rather than
 * hoped for. Variable would usually be smaller, because half the débat is the
 * candidate listening, but "usually" is what put a 38 MB upload against a 4.5 MB
 * limit for three phases without anyone noticing. It stays as the fallback for a
 * browser that declines the mode, since a slightly unpredictable 2 MB is still
 * two orders of magnitude better than PCM.
 */
async function supportedConfig(sampleRate: number): Promise<AudioEncoderConfig | null> {
  // Both halves, because both are used: an encoder with nothing to feed it is
  // not support. They ship together in practice, but the préparation's
  // pre-flight row and the encode itself must be answering the same question — a
  // check that says yes where the encode says no is the warning arriving after
  // the épreuve.
  if (typeof AudioEncoder === "undefined" || typeof AudioData === "undefined") return null;
  for (const candidate of [config(sampleRate, "constant"), config(sampleRate)]) {
    try {
      if ((await AudioEncoder.isConfigSupported(candidate)).supported) return candidate;
    } catch {
      /* an unsupported config can also present as a throw */
    }
  }
  return null;
}

/** Whether this browser can produce the artefact at all. */
export async function isOpusEncodingSupported(sampleRate = INPUT_SAMPLE_RATE): Promise<boolean> {
  return (await supportedConfig(sampleRate)) !== null;
}

/**
 * Encode one phase's samples into an Ogg Opus stream.
 *
 * Throws rather than returning something smaller and wrong: the caller decides
 * what an un-encodable recording means, and silently shipping a WAV that the
 * platform will reject is not it.
 */
export async function encodePcm16ToOggOpus(
  pcm: Int16Array,
  sampleRate: number = INPUT_SAMPLE_RATE,
): Promise<Blob> {
  const chosen = await supportedConfig(sampleRate);
  if (!chosen) throw new Error("This browser cannot encode Opus");

  const packets: Uint8Array[] = [];
  let failure: Error | null = null;

  const encoder = new AudioEncoder({
    output: (chunk) => {
      const packet = new Uint8Array(chunk.byteLength);
      chunk.copyTo(packet);
      packets.push(packet);
    },
    error: (error) => {
      failure ??= error instanceof Error ? error : new Error(String(error));
    },
  });

  try {
    encoder.configure(chosen);

    const blockSamples = Math.round(sampleRate * BLOCK_SECONDS);
    for (let offset = 0; offset < pcm.length; offset += blockSamples) {
      if (failure) throw failure;
      await drainTo(encoder, MAX_QUEUED_BLOCKS);

      const block = pcm.subarray(offset, Math.min(offset + blockSamples, pcm.length));
      const data = new AudioData({
        format: "f32-planar",
        sampleRate,
        numberOfFrames: block.length,
        numberOfChannels: 1,
        // Microseconds from the start of the recording. The encoder uses it to
        // stamp its output; the file's own timeline is rebuilt from the packets
        // by the muxer, so this is bookkeeping rather than a claim.
        timestamp: Math.round((offset / sampleRate) * 1_000_000),
        data: toFloat32(block),
      });
      try {
        encoder.encode(data);
      } finally {
        data.close();
      }
    }

    await encoder.flush();
    if (failure) throw failure;
    if (packets.length === 0) throw new Error("The Opus encoder produced nothing");
  } finally {
    if (encoder.state !== "closed") encoder.close();
  }

  return muxOggOpus(packets, { inputSampleRate: sampleRate, channels: 1 });
}

/** Wait until the encoder has fewer than `limit` buffers outstanding. Without
 *  this a 20-minute recording queues twenty minutes of audio at once. */
async function drainTo(encoder: AudioEncoder, limit: number): Promise<void> {
  while (encoder.encodeQueueSize >= limit) {
    await new Promise<void>((resolve) => {
      encoder.addEventListener("dequeue", () => resolve(), { once: true });
    });
  }
}

/** PCM16 as the floats WebCodecs takes. Scaled by 32 768 in both directions,
 *  which is `floatToPcm16` read backwards for negative samples and half a code
 *  short for positive ones — inaudible, and it cannot overshoot 1.0. */
function toFloat32(block: Int16Array): Float32Array<ArrayBuffer> {
  const floats = new Float32Array(block.length);
  for (let i = 0; i < block.length; i += 1) floats[i] = block[i] / 0x8000;
  return floats;
}

/**
 * The encoder the recorder actually installs: Opus, with the recorder's WAV as
 * the answer when a browser cannot produce it.
 *
 * The fallback is not a working upload and is not meant to be. A WAV sitting is
 * eight times the platform's limit, and the finish route's per-recording cap is
 * 98 seconds of PCM16 against a monologue that cannot end before 300 — so on
 * this path a candidate who spoke normally is graded from their transcript, and
 * the only WAV that reaches the server is one from a capture that failed early.
 *
 * What it buys is that the artefact still exists and still measures, and that
 * the failure is a named event instead of a recording that quietly stops
 * existing. The candidate is told before the épreuve rather than after it, in
 * `exam-client.tsx`, which is the only point at which they can do something
 * about it: {@link isOpusEncodingSupported} is what that check asks.
 */
export function opusRecordingEncoder(options?: {
  onFallback?: (reason: string) => void;
}): RecordingEncoder {
  return async (pcm, sampleRate) => {
    try {
      return { blob: await encodePcm16ToOggOpus(pcm, sampleRate), mimeType: "audio/ogg" };
    } catch (error) {
      options?.onFallback?.(error instanceof Error ? error.message : String(error));
      return { blob: pcm16ToWav(pcm, sampleRate), mimeType: "audio/wav" };
    }
  };
}
