# DELF B2 · Production orale (Gemini)

A standalone simulator for the DELF B2 speaking exam, built on the Gemini Live
API. The candidate prepares a subject, delivers a monologue suivi that nobody
interrupts, defends it in a débat against an adversarial examiner, and receives a
mark out of 25 against the official France Éducation international grille.

This is a **new product**, not a migration. An existing DELF application with an
ElevenLabs oral simulator was read as a reference for the exam requirements, the
grille and the timings; none of its code, schema or infrastructure is used or
modified here.

## Running it

```bash
pnpm install
cp .env.example .env.local   # then fill in the keys
pnpm dev
```

Required to run an exam:

| Variable | What it does |
| --- | --- |
| `GEMINI_API_KEY` | Server-side only. The browser receives short-lived ephemeral tokens minted from it, never the key. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | Auth. Without them the app builds and the pure logic tests pass, but no route under `/app` opens. |
| `DATABASE_URL` | Optional. Without it the exam runs and is graded; only persistence is skipped. |

```bash
pnpm check       # typecheck + lint
pnpm test:unit   # 337 tests, including the full-exam acceptance test
pnpm build
```

## The exam

```
PREPARATION ─── 30 min ─── notes, no examiner, no Gemini connection
     │
MONOLOGUE ───── 5-7 min ── candidate speaks; examiner structurally cannot interrupt
     │
DEBAT ───────── ~13 min ── adversarial examiner; survives reconnects
     │
FINISHED ────────────────── transcript + two recordings -> evaluation -> /25
```

Each phase owns its own clock, its own UI and its own Gemini configuration.
There is no single exam-wide timer, and no single generic conversation.

## Decisions worth knowing

**The monologue's silence is a protocol guarantee, not a prompt.** Asking a
conversational model to stay quiet does not work; it will still say "d'accord"
when the candidate pauses for breath. Instead the monologue runs with
`automaticActivityDetection.disabled: true`, and the controller sends
`activityStart` once and withholds `activityEnd` for the entire phase. With no
turn boundary, the model has no point at which it *can* speak. Transcription
keeps streaming throughout. See `src/lib/gemini/live-config.ts`.

**The débat is a second session, seeded with the first.** Gemini cannot change a
system instruction mid-session, so the listening examiner and the arguing
examiner cannot be the same connection. The monologue transcript is handed to the
débat session as conversation history, which is what lets the examiner open by
quoting an argument the candidate actually made. See `monologueAsHistory`.

**Reconnection is the expected path, not the error path.** A Gemini Live
connection lives about ten minutes; the débat targets thirteen. The exam
therefore *will* lose its socket mid-performance. `ExamLiveSession` keeps the
newest `sessionResumption` handle, reconnects early on `GoAway` rather than
waiting to be cut off, and falls back to backoff reconnection on an unexpected
close. The transcript, the phase and the phase clock all live above the session,
so none of them is touched. See `docs/SESSION_RESUMPTION.md`.

**The two state machines are declared, not implied.** The exam phase (DELF
business logic) and the session (transport) are separate machines at separate
lifetimes, and a resume moves the lower one through four states and the upper one
through none. `resuming` is deliberately distinct from `reconnecting`: only one
of them carries a handle, and therefore only one of them keeps the examiner's
memory of the exam. See `docs/SESSION_STATE_MACHINE.md`.

**The recording's duration is measured, never assumed.** Each speaking phase
produces its own file, and its length comes from counting the samples in it —
then, on the server, from re-reading the uploaded artefact itself. The phase
clock is stored beside it but is not the same number: a suspended audio graph
behind a backgrounded tab, a headset unplugged four minutes in, a permission
revoked mid-sentence all leave a phase that *ran* seven minutes and *recorded*
ninety seconds. The DELF duration penalty is computed from the recording,
because the recording is the only evidence the performance happened. The
divergence is what the candidate is warned about, on screen, while there is
still time to fix it.

**Tokens are scoped to a sitting.** `/api/live-token` takes the exam id, answers
"is this sitting theirs?" through the same `lib/auth` module every other exam
route uses, and reads the subject off the row rather than trusting the browser —
so a token opens one phase, of one subject, of one sitting, for its owner, once.

## Layout

```
src/lib/delf/         Pure exam logic: phases, transcript, the grille and the /25 rubric, examiner prompt, topics
src/lib/gemini/       Live configuration per phase; the /25 evaluator
src/lib/live/         Session lifecycle (resumption, GoAway), state machine, exam controller
src/lib/audio/        16 kHz PCM capture, 24 kHz playback, WAV and Opus encoding, the per-phase recording
src/app/              Routes: landing, Clerk, /app dashboard, exam, results
experiments/          The audio-vs-text evaluation experiment
```

`src/lib/live/exam-controller.ts` is framework-free on purpose: every dependency
is injected, so the whole exam — including a forced mid-débat reconnect — runs
headlessly in `exam-controller.test.ts` in milliseconds instead of twenty
minutes.

## Status

**Verified offline** — `pnpm check` clean, `pnpm build` succeeds, 337/337 unit
tests pass. That includes the acceptance scenario end to end (preparation →
monologue → débat → forced reconnect → finish), asserting the transcript stays
continuous, the débat clock does not reset, and the examiner's seeded memory
survives — plus the session lifecycle driven directly against a fake transport:
a `goAway` and its deadline, a resume carrying the handle, an unannounced drop,
backoff to exhaustion, and the buffered audio flushed on the way back.

