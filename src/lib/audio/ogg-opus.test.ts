import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_PACKET_SAMPLES,
  OPUS_GRANULE_RATE,
  checkOggOpusFormat,
  muxOggOpus,
  oggOpusDurationSeconds,
  opusPacketSamples,
  readOggOpus,
} from "./ogg-opus";

/**
 * The container the recording is uploaded in, and the one number the server
 * takes out of it.
 *
 * The measurement is what these tests are really about. A duration read from a
 * field the client wrote would make the DELF duration penalty a number the
 * graded party chooses; a duration summed over the packets that are present is a
 * measurement of the audio the corrector will hear. So it must survive a round
 * trip, it must fall when bytes go missing, and it must refuse a file whose two
 * accounts of its own length disagree.
 */

/** The capture rate, spelled out rather than imported: this file is about the
 *  format, and a change to the exam's rate should not silently rewrite it. */
const CAPTURE_RATE = 16_000;

/** A fixed serial, so a muxed stream is byte-identical from run to run. */
const SERIAL = 0x0de1_f000;

/** How many single-segment packets fit on one page. The page's segment table is
 *  one byte long, so this is where the writer has to start a new page. */
const PACKETS_PER_PAGE = 255;

/**
 * A packet that decodes to `ms` of audio, with a plausible payload behind it.
 *
 * The configuration number in the TOC picks the mode and the frame size: SILK
 * covers 10/20/40/60 ms and CELT 2.5/5/10/20, which is where these come from.
 */
function packet(ms: number, bytes = 40): Uint8Array {
  const config: Record<string, number> = {
    "2.5": 16,
    "5": 17,
    "10": 18,
    "20": 19,
    "40": 10,
    "60": 11,
  };
  const chosen = config[String(ms)];
  assert.ok(chosen !== undefined, `no config for ${ms} ms`);

  const data = new Uint8Array(bytes);
  data[0] = (chosen << 3) | 0; // code 0: one frame in the packet
  for (let i = 1; i < bytes; i += 1) data[i] = i & 0xff;
  return data;
}

function packets(count: number, ms = 20): Uint8Array[] {
  return Array.from({ length: count }, () => packet(ms));
}

function bytesOf(list: readonly Uint8Array[]): Promise<ArrayBuffer> {
  return muxOggOpus(list, { inputSampleRate: CAPTURE_RATE, serial: SERIAL }).arrayBuffer();
}

describe("reading a packet's length out of the packet", () => {
  it("knows every frame size the three modes define", () => {
    const at = (config: number) => opusPacketSamples(new Uint8Array([config << 3]));

    // SILK, narrow through wideband: 10, 20, 40, 60 ms in each block.
    assert.deepEqual([at(0), at(1), at(2), at(3)], [480, 960, 1920, 2880]);
    assert.deepEqual([at(8), at(9), at(10), at(11)], [480, 960, 1920, 2880]);
    // Hybrid: 10 and 20 ms only.
    assert.deepEqual([at(12), at(13), at(14), at(15)], [480, 960, 480, 960]);
    // CELT: 2.5, 5, 10, 20 ms.
    assert.deepEqual([at(16), at(17), at(18), at(19)], [120, 240, 480, 960]);
    assert.deepEqual([at(28), at(29), at(30), at(31)], [120, 240, 480, 960]);
  });

  it("counts the frames the code asks for", () => {
    const twentyMs = 19 << 3;
    assert.equal(opusPacketSamples(new Uint8Array([twentyMs | 0])), 960);
    assert.equal(opusPacketSamples(new Uint8Array([twentyMs | 1])), 1_920);
    assert.equal(opusPacketSamples(new Uint8Array([twentyMs | 2])), 1_920);
    // Code 3 puts the frame count in the second byte, which is why two bytes of
    // a packet are enough to measure it.
    assert.equal(opusPacketSamples(new Uint8Array([twentyMs | 3, 6])), 5_760);
  });

  it("refuses a packet that cannot say how long it is", () => {
    assert.equal(opusPacketSamples(new Uint8Array([])), null);
    assert.equal(opusPacketSamples(new Uint8Array([(19 << 3) | 3])), null);
    assert.equal(opusPacketSamples(new Uint8Array([(19 << 3) | 3, 0])), null);
  });

  it("refuses a packet claiming more than the 120 ms a packet may hold", () => {
    // 48 frames of 60 ms would be 2.88 s in one packet, and the format forbids
    // it. Believing it is how a short recording claims to be a long one.
    assert.equal(opusPacketSamples(new Uint8Array([(11 << 3) | 3, 48])), null);
    assert.equal(MAX_PACKET_SAMPLES, 5_760);
  });
});

