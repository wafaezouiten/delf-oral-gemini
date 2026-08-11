# Surviving a 13-minute débat on a 10-minute connection

## The problem

Gemini Live's documented limits:

| Limit | Value |
| --- | --- |
| Connection lifetime | ~10 minutes |
| Audio-only session, no compression | 15 minutes |
| Session resumption handle validity | 2 hours after termination |

The DELF B2 exam this product runs is a 5-7 minute monologue plus a ~13 minute
débat. **Both individually and together, the exam outlasts the connection.** So
losing the socket mid-performance is not an edge case to handle defensively; it
is the normal course of a successful exam, and the design has to treat it that
way.

## The mechanisms, in order of preference

### 1. `GoAway` — reconnect on our terms

The server warns before it hangs up, sending `goAway.timeLeft`. `ExamLiveSession`
schedules a reconnect for `timeLeft - 1500ms`, so the new socket opens while the
old one is still healthy rather than after the candidate's speech has already
started falling on the floor.

`timeLeft` has been observed as a protobuf duration string (`"9.5s"`), a number,
and a `{seconds, nanos}` object, so `parseDurationMs` accepts all three and
returns `null` for anything else — the caller then reconnects immediately, which
is the safe reading of "the server is about to hang up". This is unit-tested.

### 2. Session resumption — keep the examiner's memory

Both phase configs set `sessionResumption: { transparent: true }`. Without that
field the server sends no `sessionResumptionUpdate` messages at all and a
reconnect has nothing to resume from, which would silently restart the exam.

Every update carries a handle; the manager keeps the newest one and passes it to
the next `connect()`. That is what makes the examiner still remember, after a
reconnect, the argument the candidate made four minutes earlier.

One subtlety: **a resumed session must not be re-seeded.** The débat's opening
session is seeded with the monologue transcript via `sendClientContent`, but the
resumption handle already carries that history. Re-seeding on reconnect would
duplicate the monologue in context, so `connect()` only seeds when
`resumptionHandle` is absent.

### 3. Context-window compression — outlast the 15-minute cap

`contextWindowCompression: { slidingWindow: {} }` lifts the audio-only session
cap. The oldest turns are dropped, which is acceptable here because the
evaluation reads *our* transcript, not Gemini's context — the grade never depends
on what the model still remembers.

### 4. Backoff reconnect — the unannounced drop

An unexpected `onclose` triggers exponential backoff (400 ms doubling, capped at
5 s, 5 attempts) through the same resumption path. Audio captured while
disconnected is buffered, bounded at 50 chunks (~2 s), and flushed on reconnect;
beyond that the audio is genuinely unrecoverable and an unbounded buffer would
just leak.

## Why the candidate does not notice

The three things that would make a reconnect *feel* like a new exam all live
above the session and are never touched by it:

```
exam     ───────────────────────────────────────  transcript, audio archive
phase    ──────────────┤├─────────────────────────  clocks
session  ────┤├────┤├──┤├────┤├────┤├─────────────  Gemini connection
```

- The **transcript** is owned by `ExamController` and only ever appended to.
- The **phase clock** is derived from a phase start stamp, not from the session.
- The **phase** itself only moves forward, so no connection event can rewind it.

The UI reinforces this: a reconnect renders as "Reconnexion, l'épreuve continue"
in amber, not as an error in red. Presenting a routine, expected event as a
failure would make candidates abandon a perfectly healthy exam.

## Testing it without waiting ten minutes

A resumption path only exercised in production is a resumption path that does not
work. Two seams make it testable:

**`controller.forceReconnect()`** closes the socket and immediately reopens it
with the stored handle — the same code a real `GoAway` drives. It is wired to a
development-only button on the exam screen.

**The headless acceptance test** (`exam-controller.test.ts`) runs the entire
20-minute exam against a fake session and a fake clock in about 50 ms, forcing a
reconnect mid-débat and asserting:

- the reconnect was recorded (`reconnectCount === 1`);
- the session was *resumed in place*, not replaced by a new exam;
- the transcript length is unchanged across the reconnect;
- the débat clock did not reset;
- speech after the reconnect appends to the same transcript;
- the exam still finishes with both phases distinctly present.

## What is not yet verified

The above is verified against fakes. The real service behaviour — an actual
`GoAway` at the true limit, and whether a resumed session's examiner genuinely
recalls a specific earlier argument — needs a live run with a `GEMINI_API_KEY`
and has not been done yet.
