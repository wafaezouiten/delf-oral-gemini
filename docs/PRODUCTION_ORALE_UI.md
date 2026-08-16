# Reproducing the Production Orale UI/UX

The reference implementation is `delf-preps` @ `chore/240-remove-unused-series-actions`
(`C:\Users\lenovo\Desktop\delf-audit`). This document is the analysis that came
before the code: what the reference is made of, what the user flow is, and — for
every screen — what was reproduced verbatim, what had to be adapted, and why.

The rule the whole exercise runs on: **reproduce the layout, the navigation and
the interaction patterns; do not redesign them, and do not invent data to fill a
component that the reference fed from a table this project does not have.**

---

## 1. What the reference is made of

### Routes

| Route | Shell | What it is |
| --- | --- | --- |
| `/production-orale` | app chrome | The hub: masthead, format of the épreuve, sujets à la une, capability strip |
| `/production-orale/sujets-actualites` | app chrome | The sujets kiosk: masthead, search, facet chips, cards, detail sheet, launch dialog |
| `/production-orale/sujets-actualites/[month]` | app chrome | The same kiosk, scoped to a month |
| `/production-orale/tableau-de-bord` | app chrome | Stat tiles, per-part averages, recent submissions |
| `/production-orale/simulateur` | **fullscreen** | The épreuve itself: four phases in one client component |

### Components

The simulateur is one orchestrator (`simulateur-client.tsx`) that renders one of
four screens, plus a shared chrome. The chrome and the two static screens live in
`components/po/*`; the live conversation and the /25 report keep their own files.

| Component | Job |
| --- | --- |
| `PoSimulatorTopBar` | Retour · identity kicker · `Sujet / Préparation / Passage` stepper · per-phase right slot |
| `PoTimerRing` | Draining SVG ring + `m:ss`, destructive-red inside the urgency window |
| `PoBriefingScreen` | Left "séance" rail (déroulé + pre-flight checks) / right document déclencheur |
| `PoPreparationScreen` | Left sujet / right rail (passation card, notes, structure attendue) |
| `PoConversationScene` | The two faces, the beat stepper, the elapsed/total clock and its bar |
| `PoSceneStepper` | The beats *inside* the passation (`Exposé → Débat`) — not the top-level stepper |
| `PoConversationControls` | Foot bar: notes toggle · big mic · Terminer l'épreuve |
| `PoNotesDrawer` | Read-only slide-over of the préparation notes |
| `PoAudioBars` | Five breathing bars — a "mic is live" glyph, not a level meter |
| `ConversationSimulateur` | Transport + timing brain; owns no layout |
| `EvaluationResultats` / `OralResultReport` | Loading → error → the two-column /25 report |
| `EpreuveHub` + `hub-*` | The hub, drawn entirely from a pure view model |
| `SujetsCatalogue` + `sujet-*` | The shared sujets kiosk |

### Pure view models

