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

| Route                                         | Shell          | What it is                                                                          |
| --------------------------------------------- | -------------- | ----------------------------------------------------------------------------------- |
| `/production-orale`                           | app chrome     | The hub: masthead, format of the épreuve, sujets à la une, capability strip         |
| `/production-orale/sujets-actualites`         | app chrome     | The sujets kiosk: masthead, search, facet chips, cards, detail sheet, launch dialog |
| `/production-orale/sujets-actualites/[month]` | app chrome     | The same kiosk, scoped to a month                                                   |
| `/production-orale/tableau-de-bord`           | app chrome     | Stat tiles, per-part averages, recent submissions                                   |
| `/production-orale/simulateur`                | **fullscreen** | The épreuve itself: four phases in one client component                             |

### Components

The simulateur is one orchestrator (`simulateur-client.tsx`) that renders one of
four screens, plus a shared chrome. The chrome and the two static screens live in
`components/po/*`; the live conversation and the /25 report keep their own files.

| Component                                  | Job                                                                                       |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `PoSimulatorTopBar`                        | Retour · identity kicker · `Sujet / Préparation / Passage` stepper · per-phase right slot |
| `PoTimerRing`                              | Draining SVG ring + `m:ss`, destructive-red inside the urgency window                     |
| `PoBriefingScreen`                         | Left "séance" rail (déroulé + pre-flight checks) / right document déclencheur             |
| `PoPreparationScreen`                      | Left sujet / right rail (passation card, notes, structure attendue)                       |
| `PoConversationScene`                      | The two faces, the beat stepper, the elapsed/total clock and its bar                      |
| `PoSceneStepper`                           | The beats _inside_ the passation (`Exposé → Débat`) — not the top-level stepper           |
| `PoConversationControls`                   | Foot bar: notes toggle · big mic · Terminer l'épreuve                                     |
| `PoNotesDrawer`                            | Read-only slide-over of the préparation notes                                             |
| `PoAudioBars`                              | Five breathing bars — a "mic is live" glyph, not a level meter                            |
| `ConversationSimulateur`                   | Transport + timing brain; owns no layout                                                  |
| `EvaluationResultats` / `OralResultReport` | Loading → error → the two-column /25 report                                               |
| `EpreuveHub` + `hub-*`                     | The hub, drawn entirely from a pure view model                                            |
| `SujetsCatalogue` + `sujet-*`              | The shared sujets kiosk                                                                   |

### Pure view models

