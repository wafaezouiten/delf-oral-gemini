/**
 * Ogg Opus: the container the candidate's recording travels in, and the
 * arithmetic that measures one.
 *
 * **Why the recording is not a WAV any more.** 16 kHz mono PCM16 is 32 kB a
 * second, so a full sitting — a ~7 minute monologue and a ~13 minute débat — is
 * roughly 38 MB. A serverless function accepts a 4.5 MB request body, so the
 * upload never reached the route at all: audio grading, the entire premise of
 * the project, could not succeed on a deployed URL (#24). Opus at 16 kbit/s is
 * 2 kB a second, which puts the same sitting at about 2.4 MB — inside the
 * ceiling, with the transcript and the multipart overhead beside it.
 *
 * Written by hand rather than pulled from a dependency, for the same reason the
 * 44-byte WAV header next door is: the format is small, well specified, and the
 * one thing in it that matters to this application — how long the recording is —
 * is something we refuse to take on trust from whoever sent the file.
 *
 * **How a duration is measured here.** Every Opus packet carries its own length
 * in its first byte: the TOC's configuration number picks a frame size and its
 * bottom two bits say how many frames follow. Summing that over the packets that
 * are actually present is the direct equivalent of the WAV reader's `dataBytes /
 * bytesPerSecond` — it counts audio that arrived rather than believing a number
 * written beside it. A truncated upload measures short, which is the honest
 * answer, and the same one `readWavFormat` gives.
 *
 * The granule position on the last page says the same thing a second time, and
 * is checked against the sum rather than used: a file whose two accounts of its
 * own length disagree is corrupt or forged either way, exactly like the WAV
 * whose `byteRate` contradicts its format fields.
 *
 * What compression does cost is the *plausibility* bound. 38 MB of WAV cannot
 * claim to be more than about 20 minutes; 2 kB of Opus can claim an hour of
 * silence. That bound was never the load-bearing part, though — a candidate
 * could always upload twenty minutes of zeroes — and what still holds is the
 * property that matters: the duration is measured from the same bytes the
 * corrector listens to, so a recording that claims to be long and is silent is
 * graded as a long silence.
 *
 * Pure, and deliberately free of both the browser and the server: the muxer runs
 * in a tab (`opus-encoder.ts`), the reader runs in the finish route, and neither
 * half is testable if the arithmetic lives with either of them.
 */

/** Opus counts time in 48 kHz samples whatever rate it was fed. */
export const OPUS_GRANULE_RATE = 48_000;

/** The longest an Opus packet may be: 120 ms, per RFC 6716 §3.1. */
export const MAX_PACKET_SAMPLES = 5_760;

/** `OpusHead`, and therefore the smallest thing that can be an Opus stream. */
const HEAD_BYTES = 19;

const OGG_MAGIC = [0x4f, 0x67, 0x67, 0x53] as const; // "OggS"
const PAGE_HEADER_BYTES = 27;

// 0x01, "this page continues a packet", is deliberately absent: the reader
// carries the unfinished packet across pages itself, so the flag would be a
// second opinion about something it already knows.
const FLAG_BOS = 0x02;
const FLAG_EOS = 0x04;

/** A granule position of all-ones means "no packet finishes on this page". */
const GRANULE_UNSET = 0xffff_ffff_ffff_ffff;

// ------------------------------------------------------------------ packets

/**
 * How much audio one packet is worth, in 48 kHz samples, or null if its first
 * bytes are not a legal TOC.
 *
 * RFC 6716 §3.1. The configuration number in the top five bits picks the mode
 * and the frame size; the bottom two bits say whether one, two, or an arbitrary
 * number of frames follow — and in the arbitrary case the count is in the second
 * byte, which is why a caller may hand over just the first two bytes of a packet
 * and get the same answer as one handing over all of it.
 */