Everything the screens *print* is derived in React-free modules so it can be unit
tested: `lib/quiz/po-player-view.ts` (déroulé, structure attendue, mic copy,
beats), `lib/quiz/exam-view.ts` (`formatExamTime`, `remainingFraction`),
`lib/epreuve-hub.ts` (the hub's every string). This project already follows the
same rule, so the reproduction keeps it.

---

## 2. The complete user flow

```
                    ┌─────────────────────────────────────────────┐
                    │ HUB  /production-orale                       │
                    │ masthead · format · sujets à la une · strip  │
                    └───┬──────────────┬───────────────┬───────────┘
                        │              │               │
             ┌──────────▼───┐   ┌──────▼──────┐  ┌─────▼─────────┐
             │ SUJETS       │   │ TABLEAU DE  │  │ SIMULATEUR    │
             │ kiosk        │   │ BORD        │  │ (fullscreen)  │
             └──────┬───────┘   └─────────────┘  └─────┬─────────┘
                    │  pick a sujet                     │
                    └───────────────────────────────────┘
                                                        │
   ┌────────────────────────────────────────────────────▼──────────────────┐
   │ 1. SUJET (briefing)   step 0                                          │
   │    left: part title · déroulé de la séance · "Avant de commencer"     │
   │          (mic test, endroit calme)                                    │
   │    right: DELF pill · document déclencheur · consigne                 │
   │    actions: [Passer]  [Commencer la préparation · 30:00]              │
   └────────────────────────────────────────────────────┬──────────────────┘
                                                        │ onStart
   ┌────────────────────────────────────────────────────▼──────────────────┐
   │ 2. PRÉPARATION        step 1 · timer ring in the topbar               │
   │    left: sujet, justified, "Votre mission"                            │
   │    right: passation card + CTA · notes textarea · structure attendue  │
   │    exits: time-up  |  "Commencer la passation"  |  Retour → dialog    │
   └────────────────────────────────────────────────────┬──────────────────┘
                                                        │
   ┌────────────────────────────────────────────────────▼──────────────────┐
   │ 3. PASSATION          step 2 · timer ring + exit button               │
   │    scene: Examinateur (IA) ── beats + clock ── Vous                   │
   │    body:  one quiet status card (no transcript feed)                  │
   │    foot:  [Mes notes]      (mic)      [Terminer l'épreuve]            │
   │    drawer: préparation notes, read-only                               │
   └────────────────────────────────────────────────────┬──────────────────┘
                                                        │ finish / time-up
   ┌────────────────────────────────────────────────────▼──────────────────┐
   │ 4. ÉVALUATION                                                          │
   │    loading  → "Évaluation en cours…"  (spinner card)                  │
   │    error    → "Évaluation impossible" + Réessayer                     │
   │    loaded   → header (sujet · level · Correction IA · Recommencer)    │
   │               left  : transcript as a printed page                    │
   │               right : /25 verdict · 5 collapsible criteria grouped by │
   │                       compétence · points forts · axes · appréciation │
   │                       · conseil · floor confirmation                  │
   └───────────────────────────────────────────────────────────────────────┘
```

---

## 3. How it maps onto this project

### Architecture differences that shape the reproduction

| | Reference | Here |
| --- | --- | --- |
| Levels | A1–B2, part chosen by query param | B2 only, one fixed two-part épreuve |
| Phases | `intro → preparation → conversation → evaluation`, all client-side | A state machine (`lib/delf/phases.ts`): `preparation → monologue → debate → finished`, one clock each |
| Speaking | one conversation, beats approximated from a 40 % time share | two real phases with their own timers and their own examiner behaviour |
| Transport | ElevenLabs agent | Gemini Live, with reconnect/resume state a candidate can see |
| Recording | none | real per-phase capture, uploaded at the end |
| Correction | client action, rendered in place | persisted server-side, read back at `/app/results/[examId]` |
| Sujet identity | encoded in a `?topic=` query param | a sitting row, `/app/oral/[examId]` |
| UI kit | shadcn + Hugeicons + motion/react | none — Tailwind v4 and this project's own tokens |

### Screen-by-screen

**Briefing.** Reproduced whole: the two-column split, the déroulé rail, the
pre-flight card with a real `getUserMedia` mic test, the document set as a
justified printed page with its consigne ruled off below.

- *Adapted:* the déroulé is built from `PHASE_DURATIONS`, so it prints this
  project's three real phases rather than a level's `OralPartSpec`.
- *Kept from here:* the WebCodecs support check. The reference has no equivalent
  because it never uploads audio; here a browser that cannot encode loses the
  whole audio correction, and the briefing is the last moment the candidate can
  do anything about it. It renders as a fourth pre-flight row — the reference's
  own shape for "can I do this now?" — plus the existing danger notice.
- *Dropped:* the transport toggle row. It is admin-gated in the reference
  (`connectionLabel` returns `undefined` for candidates) and this project has no
  admin role, so the row would never render for anyone.

**Préparation.** Reproduced whole: the sujet on the left, the rail on the right
carrying the passation card, the notes textarea and « Structure attendue », the
single clock in the topbar and the "Passer et commencer maintenant" ghost button
at the rail's foot.

**Passation.** Reproduced whole: the scene with its two faces and pulsing rings,
the beat stepper, the elapsed/total clock with its draining bar, the foot control
bar, the notes drawer.

- *Adapted:* the beats are `["Exposé", "Débat"]` driven by the actual phase, not
  by `EXPOSE_SHARE`. This project knows which beat it is in; approximating it
  would be worse data.
- *Adapted:* the mic button advances the épreuve rather than opening a socket —
  the socket is the controller's. During the monologue it is disabled until the
  5-minute DELF floor, which is `canAdvanceEarly`'s existing rule shown as a hint
  under the mic rather than as a long button label.
- *Kept from here:* the connection badge, the recording badge, the lost-connection
  notice with its reconnect button, and the microphone notice. The reference has
  no analogue for any of them; they are real states of this product and #11's
  requirement is that each has a visible, non-technical message. They sit in the
  topbar (badges) and above the scene (notices).
- *Dropped:* the reference's `alert()` calls on mic failure. This project routes
  every failure through `<Notice>`.

**Évaluation.** Reproduced whole: the slim header, the split body, the transcript
column set as a printed page, the /25 verdict with its floor warning, the five
criteria as collapsible band rows grouped by compétence, points forts / axes /
appréciation / conseil, and the floor confirmation line.

- *Kept from here:* `BandScale`. The reference prints a bar and a `3/5` chip; the
  official grid prints the whole `0 · 1 · 3 · 5` scale with the awarded band
  ringed, which is what this project already draws and what a candidate learns
  more from. It sits inside the reference's collapsible row, replacing the bar.
- *Kept from here:* the duration-penalty line, the "corrigé sans l'audio" notice
  and the two measured phase durations. All are facts this correction carries and
  the reference's never did.
- *Adapted:* "Recommencer" starts a **new sitting** rather than resetting client
  state — a sitting here is a row, and re-running one would overwrite a
  correction that is already the candidate's record.

**Hub.** Reproduced whole from a pure view model: serif masthead + shape pill,
« Le format de l'épreuve » (one card per partie, facts as chips, the criteria
behind a hairline on the last card), « Sujets à la une », capability strip.

