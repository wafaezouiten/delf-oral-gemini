import type { ReactNode } from "react";

import { ExitIcon } from "@/app/_components/po/icons";
import { Kicker } from "@/app/_components/po/tag";
import { SimulatorTopBar } from "@/app/_components/po/topbar";
import { TimerRing } from "@/app/_components/po/timer-ring";
import { cn } from "@/lib/ui/class-names";
import type { OralTopic } from "@/lib/delf/topics";
import type { TranscriptEntry } from "@/lib/delf/transcript";
import { passationView, type PassationView } from "@/lib/ui/passation-view";
import {
  SITE_FOOTER,
  partieKicker,
  poKicker,
  topbarStep,
  type SpeakingPhase,
} from "@/lib/ui/po-player-view";
import { ConversationControls } from "./conversation-controls";
import { ConversationScene } from "./conversation-scene";
import { DebateConversation } from "./debate-conversation";
import { ExposePlan } from "./expose-plan";
import { NotesDrawer } from "./notes-drawer";

/**
 * The passation: the sujet the candidate is speaking about, in front of them
 * while they speak about it.
 *
 * **The sujet is on screen throughout, and that is what changed in #37.** This
 * screen was two avatar faces over a status card, with the document left behind
 * on the préparation: a candidate delivering a seven-minute argued exposé about
 * a text could not see the text, and could not see the plan they had been told
 * to follow. The sujet, the plan and the record control took that room and keep
 * it.
 *
 * The two parts share the frame and differ in what stands with the sujet:
 *
 *  - **The exposé sets « Votre plan » beside it, in a second column (#59).**
 *    Four beats, the same list the préparation rail gives thirty minutes to
 *    absorb, still on screen while the clock runs — and no longer under the
 *    document, where re-reading the source scrolled the plan away during the
 *    one part whose whole task is following it. The frame widens to hold both,
 *    and collapses to one column below `lg`.
 *  - **The débat drops the document and keeps the conversation (#60).** It has
 *    the two protagonists at the top — a ring around whoever holds the floor,
 *    one status line each — and the exchange under them, turn by turn, as it is
 *    transcribed. What it does not have is `topic.document`: during the débat
 *    the candidate is answering the examiner rather than reading, and the
 *    paragraphs would take a third of the viewport to be looked at by nobody.
 *    The sujet's title stays, so what is being argued about is still named.
 *
 *    That panel has been added (#48), removed (#60) and put back in this shape,
 *    and the two earlier arguments were each half right: the exchange competing
 *    with the document and a status card left it in a 20rem box, and taking it
 *    away left a candidate with no way to re-read the objection they are
 *    answering. Given the room, both fit — knowing whose turn it is at a glance,
 *    and what the turn was.
 *
 * **Nothing runs until « Enregistrer ».** The part opens armed: the consigne is
 * given, the sujet and the plan are readable, the timer shows the part's full
 * length and no artefact is open. The candidate starts it themselves. Reading the
 * document you are about to argue from should not be charged to the seven minutes
 * you have to argue in, and the DELF grades how long you spoke.
 */
/** The live part as the controller reports it, and what this screen reads of it. */
export interface PassationState {
  elapsed: number;
  phaseStartedAt: number | null;
  remaining: number;
  recording: boolean;
  examinerSpeaking: boolean;
  openingQuestionPending: boolean;
  connected: boolean;
  connecting: boolean;
  canAdvance: boolean;
  awaitingStart: boolean;
  closing: boolean;
  transcript: readonly TranscriptEntry[];
  /** The monologue came back with no words and the clock is held (#206). */
  emptyTranscript: boolean;
  /** The consigne is still being spoken; nothing starts until it is over. */
  awaitingConsigne: boolean;
}

export interface PassationActions {
  start: () => void;
  advance: () => void;
  exit: () => void;
  retryTranscription: () => void;
}

