# What the Gemini Live API actually does

Everything here was found by connecting to the real service, not by reading. Each
item cost real debugging time, and several are invisible in code review — they
present as a session that connects perfectly and then behaves wrongly.

Reproduce with `pnpm verify:live` (6 checks) and the `scripts/probe-*.ts` bisects.

Model: `gemini-3.1-flash-live-preview`, `@google/genai` 2.16.0, Developer API.

---

## 1. `sessionResumption.transparent` is rejected outright

The SDK types it, the docs describe it, and the Developer API refuses it:

```
transparent parameter is only supported in Gemini Enterprise Agent Platform
mode, not in Gemini Developer API mode.
```

This one is merciful — it throws at `connect()`. Resumption works fine without
it. `sessionResumption: {}` is what you want.

## 2. Ephemeral tokens require `apiVersion: "v1alpha"`

```ts
new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: "v1alpha" } });
```

The SDK emits a runtime warning rather than typing this. Without it the token
path does not work.

## 3. `liveConnectConstraints` with only a `model` kills the session

This is the nastiest one. Mint a token constrained to just a model:

```ts
liveConnectConstraints: {
  model: LIVE_MODEL;
} // WRONG
```

…and the socket **opens**, then closes with `1011 "Internal error encountered."`
`live.connect()` never resolves, so the symptom is a hang with no diagnostic.

The constraint must carry the config as well:

```ts
liveConnectConstraints: { model: LIVE_MODEL, config: fullConfig }   // correct
```

### The useful consequence

Since the constraint carries the config anyway, the config can be built entirely
on the server — and the client can then connect with **modalities only**:

| Client connect config             | Result                             |
| --------------------------------- | ---------------------------------- |
| `{}` (empty)                      | connects, **no audio ever**        |
| `{ responseModalities: [AUDIO] }` | full audio + transcripts + handles |
| the full config                   | identical to the above             |

So `responseModalities` is the floor, not a stylistic choice. This is why
`/api/live-token` builds the whole session config and the browser never sees the
examiner's system instruction — not in the bundle, not over the wire.

## 4. `sendClientContent` does not make this model speak

On `gemini-3.1-flash-live`, `sendClientContent({turns, turnComplete: true})`
seeds history and produces **no reply**. The session looks healthy and sits in
silence forever.

To prompt a turn, use `sendRealtimeInput({ text })`. `sendClientContent` is still
the right call for seeding the débat session with the monologue, where silence is
exactly what you want.

## 5. Ceasing to send audio is not silence

Automatic VAD detects end-of-speech from **silent audio frames**, not from the
absence of packets. Stop sending and the server waits indefinitely; the examiner
never takes its turn.

A real microphone keeps delivering quiet frames after someone stops talking, so
this only bites synthetic tests — but it bit hard, and it initially looked like
"the model ignores our audio". Either keep streaming silence or send
`sendRealtimeInput({ audioStreamEnd: true })`.

## 6. Transcription timing differs per phase — verified

| Phase                  | `inputTranscription` during speech | after the turn boundary           |
| ---------------------- | ---------------------------------- | --------------------------------- |
| Débat (auto VAD)       | 1 fragment, arrives live           | —                                 |
| Monologue (manual VAD) | **0 fragments**                    | 1 fragment, complete and accurate |

`interimInputTranscription` is **never emitted** by this model in either mode, so
handling `inputTranscription` alone is correct and there is no duplication risk.

**This is the price of the monologue's silence guarantee.** With manual VAD and
no `activityEnd`, there is no turn boundary — and transcription is emitted at
turn boundaries. So nothing is transcribed for the whole monologue, and the
entire exposé arrives in one fragment when the floor is released.

Three consequences, all handled:

- The UI tells the candidate their exposé will appear at the end, rather than
  showing an empty panel for seven minutes and looking broken.
- `activityEnd` must be sent **exactly once**, and the closing handshake must
  WAIT afterwards. It is what causes the transcription to be emitted, so closing
  the socket promptly after it would silently discard the entire monologue. The
  controller guards this with `activityEnded`, and a unit test pins it.