export function opusPacketSamples(packet: Uint8Array): number | null {
  if (packet.length < 1) return null;

  const toc = packet[0];
  const config = toc >> 3;
  // SILK (0-11) runs 10/20/40/60 ms, hybrid (12-15) 10/20 ms, and CELT (16-31)
  // 2.5/5/10/20 ms — in each case cycling within the bandwidth's block.
  const frameSamples =
    config < 12
      ? [480, 960, 1920, 2880][config % 4]
      : config < 16
        ? [480, 960][(config - 12) % 2]
        : [120, 240, 480, 960][(config - 16) % 4];

  let frames: number;
  switch (toc & 0b11) {
    case 0:
      frames = 1;
      break;
    case 1:
    case 2:
      frames = 2;
      break;
    default:
      if (packet.length < 2) return null;
      frames = packet[1] & 0b0011_1111;
      break;
  }

  if (frames < 1) return null;
  const samples = frames * frameSamples;
  // A packet longer than 120 ms is not a packet, it is a misread.
  return samples > MAX_PACKET_SAMPLES ? null : samples;
}

// ---------------------------------------------------------------------- CRC

/**
 * Ogg's CRC-32: polynomial 0x04c11db7, MSB first, no reflection, no final xor.
 *
 * Not the same CRC-32 as zip or PNG — those reflect both ways and invert the
 * result — so it is generated here rather than borrowed from something that
 * sounds like it would do.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let byte = 0; byte < 256; byte += 1) {
    let remainder = byte << 24;
    for (let bit = 0; bit < 8; bit += 1) {
      remainder = (remainder & 0x8000_0000) !== 0 ? (remainder << 1) ^ 0x04c1_1db7 : remainder << 1;
    }
    table[byte] = remainder >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array, from = 0, to = bytes.length, seed = 0): number {
  let crc = seed;
  for (let i = from; i < to; i += 1) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  }
  return crc;
}

// -------------------------------------------------------------------- muxing

export interface OggOpusOptions {
  /**
   * The rate the encoder was fed at, written into `OpusHead`.
   *
   * A decoder ignores it — Opus always decodes to 48 kHz — but the server reads
   * it back as the marker of a file this application produced, the same job
   * `checkWavFormat` does for the recorder's WAVs.
   */
  inputSampleRate: number;
  channels?: number;
  /**
   * Samples the decoder should discard at the start.
   *
   * Zero, because WebCodecs does not report the encoder's lookahead and
   * inventing one would trim real speech. The cost is roughly 6 ms of encoder
   * warm-up left at the head of the file, which is silence in every sitting and
   * nothing a correction turns on.
   */
  preSkip?: number;
  /** Stream serial. Random by default, as the format asks; fixed in tests. */
  serial?: number;
  vendor?: string;
}

/**
 * Pack Opus packets into an Ogg stream.
 *
 * Packets are never split across pages: at 20 ms and 16 kbit/s a packet is about
 * 40 bytes, so the 255-segment limit lands ~250 packets — five seconds — on each
 * page, and a splitter would be a page of code for a case that cannot arise.
 * A packet too large to fit on a page of its own throws rather than being
 * silently mangled.
 */
export function muxOggOpus(packets: readonly Uint8Array[], options: OggOpusOptions): Blob {
  const channels = options.channels ?? 1;
  const preSkip = options.preSkip ?? 0;
  const serial = options.serial ?? randomSerial();

  const pages: Uint8Array[] = [];
  let sequence = 0;
  const emit = (pagePackets: readonly Uint8Array[], granule: number, flags: number) => {
    pages.push(buildPage({ packets: pagePackets, granule, flags, serial, sequence }));
    sequence += 1;
  };

  // The two header packets each own a page, which the format requires of
  // `OpusHead` and every implementation expects of `OpusTags`.
  emit([opusHead(channels, preSkip, options.inputSampleRate)], 0, FLAG_BOS);
  emit([opusTags(options.vendor ?? "delf-oral-gemini")], 0, packets.length === 0 ? FLAG_EOS : 0);

  let pending: Uint8Array[] = [];
  let pendingSegments = 0;
  // Granule positions include the pre-skip: they count decoded samples, and the
  // decoder throws the pre-skip away after counting it.
  let granule = preSkip;

  for (let i = 0; i < packets.length; i += 1) {
    const packet = packets[i];
    const segments = Math.floor(packet.length / 255) + 1;
    if (segments > 255) {
      throw new RangeError(`An Opus packet of ${packet.length} bytes cannot fit on one Ogg page`);
    }
    if (pendingSegments + segments > 255) {
      emit(pending, granule, 0);
      pending = [];
      pendingSegments = 0;
    }
    pending.push(packet);
    pendingSegments += segments;
    // Self-consistent on purpose: the granule the file will be measured against
    // is derived from the packets themselves, not from a clock kept beside them.
    granule += opusPacketSamples(packet) ?? 0;

    if (i === packets.length - 1) emit(pending, granule, FLAG_EOS);
  }

  return new Blob(pages as BlobPart[], { type: "audio/ogg" });
}

