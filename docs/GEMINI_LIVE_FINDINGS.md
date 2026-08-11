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
liveConnectConstraints: { model: LIVE_MODEL }   // WRONG
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

| Client connect config | Result |
| --- | --- |
| `{}` (empty) | connects, **no audio ever** |
| `{ responseModalities: [AUDIO] }` | full audio + transcripts + handles |
| the full config | identical to the above |

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

| Phase | `inputTranscription` during speech | after the turn boundary |
| --- | --- | --- |
| Débat (auto VAD) | 1 fragment, arrives live | — |
| Monologue (manual VAD) | **0 fragments** | 1 fragment, complete and accurate |

`interimInputTranscription` is **never emitted** by this model in either mode, so
handling `inputTranscription` alone is correct and there is no duplication risk.

**This is the price of the monologue's silence guarantee.** With manual VAD and
no `activityEnd`, there is no turn boundary — and transcription is emitted at
turn boundaries. So nothing is transcribed for the whole monologue, and the
entire exposé arrives in one fragment when the floor is released.

Two consequences, both handled:

- The UI tells the candidate their exposé will appear at the end, rather than
  showing an empty panel for seven minutes and looking broken.
- `activityEnd` must be sent **exactly once**, and the closing handshake must
  WAIT afterwards. It is what causes the transcription to be emitted, so closing
  the socket promptly after it would silently discard the entire monologue. The
  controller guards this with `activityEnded`, and a unit test pins it.

---

## The three claims, as verified

`pnpm verify:live` — 6/6 passing:

**A. The security path.** A server-minted, config-constrained token opens a
session governed by an instruction the client never sent. The examiner opened
with: *"Vous avez soutenu que le télétravail permettait un meilleur équilibre
entre vie personnelle..."* — in role, in French, adversarial.

**B. The monologue mechanism, with a control.** The same 8 seconds of French
speech, through two configs:

| Config | Examiner audio | Verdict |
| --- | --- | --- |
| Débat (auto VAD) | **69 chunks** | replies, as it should |
| Monologue (manual VAD, no `activityEnd`) | **0 chunks** | structurally silent |

Then `activityEnd` was sent and the examiner spoke immediately (14 chunks). The
control is what makes this meaningful: silence from a model that simply never
heard the audio would prove nothing.

**C. Resumption carries memory.** Told a distinctive argument ("la brioche aux
myrtilles de ma grand-mère"), captured the handle, dropped the socket, reconnected
with the handle, and asked what the argument was. The resumed examiner:

> *"Vous avez mentionné que la brioche aux myrtilles de votre grand-mère était
> votre argument principal, or cela n'a rien à voir avec le sujet…"*

It recalled the argument across a reconnect **and stayed in character while doing
it.** That is the 13-minute débat requirement demonstrated end to end.

---

## Still not verified

- A real `GoAway` at the true ~10 minute limit. The reconnect path is proven by
  forced reconnection; the *trigger* has not been observed in the wild.
- The browser half: `getUserMedia`, the AudioWorklet, and playback. Everything
  above ran in Node against the same protocol, so the wire format is confirmed,
  but the microphone path needs a human with a microphone.
- The audio-vs-text evaluation result (`AUDIO_EVALUATION.md`), which needs real
  learner recordings.