- **`activityStart` binds to a socket, and the monologue outlives sockets.** The
  marker was sent once, after the first `connect()` resolved, by the controller.
  `ExamLiveSession` replaces sockets without telling anyone — that invisibility
  is its whole job — so every reconnect during a monologue left the new socket
  with no activity open: audio arriving outside an activity is not part of a
  turn, and nothing after the drop was ever transcribed. Nothing threw. The
  failure surfaced two screens away, as `partsAbsent` reading an empty monologue
  and the correction page telling a candidate who had spoken for seven minutes
  that they had not presented it. `candidateActivityOpen` now re-asserts the
  marker on every connect, before the buffered audio is flushed into it.

  What that still cannot recover is what was said on the socket that died: no
  `activityEnd` reached it, so its transcription was never emitted and no client
  can ask for it. That is why the finish payload carries measured voiced seconds
  per part — `partsSpokenButUntranscribed` pairs them with the transcript, and
  the route refuses to grade a part the microphone heard at length and the
  transcript does not contain, rather than scoring it as an absence.

## 7. A session can stop listening with the socket still open (#218)

The failure that has no error attached to it. A Live session keeps its WebSocket
open, keeps answering nothing, and stops emitting `inputTranscription` for audio
that is still being streamed to it. No `error`, no `close`, no `goAway` — every
recovery `session-manager.ts` owns is triggered by one of those three, so from
inside the app a dead session is indistinguishable from a candidate who has
stopped talking. It presents as the relance ladder asking « Vous m'entendez ? »
on a loop over somebody who is answering.

Eight-turn débats against the real service, shipped `debateConfig`, the same
9.5 s of French TTS spoken into each turn:

| Examiner                                        | Config         | Turns heard          | Examiner audio before it died |
| ----------------------------------------------- | -------------- | -------------------- | ----------------------------- |
| `gemini-3.1-flash-live-preview`                 | as shipped     | **8 / 8**            | — (still speaking at turn 8)  |
| `gemini-2.5-flash-native-audio-preview-12-2025` | as shipped     | 3, then intermittent | ~53 s                         |
| `gemini-2.5-flash-native-audio-preview-12-2025` | no compression | 6, then nothing      | ~92 s                         |

So `contextWindowCompression` is not the trigger — removing it only postpones
the death — and the default examiner does not do this at all.

**A reconnect revives it.** Probed directly: a session that had gone deaf at
2:23 was closed, reopened with its resumption handle, and both spoke (11 s) and
heard the candidate again. That is what makes this recoverable rather than
merely reportable, and it is what `ExamController.checkSessionDeafness` does —
voiced seconds measured by the recorder in the tab, with no transcription coming
back, is the only evidence available that the socket has stopped listening.

## 8. Generation runs ~3× faster than speech, and `turnComplete` does not always wait

Measured on one opening question per model:

| Examiner                                        | Audio  | Delivered over | `turnComplete` | Playback would end |
| ----------------------------------------------- | ------ | -------------- | -------------- | ------------------ |
| `gemini-3.1-flash-live-preview`                 | 14.8 s | 4.4 s (3.3×)   | 17.3 s         | 16.5 s             |
| `gemini-2.5-flash-native-audio-preview-12-2025` | 17.0 s | 5.8 s (2.9×)   | 12.2 s         | 22.8 s             |

Two consequences the app has to hold:

- The player's queue GROWS monotonically for `audio ÷ 3` seconds at the start of
  every turn. Anything that reads "the queue is not shrinking" as a dead speaker
  is wrong on every turn longer than ~18 seconds of speech — which is what
  `PLAYBACK_STALL_MS` did until #218. `AudioContext.currentTime` is the honest
  signal: it moves during the burst and stands still in the fault.
- The default examiner paces `turnComplete` to roughly the natural end of the
  speech; the native-audio one sends it as soon as the bytes are out, ten
  seconds before the candidate has heard the question. Anything armed on
  `turnComplete` — the silence window above all — has to be held by the speaker,
  not by the turn.

## 9. `NO_INTERRUPTION` drops the candidate's speech during a turn — it does not queue it (#220)