describe("a muxed stream", () => {
  it("measures back to the audio that went in", async () => {
    // Twelve seconds, which is three audio pages: the walk has to carry its
    // running total across page boundaries, not just along one segment table.
    const count = 600;
    const bytes = await bytesOf(packets(count));
    const format = readOggOpus(bytes);

    assert.ok(count > PACKETS_PER_PAGE * 2);
    assert.ok(format);
    assert.equal(format.packets, count);
    assert.equal(format.audioSamples, count * 960);
    assert.equal(format.durationSeconds, 12);
    assert.equal(format.truncated, false);
  });

  it("carries the capture rate and the channel count back out", async () => {
    const format = readOggOpus(await bytesOf(packets(3)));

    assert.ok(format);
    assert.equal(format.channels, 1);
    assert.equal(format.inputSampleRate, CAPTURE_RATE);
    assert.equal(format.preSkip, 0);
    assert.ok(checkOggOpusFormat(format, CAPTURE_RATE));
    // A file encoded from something other than the exam's capture is not ours.
    assert.equal(checkOggOpusFormat(format, 48_000), false);
  });

  it("measures a mixture of frame sizes packet by packet", async () => {
    // Real speech does not encode at one frame size; the encoder switches when
    // the signal does. A reader that assumed a constant packet length would be
    // right on a test tone and wrong on a candidate.
    const format = readOggOpus(
      await bytesOf([packet(60), packet(20), packet(2.5), packet(40), packet(10)]),
    );

    assert.ok(format);
    assert.equal(format.audioSamples, 2_880 + 960 + 120 + 1_920 + 480);
  });

  it("survives a packet long enough to need several lacing segments", async () => {
    // 600 bytes is three segments, and the length only comes back if the writer
    // wrote 255, 255, 90 and the reader added them up again.
    const format = readOggOpus(await bytesOf([packet(20, 600), packet(20)]));

    assert.ok(format);
    assert.equal(format.packets, 2);
    assert.equal(format.audioSamples, 2 * 960);
  });

  it("terminates a packet whose length is an exact multiple of 255", async () => {
    // The trailing zero segment is what says the packet stopped there. Drop it
    // and this packet swallows the next one.
    const format = readOggOpus(await bytesOf([packet(20, 510), packet(40)]));

    assert.ok(format);
    assert.equal(format.packets, 2);
    assert.equal(format.audioSamples, 960 + 1_920);
  });

  it("is the size Opus promises rather than the size PCM would have been", async () => {
    // The whole point of #24: a minute of 16 kHz PCM16 is 1.9 MB, and the same
    // minute of 20 ms Opus packets is a few tens of kilobytes.
    const oneMinute = await bytesOf(packets(3_000));

    assert.equal(readOggOpus(oneMinute)?.durationSeconds, 60);
    assert.ok(oneMinute.byteLength < 60 * 4_000, `a minute muxed to ${oneMinute.byteLength} bytes`);
  });
});

