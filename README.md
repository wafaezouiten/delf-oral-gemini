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
pnpm test:unit   # 33 tests, including the full-exam acceptance test
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
FINISHED ────────────────── transcript + audio -> evaluation -> /25
```

Each phase owns its own clock, its own UI and its own Gemini configuration.
There is no single exam-wide timer, and no single generic conversation.

## Three decisions worth knowing

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

## Layout

```
src/lib/delf/         Pure exam logic: phases, transcript, rubric, examiner prompt, topics
src/lib/gemini/       Live configuration per phase; the /25 evaluator
src/lib/live/         Session lifecycle (resumption, GoAway) and the exam controller
src/lib/audio/        16 kHz PCM capture, 24 kHz playback, WAV encoding
src/app/              Routes: landing, Clerk, /app dashboard, exam, results
experiments/          The audio-vs-text evaluation experiment
```

`src/lib/live/exam-controller.ts` is framework-free on purpose: every dependency
is injected, so the whole exam — including a forced mid-débat reconnect — runs
headlessly in `exam-controller.test.ts` in milliseconds instead of twenty
minutes.

## Status

Verified by running it:

- `pnpm check` clean, `pnpm build` succeeds.
- 33/33 unit tests pass, including the §17 acceptance scenario end to end
  (preparation → monologue → débat → forced reconnect → finish) with assertions
  that the transcript stays continuous, the débat clock does not reset, and the
  examiner's seeded memory survives.

Not yet verified against the live service — these need `GEMINI_API_KEY` and a
microphone, and are marked as untested until then:

- The real microphone → Gemini → speaker loop.
- Whether the manual-VAD mechanism keeps the examiner silent in practice.
- Real `GoAway` handling at the true ~10 minute limit.
- The audio-vs-text evaluation result (`docs/AUDIO_EVALUATION.md` states the
  hypothesis; the number is not in yet).
