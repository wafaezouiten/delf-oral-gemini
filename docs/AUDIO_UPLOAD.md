# Getting the recording to the corrector

Why the candidate's recording is Opus, and what was measured to decide it.

Issue [#24](https://github.com/wafaezouiten/delf-oral-gemini/issues/24).

## The problem

`POST /api/exams/:examId/finish` uploads the recordings and the transcript as
one multipart request. A serverless function accepts a **4.5 MB** body. The
recordings were 16 kHz mono PCM16 — 32 kB a second — so:

| Artefact | Length | As WAV |
| --- | --- | --- |
| monologue | ~7 min | 13.4 MB |
| débat | ~13 min | 25.0 MB |
| **request** | | **38.4 MB** |

Roughly **8x over the ceiling**, and it had been that way since the first
version, which posted the same bytes as one whole-sitting field. Nothing had ever
exercised the path across a function boundary: `pnpm verify:eval` and
`experiments/audio-vs-text.ts` both call `evaluateExam` directly from Node, and
the unit suite asserts the arithmetic against fakes. So audio grading — the
premise of the project, phonologie heard rather than counted off a transcript —
had never completed on a deployed URL and could not have.

The route's own 64 MB per-file guard sat far above a limit that bit first, which
is why it never fired.

## What was changed

The artefact is now **Opus in an Ogg stream**, encoded in the browser from the
same PCM the archive already holds.

- `src/lib/audio/ogg-opus.ts` — the container: a muxer, and a reader that
  measures a stream by summing its packets' own durations.
- `src/lib/audio/opus-encoder.ts` — WebCodecs `AudioEncoder`, 16 kbit/s constant,
  20 ms packets, mono, at the capture rate.
- `src/lib/exams/uploaded-recording.ts` — what the finish route will accept, and
  how large.

Three decisions worth keeping:

**Encoded from the archive, not from a second recorder.** `MediaRecorder` is the
obvious way to get Opus out of a browser, and it would have meant a second branch
off the audio graph with its own idea of where the phases start and stop. Phase 6
established that the boundaries are sample-exact and the duration is the sample
count; `AudioEncoder` takes the samples we already hold, so the artefact is the
archive compressed rather than a second recording of the same room.

**Discontinuous transmission is off.** Opus can stop emitting packets during
silence, which would roughly halve the file again — and would make the server's
measurement, which counts the audio the packets carry, report a candidate who
paused as one who stopped speaking. The duration penalty is computed from that
number, so silence has to cost bytes.

**Constant bitrate.** Variable would usually be smaller, because half the débat
is the candidate listening. But #24 is what happens when a size is assumed rather
than computed, and at 16 kbit/s constant the size of a sitting is arithmetic:
2 kB a second, 2.4 MB for twenty minutes, whatever the candidate says.

## What is still measured rather than believed

The duration that feeds the DELF penalty comes out of the artefact, as it did
when the artefact was a WAV. The reader sums each packet's length from its TOC
byte — the direct equivalent of `dataBytes / bytesPerSecond` — and then checks
the stream's last granule position against that sum, refusing a file whose two
accounts of its own length disagree. Page checksums are verified; a page that
fails ends the walk, so a truncated upload measures as the audio that arrived.

What compression does cost is the *plausibility* bound: 38 MB of WAV cannot claim
to be more than about twenty minutes, while 2 kB of Opus could claim an hour of
silence. That bound was never load-bearing — twenty minutes of zeroes was always
uploadable — and the property that matters survives intact: the duration is
measured from the same bytes the corrector listens to, so a recording that claims
to be long and is silent is graded as a long silence.

## Measured

Run in Chromium 148 (the in-app browser), against `speechLike` synthetic speech
at 16 kHz, through the shipped `PhaseArchive` → `opusRecordingEncoder` path.
Sizes are the artefact as it would be posted.

| Input | As WAV | As Opus | Bytes/s | Encode | Measured back |
| --- | --- | --- | --- | --- | --- |
| 30 s | 960 kB | 61.8 kB | 2 060 | 234 ms | 30.02 s |
| 60 s (through the archive) | 1.9 MB | 123 kB | 2 058 | — | 60.02 s |
| **1 200 s (a full sitting)** | **38.4 MB** | **2.47 MB** | **2 055** | **5.95 s** | **1 200.02 s** |

- `AudioEncoder.isConfigSupported` accepts mono at 16 kHz, and accepts
  `bitrateMode: "constant"`; the shipped path takes it. Variable came out 13 %
  smaller on this signal (54.0 kB against 61.8 kB for 30 s).
- Chrome's own decoder reads the hand-written container: `decodeAudioData`
  returned 1 200.02 s for the sitting, to the sample the same as the reader's
  measurement.
- The 0.02 s is the encoder padding the last partial frame to a whole 20 ms
  packet. The artefact is up to one packet longer than the samples that went in.

**A full sitting is 2.47 MB against a 4.5 MB ceiling**, which is the acceptance
criterion of #24 in arithmetic. `MAX_REQUEST_BYTES` is set to 4 MiB — under the
platform's limit, so an oversized request is refused by this route, with a
message, rather than by the platform without one.

## Verified against the real Gemini service

French speech synthesised through the TTS model (13.73 s, 16 kHz PCM16), encoded
by the shipped browser path, then uploaded exactly as `evaluateExam` uploads it:

```
server-side measurement: {"bytes":28355,"format":{"channels":1,"preSkip":0,
  "inputSampleRate":16000,"packets":687,"audioSamples":659520,
  "durationSeconds":13.74,"truncated":false},"isOurs":true}
files.upload: {"mimeType":"audio/ogg","sizeBytes":"28355","state":"ACTIVE",
  "seconds":1.93}
```

Asked to transcribe it, `gemini-3.6-flash` returned the sentence word for word —
« Je pense que le télétravail généralisé fragilise le lien social dans les
entreprises. Les jeunes recrues, en particulier, apprennent beaucoup en observant
leurs collègues. Il faudrait donc trouver un équilibre entre la souplesse et la
présence sur site. » — and put its length at 14 s against a measured 13.74 s.

So: the Files API takes `audio/ogg`, the model hears French through it at
16 kbit/s, and the same 439 kB of PCM travels as 28 kB.

## What this does not show

- **A real sitting on a deployed URL.** Everything here is measured, but the
  audio came from a synthesiser and a signal generator rather than a microphone,
  and the request was never made against a real function. The arithmetic says it
  fits; only a human with a microphone and a deployment can say it arrived.
- **What 16 kbit/s does to a phonologie mark.** The codec is transparent enough
  for the model to transcribe French from it, which is not the same claim as
  "the same recording scores the same at 16 kbit/s as uncompressed". Comparing
  the two is a question for `docs/AUDIO_EVALUATION.md`, whose results table is
  still waiting on real learner recordings.
- **Browsers without WebCodecs.** `AudioEncoder` has been in Chrome since 94,
  Safari since 16.4 and Firefox since 130. A browser without it archives a WAV
  instead, and a WAV of a real sitting is far past what one request may carry —
  `MAX_RECORDING_BYTES` is 98 seconds of PCM16, against a monologue that cannot
  end before 300. So on that browser the recording is not sent at all: the
  client weighs it, sends the transcript alone, and the results page reports the
  correction as `transcription seule`. The candidate is told this on the briefing
  screen, before the thirty minutes of preparation, because that is the only
  point at which switching browsers costs them nothing.

  The route still accepts WAV, and what that is actually for is narrow: a capture
  that failed early — a revoked permission, an unplugged headset, a suspended tab
  — leaves a short artefact that is worth grading and measures exactly the same
  way. It is not a working transport for a full sitting and is not meant to read
  as one.