describe("a stream that arrived damaged", () => {
  it("measures a truncated upload as the audio it contains", async () => {
    // The WAV reader clamps the declared data size to the bytes present; this is
    // the same judgement. A cut-off upload is a short recording, not a long one
    // with a promise attached.
    const whole = await bytesOf(packets(600));
    const format = readOggOpus(whole.slice(0, Math.floor(whole.byteLength / 2)));

    assert.ok(format);
    assert.equal(format.truncated, true);
    assert.ok(format.durationSeconds > 0);
    assert.ok(format.durationSeconds < 12);
  });

  it("stops at a page whose checksum does not hold", async () => {
    const whole = new Uint8Array(await bytesOf(packets(600)));
    // One flipped byte in the last page's payload. Everything before it is still
    // audio that arrived intact; everything from it on is unverifiable.
    whole[whole.length - 200] ^= 0xff;
    const format = readOggOpus(whole.buffer as ArrayBuffer);

    assert.ok(format);
    assert.equal(format.truncated, true);
    assert.ok(format.durationSeconds > 0);
    assert.ok(format.durationSeconds < 12);
  });

  it("is not a stream at all without the magic", async () => {
    const bytes = new Uint8Array(await bytesOf(packets(3)));
    bytes[0] = 0x00;
    assert.equal(readOggOpus(bytes.buffer as ArrayBuffer), null);
  });

  it("is not a stream without an OpusHead", async () => {
    const bytes = new Uint8Array(await bytesOf(packets(3)));
    // The head packet starts after the first page's 27-byte header and its one
    // lacing byte.
    bytes[28] += 1;
    assert.equal(readOggOpus(bytes.buffer as ArrayBuffer), null);
  });

  it("has no duration when it has no audio packets", async () => {
    const empty = await bytesOf([]);
    assert.equal(readOggOpus(empty), null);
    assert.equal(oggOpusDurationSeconds(empty), null);
  });
});

describe("a stream whose two accounts of its length disagree", () => {
  /**
   * Ogg's CRC-32, written out independently of the implementation under test:
   * a re-stamped page has to be one a correct reader accepts, or the granule
   * checks below would pass for the wrong reason.
   */
  function oggCrc(page: Uint8Array): number {
    let crc = 0;
    for (const byte of page) {
      crc = (crc ^ (byte << 24)) >>> 0;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc & 0x8000_0000) !== 0 ? ((crc << 1) ^ 0x04c1_1db7) >>> 0 : (crc << 1) >>> 0;
      }
    }
    return crc;
  }

  /** Rewrite the last page's granule position, leaving the page checksum valid. */
  async function withFinalGranule(claimed: number): Promise<ArrayBuffer> {
    const bytes = new Uint8Array(await bytesOf(packets(10)));

    let start = -1;
    for (let i = bytes.length - 4; i >= 0; i -= 1) {
      const isMagic =
        bytes[i] === 0x4f &&
        bytes[i + 1] === 0x67 &&
        bytes[i + 2] === 0x67 &&
        bytes[i + 3] === 0x53;
      if (isMagic) {
        start = i;
        break;
      }
    }
    assert.ok(start >= 0);

    const view = new DataView(bytes.buffer);
    view.setUint32(start + 6, claimed >>> 0, true);
    view.setUint32(start + 10, Math.floor(claimed / 0x1_0000_0000), true);
    view.setUint32(start + 22, 0, true);
    view.setUint32(start + 22, oggCrc(bytes.subarray(start)), true);
    return bytes.buffer as ArrayBuffer;
  }

  it("accepts the granule position its packets add up to", async () => {
    const format = readOggOpus(await withFinalGranule(10 * 960));

    assert.ok(format);
    assert.equal(format.audioSamples, 10 * 960);
  });

  it("refuses a file claiming more audio than its packets carry", async () => {
    // The attack this rules out: a two-second recording stamped as a
    // seven-minute one, to escape the duration penalty without speaking.
    assert.equal(readOggOpus(await withFinalGranule(7 * 60 * OPUS_GRANULE_RATE)), null);
  });

  it("refuses a file claiming materially less", async () => {
    assert.equal(readOggOpus(await withFinalGranule(960)), null);
  });

  it("allows the last packet to be trimmed, as the format permits", async () => {
    // An encoder may end a stream mid-packet by stamping a granule a little
    // short of the audio it wrote. Within one packet is legitimate; the check
    // exists for the file that is out by minutes.
    assert.ok(readOggOpus(await withFinalGranule(10 * 960 - 400)));
  });
});
