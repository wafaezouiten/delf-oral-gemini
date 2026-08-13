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

**Verified offline** — `pnpm check` clean, `pnpm build` succeeds, 54/54 unit
tests pass. That includes the §17 acceptance scenario end to end (preparation →
monologue → débat → forced reconnect → finish), asserting the transcript stays
continuous, the débat clock does not reset, and the examiner's seeded memory
survives.

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

**Verified evaluation** — `pnpm verify:eval`, 8/8: a strong, a weak and an
*uneven* transcript graded through the real model. Scores land on legal bands,
the /25 is recomputed rather than trusted, a 20-point gap separates strong from
weak, and — the check that matters — the uneven fixture scores morphosyntaxe 3
while argumentation stays 5, proving criteria are judged independently rather
than by global impression. The audio path uploads and grades end to end.

Everything learned by actually connecting — including four Live API behaviours
that present as a healthy session behaving wrongly, and two dead model ids — is
written up in [`docs/GEMINI_LIVE_FINDINGS.md`](docs/GEMINI_LIVE_FINDINGS.md) and
[`docs/EVALUATION_FINDINGS.md`](docs/EVALUATION_FINDINGS.md).

**Still not verified:**

- The browser half: `getUserMedia`, the AudioWorklet and playback. The wire
  format is confirmed (the checks above run the same protocol from Node), but the
  microphone path needs a human with a microphone.
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

`feature/*` → `develop` → `staging` → `main`, one issue and one pull request per
phase. Every pull request shows the same six checks as the company's DELF
repository: `Build / Lint, typecheck, unit tests & build`, `Claude Code Review /
claude-review`, `Fallow / Codebase Intelligence`, `GitGuardian Security Checks`,
`Vercel` and `Vercel Preview Comments`. The process — branch model, the
phase-to-issue mapping, and the setup steps only a human can do — is written up in
[`docs/ENGINEERING_WORKFLOW.md`](docs/ENGINEERING_WORKFLOW.md).