function buildPage(params: {
  packets: readonly Uint8Array[];
  granule: number;
  flags: number;
  serial: number;
  sequence: number;
}): Uint8Array {
  const lacing: number[] = [];
  let payloadBytes = 0;
  for (const packet of params.packets) {
    // A packet's length is written as however many 255s it takes plus the
    // remainder — so a length that is an exact multiple of 255 still ends with a
    // terminating zero, which is what tells a reader the packet stopped there.
    let remaining = packet.length;
    while (remaining >= 255) {
      lacing.push(255);
      remaining -= 255;
    }
    lacing.push(remaining);
    payloadBytes += packet.length;
  }

  const page = new Uint8Array(PAGE_HEADER_BYTES + lacing.length + payloadBytes);
  const view = new DataView(page.buffer);

  page.set(OGG_MAGIC, 0);
  page[4] = 0; // stream structure version
  page[5] = params.flags;
  writeUint64LE(view, 6, params.granule);
  view.setUint32(14, params.serial, true);
  view.setUint32(18, params.sequence, true);
  view.setUint32(22, 0, true); // the CRC field is zero while the CRC is taken
  page[26] = lacing.length;
  page.set(lacing, PAGE_HEADER_BYTES);

  let offset = PAGE_HEADER_BYTES + lacing.length;
  for (const packet of params.packets) {
    page.set(packet, offset);
    offset += packet.length;
  }

  view.setUint32(22, crc32(page), true);
  return page;
}

function opusHead(channels: number, preSkip: number, inputSampleRate: number): Uint8Array {
  const head = new Uint8Array(HEAD_BYTES);
  const view = new DataView(head.buffer);
  writeAscii(head, 0, "OpusHead");
  head[8] = 1; // version
  head[9] = channels;
  view.setUint16(10, preSkip, true);
  view.setUint32(12, inputSampleRate, true);
  view.setInt16(16, 0, true); // output gain
  head[18] = 0; // channel mapping family 0: mono or plain stereo
  return head;
}

function opusTags(vendor: string): Uint8Array {
  const vendorBytes = new TextEncoder().encode(vendor);
  const tags = new Uint8Array(8 + 4 + vendorBytes.length + 4);
  const view = new DataView(tags.buffer);
  writeAscii(tags, 0, "OpusTags");
  view.setUint32(8, vendorBytes.length, true);
  tags.set(vendorBytes, 12);
  view.setUint32(12 + vendorBytes.length, 0, true); // no user comments
  return tags;
}

function writeAscii(target: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) target[offset + i] = text.charCodeAt(i);
}

function writeUint64LE(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
  view.setUint32(offset + 4, Math.floor(value / 0x1_0000_0000), true);
}

/** The format asks for a serial that will not collide with another stream's. */
function randomSerial(): number {
  const crypto = globalThis.crypto;
  if (crypto?.getRandomValues) return crypto.getRandomValues(new Uint32Array(1))[0];
  return Math.floor(Math.random() * 0xffff_ffff) >>> 0;
}

// ------------------------------------------------------------------- reading

