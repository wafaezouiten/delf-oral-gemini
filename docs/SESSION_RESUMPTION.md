# Surviving a 13-minute débat on a 10-minute connection

## The problem

Gemini Live's documented limits:

| Limit                              | Value                     |
| ---------------------------------- | ------------------------- |
| Connection lifetime                | ~10 minutes               |
| Audio-only session, no compression | 15 minutes                |
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

Both phase configs set `sessionResumption: {}` — present, and **empty**. Without
the field the server sends no `sessionResumptionUpdate` messages at all and a
reconnect has nothing to resume from, which would silently restart the exam.
Adding the `transparent: true` the SDK types and the docs describe is worse than
useless: the Developer API rejects the connection outright with _"transparent
parameter is only supported in Gemini Enterprise Agent Platform mode"_. See
[`GEMINI_LIVE_FINDINGS.md` §1](GEMINI_LIVE_FINDINGS.md). Resumption works fine
without it.

Every update carries a handle; the manager keeps the newest one and passes it to
the next `connect()`. That is what makes the examiner still remember, after a
reconnect, the argument the candidate made four minutes earlier.

A connect that presents a handle is a **`resuming`**, not a `connecting`, and
the two are separate states precisely because only one of them preserves that
memory — see [`SESSION_STATE_MACHINE.md`](SESSION_STATE_MACHINE.md).

One subtlety: **a resumed session must not be re-seeded.** The débat's opening
session is seeded with the monologue transcript via `sendClientContent`, but the
resumption handle already carries that history. Re-seeding on reconnect would
duplicate the monologue in context, so `connect()` only seeds when
`resumptionHandle` is absent.

### 3. Context-window compression — outlast the 15-minute cap

`contextWindowCompression: { slidingWindow: {} }` lifts the audio-only session
cap. The oldest turns are dropped, which is acceptable here because the
evaluation reads _our_ transcript, not Gemini's context — the grade never depends
on what the model still remembers.

### 4. Backoff reconnect — the unannounced drop

An unexpected `onclose` triggers exponential backoff (400 ms doubling, capped at
5 s, 5 attempts) through the same resumption path. Audio captured while
disconnected is buffered, bounded at 50 chunks (~2 s), and flushed on reconnect;
beyond that the audio is genuinely unrecoverable and an unbounded buffer would
just leak.

The buffer is for **reconnects only**. Before a session's first connect it holds
nothing, and that is deliberate (#74): the socket is opened after the recording
starts, so the microphone delivers a second or two of the room before there is
anywhere to send it. Replaying that at connect handed the examiner a burst of
noise at the moment it began the débat's opening question — automatic VAD read it
as the candidate taking the floor, and the question was interrupted and dropped
unheard while the transcript printed it. Nothing worth keeping is lost: a phase's
first words are the examiner's, not the candidate's.

The flush happens **after** `connect()` resolves, not only inside `onopen`. The
SDK fires the open event _before_ the connect promise settles, so a flush from
`onopen` alone runs while the session's socket field is still null: every
buffered chunk is refused and pushed straight back onto the queue. That silently
discarded exactly the audio the buffer exists to save. Pinned by a unit test.

## Why the candidate does not notice

The three things that would make a reconnect _feel_ like a new exam all live
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

**`ExamLiveSession`'s injected transport and timers.** The token endpoint, the
socket and the clock all arrive through interfaces, so `session-manager.test.ts`
drives a real goAway, its deadline, five rounds of backoff and an exhaustion in
microseconds. Before those seams existed the only testable thing in the file was
the duration parser below — which left the most load-bearing code in the project
covered by hope.

**The headless acceptance test** (`exam-controller.test.ts`) runs the entire
20-minute exam against a fake session and a fake clock in about 50 ms, forcing a
reconnect mid-débat and asserting:

- the reconnect was recorded (`reconnectCount === 1`);
- the session was _resumed in place_, not replaced by a new exam;
- the transcript length is unchanged across the reconnect;
- the débat clock did not reset;
- speech after the reconnect appends to the same transcript;
- the exam still finishes with both phases distinctly present.

## What is not yet verified

The above is verified against fakes. The real service behaviour — an actual
`GoAway` at the true limit, and whether a resumed session's examiner genuinely
recalls a specific earlier argument — needs a live run with a `GEMINI_API_KEY`
and has not been done yet.
