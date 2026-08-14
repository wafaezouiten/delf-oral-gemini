# The exam's state machines

There are two, at different lifetimes, and keeping them apart is what makes a
mid-débat reconnect invisible to the candidate.

```
exam      ────────────────────────────────────────────  transcript, audio archive
phase     ──────────────┤├──────────────────────────────  clocks
session   ────┤├────┤├──┤├────┤├────┤├───────────────────  Gemini connection
```

A session dying and being resumed moves the **lower** machine through four
states and the **upper** one through none. That is the design, not a detail:
the transcript, the phase and the phase clock all outlive every socket.

| | Owner | Source |
| --- | --- | --- |
| Exam phase | DELF business logic | [`src/lib/delf/phases.ts`](../src/lib/delf/phases.ts) |
| Session state | transport | [`src/lib/live/state-machine.ts`](../src/lib/live/state-machine.ts) |
| The two, flattened | derived | `examStatus()` in the same file |

---

## 1. The exam phase

One way, never backwards, so no connection event can rewind a candidate into an
earlier phase.

```
preparation ──▶ monologue ──▶ debate ──▶ finished
   30 min         7 min        13 min     (terminal)
```

Durations are **derived** from the ported B2 part specs (`ORAL_PARTS_B2` in
`src/lib/delf/constants.ts`), not restated, so the phase clock and the rubric's
duration penalty cannot disagree about how long a monologue is.

**The application owns every transition.** A phase ends when its clock runs out
or when the candidate ends it early — never because Gemini decided the
conversation was over. The one thing the model influences is the closing
handshake: once the app has decided the phase is ending and sent the closing
directive, the examiner's `turnComplete` is what releases the phase, so the
audio is not cut dead mid-sentence. A 12-second safety timeout bounds even that,
because a silent examiner must not be able to freeze the exam. Outside that
window `turnComplete` is ignored entirely — pinned by a unit test.

---

## 2. The session

```
                    ┌──────────────────────────────────┐
                    ▼                                  │
  idle ──▶ connecting ──▶ connected ──▶ reconnecting ──┤
    │           │              │             │         │
    │           │              │             ▼         │
    └──────▶ resuming ◀────────┴─────────────┘         │
                │                                      │
                └──────────────▶ connected ────────────┘

  any of the above ──▶ failed ──▶ reconnecting
  any of the above ──▶ closed  (terminal)
```

| State | Meaning |
| --- | --- |
| `idle` | Constructed, no socket ever opened. |
| `connecting` | Opening the first socket of a phase. No handle: nothing to remember yet. |
| `resuming` | Opening a socket **with** a resumption handle. The exam continues. |
| `connected` | Live. The only state in which audio actually reaches Gemini. |
| `reconnecting` | The socket is gone (goAway, drop, or a forced reconnect) and we are going back. |
| `closed` | Ended deliberately. **Terminal.** |
| `failed` | Backoff exhausted. Recoverable only by an explicit forced reconnect. |

### Why `resuming` is not just `reconnecting`

They are different facts, and the difference is the one that matters:
`reconnecting` says the socket is gone, `resuming` says the new one is being
opened **carrying a handle**, so the examiner will still remember the argument
the candidate made four minutes ago. A reconnect without a handle would restart
the exam, and before these were two states that was indistinguishable from one
that would not.

### Two invariants the transition table enforces

- **`connected` is only ever reached from `connecting` or `resuming`.** Nothing
  can claim the exam is live without a socket having just been opened.
- **`closed` is terminal.** A monologue session that could revive would talk
  over the débat. This is why a forced reconnect goes `connected → reconnecting`
  and never through `closed`: `reconnect()` marks its own teardown so the
  resulting `onclose` stays silent.

`failed` is deliberately *not* terminal — the candidate can still press "forcer
une reconnexion", and an exam that cannot be retried is worse than one that can.

### Enforcement

`setState` checks every move against `SESSION_TRANSITIONS`. An illegal one is
**reported and applied**, not thrown: an unexpected transition is a bug in
`session-manager.ts`, and freezing a live exam over it would turn a cosmetic
fault into a lost épreuve. It lands in the session log as `invalid-transition`,
and `session-manager.test.ts` asserts a full connect → goAway → resume → drop →
close cycle produces none — so the check has teeth in CI without having teeth on
a candidate.

---

## 3. The flattened status

`examStatus(phase, session)` derives the single seven-value status the UI talks
in. Derived on every snapshot rather than stored, so it cannot drift from the
phase clock it summarises.

```
preparation · monologue · debate · reconnecting · resuming · finished · error
```

Precedence, in order:

1. **`finished` wins over everything.** The exam is over; whatever the socket is
   doing on its way down is not a state to show.
2. **`preparation` ignores the session entirely.** No socket is open during
   preparation by design, so no connection state is a fact about it. A candidate
   writing their notes must never be shown an error for a connection that does
   not exist.
3. **`error`** — a `failed` session mid-débat is not a débat.
4. **`reconnecting` / `resuming`** win over the speaking phase. The phase is
   still `debate` underneath and the clock never stopped; what the candidate is
   *told* is that the exam continues.
5. Otherwise the phase itself.

A closed socket alone is **not** an error: phases close their sessions on the
way out, every time, as part of a healthy exam.

---

## What drives each transition

| Trigger | Path |
| --- | --- |
| Phase starts | `idle → connecting → connected` |
| `goAway` received | timer at `timeLeft − 1500 ms`, then `connected → reconnecting → resuming → connected` |
| Socket drops unannounced | `connected → reconnecting → resuming → connected`, backoff 400 ms doubling to 5 s, 5 attempts |
| Backoff exhausted | `reconnecting → failed` |
| Candidate forces a reconnect | `connected → reconnecting → resuming → connected` |
| Phase ends | `* → closed` |

Every connect mints a **fresh** token, including reconnects: a token is
single-use, and a resumed session is a new session. The token request carries
the exam id, the phase, the subject and the handle; the server checks ownership,
reads the subject off the sitting, and pins the whole session config into the
token. See [`SESSION_RESUMPTION.md`](SESSION_RESUMPTION.md) for the resumption
mechanics and [`GEMINI_LIVE_FINDINGS.md`](GEMINI_LIVE_FINDINGS.md) for what the
real service does.
