/**
 * Microphone capture worklet: Float32 frames -> 16-bit PCM.
 *
 * Gemini Live wants raw little-endian PCM16 at 16 kHz. The Web Audio API gives
 * us Float32 in [-1, 1], and MediaRecorder cannot produce raw PCM at all (it
 * only emits container formats like webm/opus), which is why this has to be an
 * AudioWorklet rather than something simpler.
 *
 * Resampling is deliberately NOT done here: the AudioContext is constructed with
 * `sampleRate: 16000`, so the browser's own resampler has already done the work
 * by the time frames reach this node. Hand-rolling a resampler in the audio
 * thread is a good way to add aliasing to a pronunciation exam.
 *
 * Frames arrive in 128-sample quanta, which is far too small to send as
 * individual WebSocket messages, so they are buffered to ~40 ms before posting.
 */

const TARGET_SAMPLES = 640; // 40 ms at 16 kHz

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Int16Array(TARGET_SAMPLES);
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
      // Clamp before scaling: a sample slightly outside [-1, 1] would wrap
      // around to the opposite polarity as an int16 and click audibly.
      const sample = Math.max(-1, Math.min(1, channel[i]));
      this._buffer[this._offset++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;

      if (this._offset === TARGET_SAMPLES) {
        // Transfer a copy: the underlying buffer is reused for the next chunk.
        const chunk = this._buffer.slice();
        this.port.postMessage(chunk.buffer, [chunk.buffer]);
        this._offset = 0;
      }
    }

    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