The audio transport is covered the same way, against a fake AudioContext and a
fake microphone: twenty minutes of capture archived without the clock drifting,
thirty thousand playback chunks scheduled exactly end to end, and every path
that can abandon a device — two callers opening at once, one that resolves after
the sitting ended, a teardown racing the permission prompt — asserted to release
it.

The recording is covered against the same fakes: the monologue and the débat cut
apart with the boundary's partial frame landing in the phase it was spoken in,
the duration read back out of the artefact itself, and the failures that make a
recording shorter than its phase — a track that ends mid-débat, a capture that
quietly stops delivering, a phase entered before the microphone was asked for —
each asserted to keep what was recorded and to say so. The Ogg Opus container the
artefact travels in is covered on its own terms: every frame size the codec
defines, a stream measured back to the audio that went in, a truncated one
measured to what arrived, and a stream stamped with a length its packets do not
add up to, refused.

**Verified in a real browser** — the recording is encoded by WebCodecs and a
20-minute sitting comes out at **2.47 MB**, against 38.4 MB as WAV and a 4.5 MB
platform limit. Chrome's own decoder reads the hand-written container back to
1 200.02 s, the same figure the server's reader measures out of the packets. The
numbers and the method are in [`docs/AUDIO_UPLOAD.md`](docs/AUDIO_UPLOAD.md).

**Verified against the real Gemini service** — `pnpm verify:live`, 6/6:

- A server-minted, config-constrained ephemeral token opens a session governed by
  an examiner instruction the client never sends.
- **The monologue mechanism, with a control.** The same French speech through the
  débat config produces 69 chunks of reply; through the monologue config it
  produces **0**. Then `activityEnd` releases the floor and the examiner speaks
  immediately. Silence is a protocol guarantee, not a hope.
- **Resumption carries memory.** After dropping the socket and reconnecting with
  the handle, the examiner recalled a specific argument made before the
  reconnect, in character.

**Verified upload** — French speech synthesised, encoded through the shipped
browser path and uploaded exactly as the evaluator uploads it: the Files API
accepts `audio/ogg`, and the corrector model transcribed the sentence back word
for word from 28 kB of Opus. 439 kB of PCM travelled as 28 kB.

**Verified evaluation** — `pnpm verify:eval`, 11/11: a strong, a weak and an
*uneven* transcript graded through the real model. Scores land on legal bands,
the /25 is recomputed rather than trusted, a 20-point gap separates strong from
weak, and — the check that matters — the uneven fixture scores morphosyntaxe 3
while argumentation stays 5, proving criteria are judged independently rather
than by global impression. The audio path uploads and grades end to end, and the
duration rule is observed doing its work: the same strong transcript over a
40-second débat comes back docked 3, with the short half named.

**One rubric, and it is the ported one.** Two implementations of the grading
rules used to disagree in ways that changed grades — snapping versus clamping a
model's 2, a tiered 5/3 penalty versus a flat 3, an 8-minute sitting total versus
each part against its own floor. `rubric.ts` is deleted; the grille, the bands,
the floors and the arithmetic all come from `src/lib/delf/`, and the evaluator
calls one function. The corrector's prompt states the band scale and no
arithmetic, because a prompt that restated the rubric would be a second copy of
it written in French. See [`docs/EVALUATION_FINDINGS.md`](docs/EVALUATION_FINDINGS.md).

Everything learned by actually connecting — including four Live API behaviours
that present as a healthy session behaving wrongly, and two dead model ids — is
written up in [`docs/GEMINI_LIVE_FINDINGS.md`](docs/GEMINI_LIVE_FINDINGS.md) and
[`docs/EVALUATION_FINDINGS.md`](docs/EVALUATION_FINDINGS.md).

**Still not verified:**

- The browser half: `getUserMedia`, the AudioWorklet, playback, and the
  recording that comes off them. The wire format is confirmed (the checks above
  run the same protocol from Node) and the recording's arithmetic is unit-tested
  against a fake device, but whether a real headset unplugged mid-débat fires
  `ended` on every engine — and whether a real backgrounded tab suspends its
  capture — needs a human with a microphone.
- A full sitting finishing on a deployed URL. Until #24 this could not have
  succeeded — the upload was eight times the platform's body limit, so audio
  grading has never completed against a real function. It now fits, measured
  rather than assumed, but the request itself has only been made against
  `next dev`.
- A real `GoAway` at the true ~10 minute limit. The reconnect path is proven by
  forced reconnection; the trigger has not been observed in the wild.
- The audio-vs-text evaluation result. `docs/AUDIO_EVALUATION.md` states the
  hypothesis and its control; the harness (`pnpm exp:audio`) is written and the
  results table is deliberately empty until real learner recordings exist.
- **Corrector calibration against human examiners.** The corrector is internally
  consistent and discriminating, but it is generous: 23/25 for a transcript with
  agreement errors in every turn. Nothing here shows that a 23 from this model
  means what a 23 from France Éducation international means, so results should be
  shown to learners as indicative feedback, not a predicted exam mark. See
  `docs/EVALUATION_FINDINGS.md`.

## Working on it

`<type>/*` → `staging` → `main`, one issue and one pull request each. An issue
branch is cut from `staging` and merges back into it; `develop` is a sandbox off
to one side, not a stop on the way. Every pull request shows the same six checks
as the company's DELF repository: `Build / Lint, typecheck, unit tests & build`,
`Claude Code Review / claude-review`, `Fallow / Codebase Intelligence`,
`GitGuardian Security Checks`, `Vercel` and `Vercel Preview Comments`. The
process — branch model, the phase-to-issue mapping, and the setup steps only a
human can do — is written up in
[`docs/ENGINEERING_WORKFLOW.md`](docs/ENGINEERING_WORKFLOW.md).