/** What an Ogg Opus file says about itself, once it has been made to say it twice. */
export interface OggOpusFormat {
  channels: number;
  preSkip: number;
  /** From `OpusHead`; informational to a decoder, see {@link OggOpusOptions}. */
  inputSampleRate: number;
  /** Audio packets whose bytes are all present. */
  packets: number;
  /** 48 kHz samples of audio, summed packet by packet. */
  audioSamples: number;
  /** Measured: {@link audioSamples} over 48 000. */
  durationSeconds: number;
  /**
   * True when the walk stopped before the end-of-stream page — a short page, a
   * checksum that did not hold, a file that simply stops. What is measured is
   * then what arrived, which is the same answer a truncated WAV gets.
   */
  truncated: boolean;
}

/**
 * Read an Ogg Opus file's format and its true length out of the file itself.
 *
 * The counterpart to {@link muxOggOpus}, and the Opus half of what
 * `readWavFormat` does for the recorder's WAVs. Four things it deliberately does
 * not take on faith:
 *
 *  - **The page checksums**, which are verified. A page that fails ends the walk
 *    rather than failing the file: bytes that arrived intact are audio the
 *    corrector will hear, and the honest measurement is of them.
 *  - **The granule positions**, which are checked against the summed packet
 *    durations and then discarded. A stream whose last page claims a length its
 *    packets do not add up to is refused — the same judgement `readWavFormat`
 *    makes about a `byteRate` that contradicts the format fields.
 *  - **The declared page length**, which is clamped by the buffer: a page whose
 *    segment table runs off the end of the file is a truncation, not a promise.
 *  - **The stream serial**, which binds the walk to the first stream in the
 *    file, so pages of a second multiplexed stream cannot add to this one's
 *    duration.
 *
 * Returns null when this is not an Opus stream we can measure — the caller then
 * knows it has no duration, rather than a plausible zero.
 */
export function readOggOpus(bytes: ArrayBuffer): OggOpusFormat | null {
  const data = new Uint8Array(bytes);
  const view = new DataView(bytes);

  let head: { channels: number; preSkip: number; inputSampleRate: number } | null = null;
  let serial: number | null = null;
  let packetIndex = 0;
  let audioPackets = 0;
  let audioSamples = 0;
  let lastGranule: number | null = null;
  let sawEndOfStream = false;

  /** A packet in progress: where it started, and how many bytes it has so far. */
  let packetStart = -1;
  let packetBytes = 0;

  let offset = 0;
  while (offset + PAGE_HEADER_BYTES <= data.length) {
    if (!matchesMagic(data, offset)) return null;
    if (data[offset + 4] !== 0) return null;

    const flags = data[offset + 5];
    const segmentCount = data[offset + 26];
    const tableStart = offset + PAGE_HEADER_BYTES;
    const tableEnd = tableStart + segmentCount;
    if (tableEnd > data.length) break;

    let payloadBytes = 0;
    for (let i = 0; i < segmentCount; i += 1) payloadBytes += data[tableStart + i];
    const pageEnd = tableEnd + payloadBytes;
    if (pageEnd > data.length) break;

    const pageSerial = view.getUint32(offset + 14, true);
    if (serial === null) {
      // The first page is the one that names the stream being measured.
      if ((flags & FLAG_BOS) === 0) return null;
      serial = pageSerial;
    } else if (pageSerial !== serial) {
      offset = pageEnd;
      continue;
    }

    if (!checksumHolds(data, view, offset, pageEnd)) break;

    const granule = readUint64LE(view, offset + 6);

    let payloadOffset = tableEnd;
    for (let i = 0; i < segmentCount; i += 1) {
      const lace = data[tableStart + i];
      if (packetStart < 0) packetStart = payloadOffset;
      packetBytes += lace;
      payloadOffset += lace;
      if (lace === 255) continue;

      // The packet ends here. Only its first two bytes decide its duration, and
      // they are in the page it started on — so a packet spanning pages is
      // measured without ever being reassembled.
      const prefix = data.subarray(packetStart, packetStart + Math.min(2, packetBytes));
      if (packetIndex === 0) {
        head = readOpusHead(data, view, packetStart, packetBytes);
        if (!head) return null;
      } else if (packetIndex > 1) {
        const samples = opusPacketSamples(prefix);
        if (samples === null) return null;
        audioSamples += samples;
        audioPackets += 1;
      }
      packetIndex += 1;
      packetStart = -1;
      packetBytes = 0;
    }

    if (granule !== GRANULE_UNSET) lastGranule = granule;
    offset = pageEnd;
    if ((flags & FLAG_EOS) !== 0) {
      // Nothing after the end-of-stream page belongs to this recording.
      sawEndOfStream = true;
      break;
    }
  }

  if (!head || audioPackets === 0) return null;

  // The stream's own second opinion. Our muxer stamps the last page with exactly
  // the pre-skip plus the packets before it, so the two agree to the sample; a
  // file that trims its tail the way the format allows lands within one packet
  // below, and anything else is not describing the audio it carries.
  if (lastGranule !== null) {
    const claimed = lastGranule - head.preSkip;
    if (claimed > audioSamples || claimed < audioSamples - MAX_PACKET_SAMPLES) return null;
  }

  return {
    channels: head.channels,
    preSkip: head.preSkip,
    inputSampleRate: head.inputSampleRate,
    packets: audioPackets,
    audioSamples,
    durationSeconds: audioSamples / OPUS_GRANULE_RATE,
    truncated: !sawEndOfStream,
  };
}