export function PassationScreen({
  phase,
  topic,
  state,
  notes,
  actions,
  notices,
  announcement,
  devPanel,
}: {
  phase: SpeakingPhase;
  topic: OralTopic;
  state: PassationState;
  /** The préparation's notes, and the drawer they open in. */
  notes: { text: string; open: boolean; onToggle: () => void };
  actions: PassationActions;
  notices?: ReactNode;
  announcement?: ReactNode;
  devPanel?: ReactNode;
}) {
  // Everything this screen decides — the part's name, the column, what each
  // face says, whether the status line prints — is `lib/ui/passation-view.ts`,
  // tested. This component sets it.
  const view = passationView({ phase, ...state, notes: notes.text });

  const sujetHead = <SujetHead phase={phase} title={topic.title} announcement={announcement} />;
  // The exposé's column is wide enough for the plan beside the sujet; the
  // débat's is the conversation's measure.
  const { column, body } =
    view.layout === "monologue"
      ? {
          column: "max-w-[64rem] pt-5",
          body: <MonologueBody topic={topic} sujetHead={sujetHead} statusLine={view.statusLine} />,
        }
      : {
          column: "max-w-[47.5rem] pt-4",
          body: (
            <DebateBody
              view={view}
              sujetHead={sujetHead}
              elapsed={state.elapsed}
              transcript={state.transcript}
              phaseStartedAt={state.phaseStartedAt}
            />
          ),
        };
  // `shrink-0` because the débat's column no longer grows to fit its children:
  // a notice that gave up height under pressure would be a notice the
  // candidate reads half of.
  const noticeSlot = notices ? <div className="shrink-0">{notices}</div> : null;
  const drawer = view.hasNotes ? (
    <NotesDrawer open={notes.open} notes={notes.text} onClose={notes.onToggle} />
  ) : null;

  return (
    <div className="bg-background relative flex h-full min-h-0 flex-col overflow-hidden">
      {/* The topbar's kicker is the part's title in the site's own words —
          the stepper names the parts now, so the kicker no longer has to. */}
      <SimulatorTopBar
        kicker={poKicker(view.partTitle)}
        currentStep={topbarStep(phase)}
        onBack={actions.exit}
        right={
          <>
            <TimerRing remaining={state.remaining} total={view.total} phase={phase} />
            <button
              type="button"
              onClick={actions.exit}
              aria-label="Quitter l'épreuve"
              className="border-danger/30 text-danger hover:bg-danger-subtle flex size-8.5 shrink-0 items-center justify-center rounded-full border transition-colors"
            >
              <ExitIcon className="size-4" />
            </button>
          </>
        }
      />

      <main className="relative flex min-h-0 flex-1 flex-col">
        {/* One column, one scrollbar, both phases — and during the débat the
            scene stops at the top of it instead of leaving with the rest (#88).

            This is `position: sticky` rather than a locked frame with a scroller
            of its own inside it, and the difference is what the candidate gets to
            read. A locked frame gives the exchange whatever is left after the
            fixed parts have taken theirs — on a 1366×768 laptop that measured
            129px, six lines, which is the letterbox #48 removed the panel's own
            scrollbar to escape. Sticky costs nothing: the exchange is as long as
            it is, the whole column scrolls it, and the scene stops on its way
            past. */}
        <div
          className={cn(
            "mx-auto flex min-h-0 w-full flex-1 flex-col gap-4 overflow-y-auto px-4 pb-5 sm:px-6",
            column,
          )}
        >
          {noticeSlot}
          {body}
        </div>

        <ConversationControls
          phase={phase}
          canAdvance={state.canAdvance}
          connecting={state.connecting}
          recording={state.recording}
          awaitingStart={state.awaitingStart}
          startDisabled={view.startDisabled}
          closing={state.closing}
          hasNotes={view.hasNotes}
          notesOpen={notes.open}
          onToggleNotes={notes.onToggle}
          onStart={actions.start}
          onAdvance={actions.advance}
          emptyTranscript={state.emptyTranscript}
          onRetryTranscription={actions.retryTranscription}
          devPanel={devPanel}
        />

        <footer className="border-border bg-card text-muted-foreground shrink-0 border-t px-4 py-2 text-center text-[0.6875rem]">
          {SITE_FOOTER}
        </footer>

        {drawer}
      </main>
    </div>
  );
}