`debateConfig` ships `activityHandling: NO_INTERRUPTION` (#158) so the
examiner's own echo cannot cut its question short. The assumption written next
to it was that speech during an examiner turn was still captured and
transcribed, merely unable to interrupt. Probed (`scripts/probe-overlap.ts`):
the examiner is asked its opening question, and 2 s after its first chunk the
candidate (French TTS) starts speaking.

| Utterance                                | Streamed live, as the app did       | Held, released at `turnComplete`        |
| ---------------------------------------- | ----------------------------------- | --------------------------------------- |
| 4.3 s, entirely inside the turn          | **no transcription, no reply**      | transcribed whole; the examiner replied |
| 18.2 s, starting inside and running past | transcribed from the turn's edge on | transcribed whole, from the first word  |

Timelines from the same run, default examiner `gemini-3.1-flash-live-preview`:

```
live  short: turn-open@1.6 | candidate-starts@3.7 | candidate-ends@8.8 | turnComplete#1@14.6
live  long : turn-open@1.6 | candidate-starts@3.6 | turnComplete#1@13.5 | candidate-ends@24.8
hold  short: turn-open@1.6 | candidate-starts@3.6 | candidate-ends@8.7 | turnComplete#1@13.7 | flush(217 chunks) | turnComplete#2@25.1
hold  long : turn-open@1.5 | candidate-starts@3.6 | turnComplete#1@17.1 | flush(292 chunks) | candidate-ends@24.8 | turnComplete#2@44.3
```

What the live rows show is the drop: nothing said before `turnComplete` reaches
the transcript, and there is no later message that delivers it. What the hold
rows show is that a burst of up to ~12 s of audio delivered at `turnComplete`
is ingested, transcribed and answered like real-time speech.

Consequences held by the app:

- `ExamLiveSession` holds the débat's microphone from the first sign of an
  examiner turn (its transcription or its audio, whichever lands first) to
  `turnComplete`, and releases the hold as one burst — only if some chunk in
  it crossed the recorder's speech threshold, so the quiet common case (the
  candidate listening, plus echo residue) is dropped rather than served back.
- The hold is bounded (30 s) for a turn that never completes — the deaf
  session of §7 — and it dies with its socket: a turn in flight on a dropped
  socket releases on the reconnect, ahead of the outage buffer.
- Still lost: the ~0.5 s between the server deciding the candidate's turn was
  over and the first chunk reaching the client. Nothing on the client can see
  that decision.
- `gemini-2.5-flash-native-audio-preview-12-2025` queues overlapped speech
  rather than dropping it — same probe, both utterances transcribed whole when
  streamed live — and the hold is harmless there: transcribed whole again with
  it on, a burst at `turnComplete` being what that model delivers anyway.

---

## The three claims, as verified

`pnpm verify:live` — 6/6 passing:

**A. The security path.** A server-minted, config-constrained token opens a
session governed by an instruction the client never sent. The examiner opened
with: _"Vous avez soutenu que le télétravail permettait un meilleur équilibre
entre vie personnelle..."_ — in role, in French, adversarial.

**B. The monologue mechanism, with a control.** The same 8 seconds of French
speech, through two configs:

| Config                                   | Examiner audio | Verdict               |
| ---------------------------------------- | -------------- | --------------------- |
| Débat (auto VAD)                         | **69 chunks**  | replies, as it should |
| Monologue (manual VAD, no `activityEnd`) | **0 chunks**   | structurally silent   |

Then `activityEnd` was sent and the examiner spoke immediately (14 chunks). The
control is what makes this meaningful: silence from a model that simply never
heard the audio would prove nothing.

**C. Resumption carries memory.** Told a distinctive argument ("la brioche aux
myrtilles de ma grand-mère"), captured the handle, dropped the socket, reconnected
with the handle, and asked what the argument was. The resumed examiner:

> _"Vous avez mentionné que la brioche aux myrtilles de votre grand-mère était
> votre argument principal, or cela n'a rien à voir avec le sujet…"_

It recalled the argument across a reconnect **and stayed in character while doing
it.** That is the 13-minute débat requirement demonstrated end to end.

---

## Still not verified

- A real `GoAway` at the true ~10 minute limit. The reconnect path is proven by
  forced reconnection; the _trigger_ has not been observed in the wild.
- The browser half: `getUserMedia`, the AudioWorklet, and playback. Everything
  above ran in Node against the same protocol, so the wire format is confirmed,
  but the microphone path needs a human with a microphone.
- The audio-vs-text evaluation result (`AUDIO_EVALUATION.md`), which needs real
  learner recordings.