- *Adapted:* the sujets come from `ORAL_TOPICS` and the per-sujet best score from
  this project's own `evaluations`, so the "Commencer / Refaire" state and the
  score tag are both real.

**Sujets.** Reproduced as the kiosk's shape: masthead, search, cards, detail
sheet, launch dialog.

- *Dropped:* the facet chips and the `[month]` route. The reference facets by
  DELF partie because its catalogue mixes A1–B2 parts; here every sujet is the
  same B2 épreuve, so the chips would be one chip reading "6". The monthly route
  needs a publication date this catalogue does not carry.

**Tableau de bord.** Reproduced as the shape: stat tiles, a breakdown card with
bars, a recent-sittings list, the empty state.

- *Adapted:* « Moyenne par partie » becomes **moyenne par critère**. This project
  runs both parts inside one sitting with one /25, so there is no per-part score
  to average — but the five criteria are five real columns, which is the same
  bar-chart shape fed by data that exists.
- *Adapted:* the tiles are average /25, success rate against the floor, practice
  time (summed from `oral_exam_phases.spoken_seconds`, i.e. measured audio) and
  the day streak.

---

## 3b. Departures from the reference that are product rules, not layout

**Walking out counts.** The reference's exit dialog warns only that progress will
not be saved, because it records nothing and scores nothing. Here, confirming the
exit stamps `oral_exams.abandoned_at`, and the sitting joins the candidate's
record as `0/25` — it drags the average down, counts against the pass rate, and
appears in the historique naming the phase it was walked out of. The dialog says
exactly that before the candidate commits, because a warning the product does not
honour is worse than no warning.

The zero is computed where the history is read, never stored as an evaluation
row: no model read an abandoned performance, so there is no correction to write,
and a zero-scored `evaluations` row would claim otherwise.

The column is a separate one rather than a reading of `finished_at` and `phase`.
Between them those two can already describe a sitting that ran to the end and was
never graded — but they cannot tell that apart from a tab closed by a flat
battery, and only one of those is a decision. That difference is the whole point:
what is being recorded is the candidate's *choice* to leave after an explicit
warning.

**A historique page**, which the reference has no equivalent of — its tableau de
bord shows a recent list and nothing more. It is a list and only a list: the
dashboard answers "how am I doing?", this answers "what have I done?", and two
pages that both open on a row of statistics would be the same page twice.

## 4. Deliberate departures, collected

Everything below is a decision, not an oversight:

1. **This project's palette, the reference's layout.** The reference is shadcn
   blue with Instrument Serif; this project is institutional navy on warm paper
   with Spectral, chosen in #11 to look like the épreuve's own paperwork. The
   instruction was to adapt without redesigning the interface — the interface is
   the layout and the interactions, which are reproduced token for token in
   structure and mapped onto the existing colour vocabulary.

   **Light only.** The palette's dark counterpart was removed rather than left
   unused. Every surface in this product is named for printed matter — `--paper`,
   `--paper-border`, the tricolore rule, the justified serif measure of an exam
   booklet — and a dark inversion of a printed page is a photograph of a page
   rather than the page. `color-scheme: light` goes with it so the browser's own
   furniture (scrollbars, form controls, the `<dialog>` backdrop) matches.

   **The paperwork treatment.** The reproduction initially read too much like the
   reference, which is a rounded-card interface: `rounded-2xl` panels, soft
   shadows, pill everything. The layout and interactions are unchanged; what
   changed is that panels are squared to a 2 px radius (`.sheet`), sections carry
   a numbered kicker and the double rule a corrector's grid closes a block with
   (`.rule-double`), and the sujet cards sit on the warm paper stock the sujet
   itself is printed on — so the catalogue reads as a stack of sujets rather than
   a grid of cards. Same components, same spacing rhythm, drawn as stationery.

   **Navigation is a sidebar**, per the reference's `components/app-sidebar/*`:
   a rail on desktop, and below `md` a slim top bar for the brand and the account
   plus a fixed bottom tab bar. The reference's rail is collapsible to an icon
   strip with a ⌘B shortcut because it navigates four épreuves each with three
   sub-links; three destinations do not earn a provider, a persisted cookie and a
   keyboard shortcut, so the anatomy and the active-state rules are reproduced
   and the collapse control is not. The `(fullscreen)` group keeps no app chrome
   at all — a tab bar across the foot of the passation would sit exactly where
   the mic is.
2. **No Hugeicons, no motion/react, no shadcn.** This project has none of the
   three as dependencies and adding them for icon glyphs and two keyframes would
   be a large dependency bill for a small surface. Icons are inline SVGs in one
   module; the pulse rings and the audio bars are CSS keyframes in `globals.css`,
   which also means they already obey the existing `prefers-reduced-motion` rule.
3. **The transport toggle, the facet chips and the `[month]` route are gone**, for
   the reasons given above. Each would have rendered an empty or degenerate
   control.
4. **`alert()` never appears.** Every failure goes through `<Notice>`.