function matchesMagic(data: Uint8Array, offset: number): boolean {
  return (
    data[offset] === OGG_MAGIC[0] &&
    data[offset + 1] === OGG_MAGIC[1] &&
    data[offset + 2] === OGG_MAGIC[2] &&
    data[offset + 3] === OGG_MAGIC[3]
  );
}

/**
 * The page's CRC, recomputed the way it was taken: over the whole page with its
 * own checksum field read as four zero bytes. Taken in three passes rather than
 * by copying the page and blanking it, because a 2 MB recording is a few
 * thousand pages and none of them needs a second copy of itself.
 */
function checksumHolds(
  data: Uint8Array,
  view: DataView,
  pageStart: number,
  pageEnd: number,
): boolean {
  let crc = crc32(data, pageStart, pageStart + 22);
  crc = crc32(ZERO_CHECKSUM, 0, 4, crc);
  crc = crc32(data, pageStart + 26, pageEnd, crc);
  return crc === view.getUint32(pageStart + 22, true);
}

const ZERO_CHECKSUM = new Uint8Array(4);

function readOpusHead(
  data: Uint8Array,
  view: DataView,
  offset: number,
  length: number,
): { channels: number; preSkip: number; inputSampleRate: number } | null {
  if (length < HEAD_BYTES || offset + HEAD_BYTES > data.length) return null;
  if (readAscii(data, offset, 8) !== "OpusHead") return null;
  if (data[offset + 8] !== 1) return null; // version

  const channels = data[offset + 9];
  const inputSampleRate = view.getUint32(offset + 12, true);
  if (channels <= 0 || inputSampleRate <= 0) return null;

  return { channels, preSkip: view.getUint16(offset + 10, true), inputSampleRate };
}

function readAscii(data: Uint8Array, offset: number, length: number): string {
  let text = "";
  for (let i = 0; i < length; i += 1) text += String.fromCharCode(data[offset + i]);
  return text;
}

function readUint64LE(view: DataView, offset: number): number {
  return view.getUint32(offset, true) + view.getUint32(offset + 4, true) * 0x1_0000_0000;
}

/**
 * Whether an Opus stream is one this application could have produced.
 *
 * {@link readOggOpus} establishes that a file is internally consistent; this is
 * the separate question of whether it is *ours* — one channel, encoded from the
 * capture rate — which is the only thing `encodePcm16ToOggOpus` ever writes.
 * Same division of labour as `readWavFormat` and `checkWavFormat`.
 */
export function checkOggOpusFormat(format: OggOpusFormat, inputSampleRate: number): boolean {
  return format.channels === 1 && format.inputSampleRate === inputSampleRate;
}

/** The measured length of an Opus stream, or null if it cannot be measured. */
export function oggOpusDurationSeconds(bytes: ArrayBuffer): number | null {
  return readOggOpus(bytes)?.durationSeconds ?? null;
}
