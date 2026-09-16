import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { readOggOpus } from "./ogg-opus";
import { readWavFormat } from "./pcm";
import {
  RECORDING_BITRATE,
  encodePcm16ToOggOpus,
  isOpusEncodingSupported,
  opusRecordingEncoder,
} from "./opus-encoder";

/**
 * What happens in a runtime with no WebCodecs.
 *
 * Which is this one: `node --test` has no `AudioEncoder`, so these tests can
 * only exercise the path a browser without one takes — and that is worth
 * pinning, because it is the single path on which a sitting loses its audio.
 * The encoding itself is verified in a real browser instead; the run is in
 * docs/AUDIO_UPLOAD.md.
 */

const pcm = new Int16Array(16_000).fill(1_000);

describe("a runtime that cannot encode Opus", () => {
  it("says so rather than being found out mid-sitting", async () => {
    assert.equal(typeof globalThis.AudioEncoder, "undefined", "no WebCodecs under node --test");
    assert.equal(await isOpusEncodingSupported(), false);
  });

  it("throws instead of returning something smaller and wrong", async () => {
    await assert.rejects(() => encodePcm16ToOggOpus(pcm, 16_000), /cannot encode Opus/);
  });

  it("falls back to a WAV, and reports the fallback", async () => {
    // The WAV cannot be uploaded — a full sitting is eight times what the route
    // accepts — so the point of the fallback is that the artefact still exists
    // and still measures. Whether it is small enough to send is the client's
    // question, and `fitsInOneRequest` is where it is asked.
    const reasons: string[] = [];
    const encode = opusRecordingEncoder({ onFallback: (reason) => reasons.push(reason) });

    const { blob, mimeType } = await encode(pcm, 16_000);

    assert.equal(mimeType, "audio/wav");
    assert.equal(reasons.length, 1);
    assert.match(reasons[0], /cannot encode Opus/);
    assert.equal(readWavFormat(await blob.arrayBuffer())?.durationSeconds, 1);
  });
});

describe("the bitrate the ceiling was chosen against", () => {
  it("is 16 kbit/s, which is 2 kB a second", () => {
    // Changing this changes whether a 20-minute sitting fits in a request. The
    // measured figure at this setting is 2 060 B/s; the arithmetic below is the
    // nominal one, and the two agree to within the container's overhead.
    assert.equal(RECORDING_BITRATE, 16_000);
    assert.equal((RECORDING_BITRATE / 8) * 20 * 60, 2_400_000);
  });
});

/**
 * WebCodecs, faked just far enough for the encoder's own loop to run: the
 * config probe, one packet out per 20 ms of input, a `dequeue` event so the
 * back-pressure wait resolves, and the two ways an encoder can go wrong. Each
 * packet is a real 20 ms CELT TOC byte followed by filler, which is all the
 * muxer and `readOggOpus` need to rebuild a timeline from it.
 */
describe("a runtime that can encode Opus", () => {
  const TWENTY_MS_CELT = 19 << 3;
  const fake = {
    supported: true,
    /** Refuse the constant-bitrate config, so the probe has to fall back. */
    refuseConstant: false,
    /** Throw from `encode()` on this call (1-based), or never. */
    failOn: null as number | null,
    /** Report an asynchronous error through the callback after this many encodes. */
    errorAfter: null as number | null,
    /** Emit no packets at all. */
    mute: false,
    encodes: 0,
    closed: 0,
    configs: [] as unknown[],
  };

  class FakeAudioData {
    numberOfFrames: number;
    constructor(init: { numberOfFrames: number }) {
      this.numberOfFrames = init.numberOfFrames;
    }
    close() {}
  }

  class FakeAudioEncoder extends EventTarget {
    static async isConfigSupported(config: { bitrateMode?: string }) {
      fake.configs.push(config);
      const refused = fake.refuseConstant && config.bitrateMode === "constant";
      return { supported: fake.supported && !refused };
    }
    state = "unconfigured";
    encodeQueueSize = 0;
    private readonly init: {
      output: (chunk: { byteLength: number; copyTo(target: Uint8Array): void }) => void;
      error: (error: unknown) => void;
    };
    constructor(init: FakeAudioEncoder["init"]) {
      super();
      this.init = init;
    }
    configure() {
      this.state = "configured";
    }
    encode(data: FakeAudioData) {
      fake.encodes += 1;
      if (fake.failOn === fake.encodes) throw new Error("encode refused");
      if (fake.errorAfter !== null && fake.encodes > fake.errorAfter) {
        this.init.error(new DOMException("encoder reset", "EncodingError"));
        return;
      }
      if (fake.mute) return;
      // One packet per 20 ms of the block.
      for (let i = 0; i < Math.round(data.numberOfFrames / 320); i += 1) {
        const bytes = new Uint8Array([TWENTY_MS_CELT, 0x00, 0x11, 0x22]);
        this.init.output({ byteLength: bytes.length, copyTo: (target) => target.set(bytes) });
      }
      this.dispatchEvent(new Event("dequeue"));
    }
    async flush() {}
    close() {
      this.state = "closed";
      fake.closed += 1;
    }
  }

  before(() => {
    Object.assign(globalThis, { AudioEncoder: FakeAudioEncoder, AudioData: FakeAudioData });
  });
  after(() => {
    delete (globalThis as { AudioEncoder?: unknown }).AudioEncoder;
    delete (globalThis as { AudioData?: unknown }).AudioData;
  });
  const reset = () =>
    Object.assign(fake, {
      supported: true,
      refuseConstant: false,
      failOn: null,
      errorAfter: null,
      mute: false,
      encodes: 0,
      closed: 0,
      configs: [],
    });

  it("asks for constant bitrate with DTX off, and encodes one block per second", async () => {
    reset();
    const three = new Int16Array(3 * 16_000).fill(1_000);
    const blob = await encodePcm16ToOggOpus(three, 16_000);

    assert.equal(fake.encodes, 3, "one block per second of input");
    assert.equal(fake.closed, 1);
    const config = fake.configs[0] as { bitrateMode?: string; opus?: { usedtx?: boolean } };
    assert.equal(config.bitrateMode, "constant");
    assert.equal(config.opus?.usedtx, false);

    const read = readOggOpus(await blob.arrayBuffer());
    assert.equal(read?.durationSeconds, 3, "the muxed file measures what went in");
  });

  it("closes the encoder and rethrows when a block is refused", async () => {
    reset();
    fake.failOn = 2;
    await assert.rejects(
      () => encodePcm16ToOggOpus(new Int16Array(3 * 16_000), 16_000),
      /encode refused/,
    );
    assert.equal(fake.closed, 1, "closed on the way out, whatever happened");
  });

  it("surfaces an error the encoder reported asynchronously, at the next block", async () => {
    reset();
    fake.errorAfter = 1;
    await assert.rejects(
      () => encodePcm16ToOggOpus(new Int16Array(3 * 16_000), 16_000),
      /encoder reset/,
    );
    assert.equal(fake.closed, 1);
  });

  it("refuses to hand back an empty file when the encoder produced nothing", async () => {
    reset();
    fake.mute = true;
    await assert.rejects(() => encodePcm16ToOggOpus(pcm, 16_000), /produced nothing/);
  });

  it("falls back to the plain config when constant bitrate is refused", async () => {
    reset();
    fake.refuseConstant = true;
    assert.equal(await isOpusEncodingSupported(16_000), true);
    assert.equal(fake.configs.length, 2, "constant first, then without the mode");
    assert.equal((fake.configs[1] as { bitrateMode?: string }).bitrateMode, undefined);
  });
});
