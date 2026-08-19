/**
 * Microphone capture worklet: batch the audio thread's 128-sample quanta and
 * hand them to the main thread.
 *
 * That is deliberately ALL it does. Conversion to PCM16, framing to the Live
 * API's 40 ms, and rate conversion all used to live here, where nothing could
 * import them and therefore nothing could test them — and the two properties
 * that matter about them (no sample lost at a block boundary, no fractional
 * resampling phase reset per block) are precisely the sort that look fine and
 * drift over twenty minutes. They now live in `src/lib/audio/framing.ts` with
 * assertions on them, and at 16 kHz the arithmetic is free wherever it runs.
 *
 * This still has to be an AudioWorklet rather than something simpler:
 * MediaRecorder cannot produce raw PCM at all — it only emits container formats
 * like webm/opus — and 128-sample quanta are far too small to send as individual
 * WebSocket messages.
 *
 * Resampling is deliberately NOT done here either. The AudioContext is
 * constructed at 16 kHz, so the browser's own resampler has usually already done
 * the work by the time frames reach this node; when it refuses, the fallback is
 * on the main thread where it can be tested.
 */

/** ~40 ms at 16 kHz. The real size arrives from the main thread, computed from
 *  the rate the context actually got. */
const DEFAULT_FRAME_SAMPLES = 640;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const requested = options && options.processorOptions && options.processorOptions.frameSamples;
    this._size =
      Number.isInteger(requested) && requested > 0 ? requested : DEFAULT_FRAME_SAMPLES;
    this._buffer = new Float32Array(this._size);
    this._offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    // No input connected (mic still opening, or track ended): keep the node
    // alive rather than tearing the graph down.
    if (!input || input.length === 0) return true;

    const channel = input[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this._buffer[this._offset++] = channel[i];

      if (this._offset === this._size) {
        // Transfer a copy: the underlying buffer is reused for the next block.
        const block = this._buffer.slice();
        this.port.postMessage(block.buffer, [block.buffer]);
        this._offset = 0;
      }
    }

    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