/** The part's kicker and the sujet's title, with the consigne's control beside them. */
function SujetHead({
  phase,
  title,
  announcement,
}: {
  phase: SpeakingPhase;
  title: string;
  announcement?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        <Kicker>{partieKicker(phase)}</Kicker>
        <h1 className="mt-1.5 font-serif text-[1.375rem] leading-[1.25] font-semibold text-balance">
          {title}
        </h1>
      </div>
      {announcement}
    </div>
  );
}

/** The exposé: the sujet with « Votre plan » beside it, and the one-line status under. */
function MonologueBody({
  topic,
  sujetHead,
  statusLine,
}: {
  topic: OralTopic;
  sujetHead: ReactNode;
  statusLine: string | null;
}) {
  return (
    <>
      {/* Sujet left, plan right. The four beats used to sit *under* the
               document, which meant a candidate who scrolled to re-read their
               source scrolled the plan off the screen — during the one part of
               the épreuve where following it is the whole task. Side by side,
               neither costs the other any height. Below `lg` the grid is one
               column and the plan falls back under the sujet, which is the only
               order that fits a phone. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_19rem] lg:items-start">
        <section className="border-paper-border bg-paper rounded-lg border px-5 py-6 sm:px-7">
          {sujetHead}
          <p className="document-text mt-4">{topic.document}</p>
        </section>
        <ExposePlan />
      </div>

      {/* The exposé's line of guidance, under the plan rather than replacing
              it: the plan is the thing to be looking at, and this is one
              sentence saying whether the examiner is there yet. The débat has no
              room for it and no need of it — the same sentence is what its
              conversation panel prints while it is still empty. */}
      {statusLine && (
        <p role="status" className="text-muted-foreground text-center text-xs leading-relaxed">
          {statusLine}
        </p>
      )}
    </>
  );
}

/** The débat: the sujet's name, the two faces pinned, and the exchange under them. */
function DebateBody({
  view,
  sujetHead,
  elapsed,
  transcript,
  phaseStartedAt,
}: {
  view: PassationView;
  sujetHead: ReactNode;
  elapsed: number;
  transcript: readonly TranscriptEntry[];
  phaseStartedAt: number | null;
}) {
  return (
    <>
      {/* The title, and not the document. During the débat the candidate
                  is answering the examiner, not reading — the paragraphs would
                  take a third of the viewport to be looked at by nobody, and the
                  exchange is what needs that room. The line stays so the sujet
                  being argued about is still named on screen.

                  It is also the one part of this screen that scrolls away (#88).
                  A candidate looks for the sujet's name at the top, before the
                  conversation; three turns deep, what they need on screen is who
                  is speaking, not what the subject was called. */}
      <section className="border-paper-border bg-paper shrink-0 rounded-lg border px-5 py-4 sm:px-7">
        {sujetHead}
      </section>

      {/* Who is speaking, over what was said. The scene answers it at a
                  glance and the exchange answers "what did they just ask me",
                  which is the question a candidate actually has to answer.

                  Sticky at the top of the column (#88), so it stops here on its
                  way past instead of leaving with the sujet.

                  The two paint tricks are load-bearing, because a sticky element
                  paints its own box and nothing else, and there is a strip of
                  scrollport on each side of this one that turns would otherwise
                  slide through in full view:

                  - below, the column's `gap-4` — covered by `pb-4 -mb-4`, which
                    paints the gap without occupying it;
                  - above, the column's top padding, because `sticky top-0`
                    clamps to the padding edge and not to the scrollport's. That
                    is what `before:` covers: a 1rem band travelling with the row
                    and sitting immediately above it. A negative top margin looks
                    like the fix and is not — it moves the box down by exactly as
                    much as it pulls the layout up, and the strip survives.

                  Both bands are 1rem, which is why the column's `pt` was set to
                  match its `gap` above: one measurement, two strips, no third
                  number to keep in step. */}
      <div className="bg-background before:bg-background sticky top-0 z-10 -mb-4 pb-4 before:absolute before:inset-x-0 before:bottom-full before:h-4">
        <ConversationScene {...view.scene} elapsed={elapsed} total={view.total} />
      </div>

      <DebateConversation
        transcript={transcript}
        phaseStartedAt={phaseStartedAt}
        hint={view.statusBody}
      />
    </>
  );
}