Everything the screens _print_ is derived in React-free modules so it can be unit
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
   │ 1. PRÉPARATION        step 0 · ring + « Commencer » in the topbar ·   │
   │                       starts on arrival, consigne spoken (#37, #55)   │
   │    left: notices · sujet, justified · « Passer » on the               │
   │          « Document déclencheur » rule while it speaks (#59) ·        │
   │          "Votre mission"                                              │
   │    right: notes textarea · structure attendue · "Avant de             │
   │           commencer" (mic test, endroit calme, navigateur) · déroulé  │
   │    exits: time-up  |  « Commencer » (topbar)  |  Retour → dialog      │
   └────────────────────────────────────────────────────┬──────────────────┘
                                                        │
   ┌────────────────────────────────────────────────────▼──────────────────┐
   │ 2. PASSATION          steps 1–2 · timer ring + exit button            │
   │    head: sujet title on paper · « Passer » beside it while the        │
   │          consigne speaks (#59)                                        │
   │    body:  exposé → document + « Votre plan » in a column beside it    │
   │           débat  → the two faces, then the exchange in turns; no      │
   │                    document (#60)                                     │
   │    foot:  [Mes notes]      (mic)      [Terminer l'épreuve]            │
   │    drawer: préparation notes, read-only                               │
   └────────────────────────────────────────────────────┬──────────────────┘
                                                        │ finish / time-up
   ┌────────────────────────────────────────────────────▼──────────────────┐
   │ 3. ÉVALUATION                                                          │
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

|                | Reference                                                          | Here                                                                                                  |
| -------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Levels         | A1–B2, part chosen by query param                                  | B2 only, one fixed two-part épreuve                                                                   |
| Phases         | `intro → preparation → conversation → evaluation`, all client-side | A state machine (`lib/delf/phases.ts`): `preparation → monologue → debate → finished`, one clock each |
| Speaking       | one conversation, beats approximated from a 40 % time share        | two real phases with their own timers and their own examiner behaviour                                |
| Transport      | ElevenLabs agent                                                   | Gemini Live, with reconnect/resume state a candidate can see                                          |
| Recording      | none                                                               | real per-phase capture, uploaded at the end                                                           |
| Correction     | client action, rendered in place                                   | persisted server-side, read back at `/app/results/[examId]`                                           |
| Sujet identity | encoded in a `?topic=` query param                                 | a sitting row, `/app/oral/[examId]`                                                                   |
| UI kit         | shadcn + Hugeicons + motion/react                                  | none — Tailwind v4 and this project's own tokens                                                      |

### Screen-by-screen

**Briefing — dropped as a screen (#55).** The reference opens on a sujet screen
whose CTA starts the préparation, and this project reproduced it whole. It could
not stay: a sitting here is created by « Commencer » in the sujets kiosk, under a
launch dialog that says « La préparation démarre dès l'ouverture », so the
briefing asked the candidate to commit twice — and it held the examiner's first
spoken consigne (#37), which `ExamController.start()` fires, behind the second
click. Its own « Passer », a top-bar neighbour of the primary CTA, went straight
past the préparation into the exposé. The épreuve now starts when the page does.

What it carried was not dropped with it:

- _Moved:_ the pre-flight card, into the préparation rail as `PreflightCard`,
  with the real `getUserMedia` mic test intact.
- _Moved:_ the déroulé, to the foot of the same rail. Still built from
  `PHASE_DURATIONS`, so it prints this project's three real phases rather than a
  level's `OralPartSpec`.
- _Moved:_ the WebCodecs danger notice, over the préparation's sujet. The
  reference has no equivalent because it never uploads audio; here a browser that
  cannot encode loses the whole audio correction, and the préparation is now the
  last moment the candidate can do anything about it. The topbar's « Commencer »
  is what waits for the answer.
- _Dropped with the screen:_ the transport toggle row — admin-gated in the
  reference (`connectionLabel` returns `undefined` for candidates), and this
  project has no admin role, so it never rendered for anyone — and the serif
  part headline, whose `partSubtitle` helper went with its only caller.

**Préparation.** The sujet on the left, the rail on the right, one clock in the
topbar. It is now the épreuve's first screen, so the rail also carries the
pre-flight checks and the déroulé, and the topbar stepper stands on
« Préparation » rather than on « Exposé » — it was written as a literal `1` when
the stepper still counted screens.

Two departures from the reference's rail, both #59:

- _The way on moved into the topbar._ The reference has a passation card with the
  primary CTA and a "Passer et commencer maintenant" ghost at the rail's foot —
  the same action twice, three cards below the clock that tells a candidate
  whether to press it. There is one « Commencer » now and it is beside the ring.
  It keeps the `checking` gate the card's button held.
- _The consigne is a button, not a card._ It was a panel with the script, a
  replay and a sticky mute, and it outlived the clip by the length of the phase.
  While the voice plays there is « Passer » at the right-hand end of the
  « Document déclencheur » rule — beside the document the consigne is about —
  and nothing after it. A consigne the browser refuses to autoplay still gets
  its sentence and its two ways out, because that state holds the épreuve.

**Passation.** The sujet's title on paper, the foot control bar and the notes
drawer, with the two parts framed differently: the exposé prints the document
with « Votre plan » in a column beside it (#59); the débat prints no document at
all and gives the room to the reference's scene — two faces, a ring pulsing
around whoever holds the floor, the elapsed/total clock with its draining bar —
over the exchange, turn by turn.

- _Added, against the reference (#48, #60):_ the débat shows **who is speaking
  and what was said**. The reference has no transcript feed anywhere, and this
  screen has now been built all three ways: the exchange alone (#48), which left
  no cue for whose turn it was and squeezed the turns into a 20rem box beside the
  document; the faces alone (#60), which left a candidate no way to re-read the
  objection they were answering; and this, which pays for both by dropping the
  document. A candidate arguing a point is not reading the source, and the sujet
  is still named by its title above the scene. The turns are chat-style — the
  examiner left, « Vous » right — where the results page sets the same exchange
  as a printed document: during the sitting it is a conversation, afterwards it
  is a record. The speaker names are the same in both, because _who_ said
  something must not change between them.
- _Dropped with it:_ the quiet status card the feed could be hidden behind, and
  its « Masquer » / « Afficher la transcription » pair. Its two sentences are the
  two lines under the faces, and its guidance is what the conversation panel
  prints while it is still empty.
- _Added, against the reference (#55):_ the **close is on screen**. Ending a part
  asks the examiner for a closing sentence and waits up to `CLOSING_SAFETY_MS`
  for it, so several seconds pass between the click and the next consigne. The
  control now goes inert and says « Fin de l'exposé », and the status line says
  what follows. Before, `canAdvance` went false and the control fell back to its
  locked copy: « Encore 0 min avant de pouvoir conclure », over a monologue that
  was concluding.
- _Dropped:_ the scene's inner beat stepper. The reference names the two beats
  — Exposé, Débat — between the faces, and this project's topbar has named the
  épreuve's three parts since #37; two steppers disagreeing about which step the
  candidate is on is why the inner one went, and it did not come back with the
  scene (#60).
- _Adapted:_ the mic button advances the épreuve rather than opening a socket —
  the socket is the controller's. During the monologue it is disabled until the
  5-minute DELF floor, which is `canAdvanceEarly`'s existing rule shown as a hint
  under the mic rather than as a long button label.
- _Kept from here:_ the connection badge, the recording badge, the lost-connection
  notice with its reconnect button, and the microphone notice. The reference has
  no analogue for any of them; they are real states of this product and #11's
  requirement is that each has a visible, non-technical message. They sit in the
  topbar (badges) and above the sujet (notices).
- _Dropped:_ the reference's `alert()` calls on mic failure. This project routes
  every failure through `<Notice>`.

**Évaluation.** Reproduced whole: the slim header, the split body, the transcript
column set as a printed page, the /25 verdict with its floor warning, the five
criteria as collapsible band rows grouped by compétence, points forts / axes /
appréciation / conseil, and the floor confirmation line.

- _Kept from here:_ `BandScale`. The reference prints a bar and a `3/5` chip; the
  official grid prints the whole `0 · 1 · 3 · 5` scale with the awarded band
  ringed, which is what this project already draws and what a candidate learns
  more from. It sits inside the reference's collapsible row, replacing the bar.
- _Kept from here:_ the duration-penalty line, the "corrigé sans l'audio" notice
  and the two measured phase durations. All are facts this correction carries and
  the reference's never did.
- _Adapted:_ "Recommencer" starts a **new sitting** rather than resetting client
  state — a sitting here is a row, and re-running one would overwrite a
  correction that is already the candidate's record.

**Hub.** Reproduced whole from a pure view model: serif masthead + shape pill,
« Le format de l'épreuve » (one card per partie, facts as chips, the criteria
behind a hairline on the last card), « Sujets à la une », capability strip.

- _Adapted:_ the sujets come from `ORAL_TOPICS` and the per-sujet best score from
  this project's own `evaluations`, so the "Commencer / Refaire" state and the
  score tag are both real.

**Sujets.** Reproduced as the kiosk's shape: masthead, search, cards, detail
sheet, launch dialog.

- _Dropped:_ the facet chips and the `[month]` route. The reference facets by
  DELF partie because its catalogue mixes A1–B2 parts; here every sujet is the
  same B2 épreuve, so the chips would be one chip reading "6". The monthly route
  needs a publication date this catalogue does not carry.

**Tableau de bord.** Reproduced as the shape: stat tiles, a breakdown card with
bars, a recent-sittings list, the empty state.

- _Adapted:_ « Moyenne par partie » becomes **moyenne par critère**. This project
  runs both parts inside one sitting with one /25, so there is no per-part score
  to average — but the five criteria are five real columns, which is the same
  bar-chart shape fed by data that exists.
- _Adapted:_ the tiles are average /25, success rate against the floor, practice
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
what is being recorded is the candidate's _choice_ to leave after an explicit
warning.

**A historique page**, which the reference has no equivalent of — its tableau de
bord shows a recent list and nothing more. It is a list and only a list: the
dashboard answers "how am I doing?", this answers "what have I done?", and two
pages that both open on a row of statistics would be the same page twice.

**Starting over archives, it does not delete** (#69). The reference has a billing
page where this product has an account screen, and the one thing that screen
does is « Réinitialiser ma progression »: the tableau de bord returns to its empty state and
the sujet cards return to « Commencer », while every épreuve stays in the
historique under _Archives_, correction and all. `oral_exams.archived_at` is the
whole mechanism — a line drawn across the record rather than a tombstone — and it
is stamped only on sittings already on the record, so an épreuve still in
progress when the button is pressed belongs to the new record instead of
vanishing into the old one.

**The avatar keeps its menu; the account stops being a modal.** Clicking it still
offers « Gérer le compte » and « Se déconnecter », as it always did — what
changed is that the first of those lands on `/app/compte`
(`userProfileMode="navigation"`) instead of opening Clerk's dialog over the app.
The account is therefore a page: « Réinitialiser ma progression » in the header
opposite the title, and Clerk's card below it. The reset is not inside that card
and not a page of its nav — it touches nothing Clerk owns — and the header is the
only place on a page this tall that is visible the moment it loads, which matters
for the one control a candidate might arrive looking for. The explanation travels
with the confirmation rather than sitting on screen permanently: a candidate who
is not pressing it does not need the paragraph, and one who is needs it right
then. The reset is deliberately **not** a third tab in Clerk's
nav — it touches nothing Clerk owns, and filing it beside _Profil_ and _Sécurité_
claimed it was an account setting. Signing out stays in the menu, so the page
carries no sign-out control of its own. It is not a fifth destination in the rail: an
account is not part of the épreuve, and the four destinations stay four.

Clerk still draws the account screens. `<UserProfile>` is embedded rather than
reproduced — name, e-mail, password and sessions change when the provider
changes, and a hand-written copy would be a second place to change an e-mail with
one of the two eventually wrong. What is ours is the palette it is drawn in:
`lib/ui/clerk-appearance.ts` maps this product's tokens onto Clerk's variables,
and the load-bearing one is `borderRadius: 2px` — the `.sheet` number, and the
whole difference between a card from another application and a sheet of paper.
The colours are duplicated as literals there on purpose, because Clerk derives a
scale from each and cannot parse a `var(…)`.

The reset's confirmation is a panel under the button rather than a `<dialog>` — a
deliberate retreat from how the exit dialog does it. That dialog interrupts an
épreuve in progress and has to; this interrupts nothing, and a modal for a
control the candidate opened this page to use is a ceremony rather than a
safeguard.

**« Réinitialiser » is red and its confirm is not**, which narrows the rule
`button-styles.ts` used to state. Nothing here is deleted, so by the old reading
("never a destructive one") the trigger would not be red at all; it is, because a
reset of somebody's record should announce itself as consequential whether or not
it is reversible. What the colour must not do is hurry the decision, so red
appears once per decision — on the trigger here, on « Abandonner » in the exit
dialog — and never again on the button that confirms it.

The count is reported _after_ the reset, from what the route says it archived,
rather than promised before it.

**Changing a password is a Clerk setting, not code.** The _Sécurité_ tab shows a
password section only when the password strategy is enabled on the instance
(Clerk Dashboard → User & authentication → Password) — #36 §3 recommended turning
it **off** so the e-mail path is `email → code → in`, and with it off there is
nothing for the tab to show. Turning it back on makes « Mot de passe » appear
with no change here.

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
