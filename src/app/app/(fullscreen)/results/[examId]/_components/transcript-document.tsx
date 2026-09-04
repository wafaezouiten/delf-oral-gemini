"use client";

import { RecordingPlayer } from "@/app/_components/recording-player";
import { TeacherIcon, UserIcon } from "@/app/_components/po/icons";
import { Kicker } from "@/app/_components/po/tag";
import { formatClock } from "@/lib/delf/phases";
import type { TranscriptEntry, TranscriptPhase, TranscriptSpeaker } from "@/lib/delf/transcript";
import { cn } from "@/lib/ui/class-names";
import {
  CORRECTION_TRANSCRIPT_COPY,
  correctionTranscriptView,
  type CorrectionTranscriptTurn,
} from "@/lib/ui/correction-transcript";
import { speakerLabel, turnKey } from "@/lib/ui/debate-conversation";

/**
 * The épreuve as it was spoken, read back as a document (#190).
 *
 * PORT NOTE: `oral-transcript.tsx` in the main project (delf-preps@3901a2d6),
 * on this project's paper stock. The main project dropped both the chat
 * bubbles and the ruled turns this page used to draw (#87) for the same two
 * reasons, and they hold here: a page of filled blocks is a large saturated
 * area doing no classifying work, and a B2 sitting is TWO parts with different
 * shapes, which one undifferentiated log hides. So each part renders as what
 * it actually is:
 *
 *   - **A monologue is prose.** Only the candidate speaks for five to seven
 *     minutes, so labelling every paragraph would repeat the same word down
 *     the page. It is attributed once, in the part's head, and then reads as
 *     the continuous exposé it was.
 *   - **A débat is an exchange**, so each turn opens with the speaker's face
 *     and the prose wraps around it, with the turn's stamp floated opposite.
 *
 * **Speakers are faces, not words.** Two roles, two DIFFERENT glyphs — a
 * person for the candidate, a mortarboard for the examiner — so the
 * distinction never rests on hue alone. The candidate keeps `primary`, the one
 * brand voice; the examiner takes the muted neutral, because they are the
 * counterpart in the exchange and not a second classification. The name is on
 * every face as `title` and `aria-label`, so nothing is lost to a hover or a
 * screen reader. The words are this project's (« Vous » / « Examinateur »,
 * `speakerLabel`): the same exchange is set as a feed while it happens and as
 * a record once it is over, and it must not change who it says was speaking
 * between the two.
 *
 * **The recording plays above the words it produced.** The players moved here
 * from the block under the verdict (#185) because this is where the main
 * project puts them: play, then read along. Still one playback surface, the
 * rule #116 set — they moved rather than multiplied. A part with a duration
 * and no kept audio says so in one quiet line.
 *
 * Everything decided rather than drawn — the sectioning, the headings, the
 * stamps' anchor, which of the two "nothing was said" messages fires — is in
 * `lib/ui/correction-transcript.ts`, where it is tested.
 */

export interface PlayableRecording {
  phase: TranscriptPhase;
  mimeType: string;
  durationSeconds: number;
}

const SPEAKER_AVATAR: Record<TranscriptSpeaker, { Icon: typeof UserIcon; className: string }> = {
  candidate: { Icon: UserIcon, className: "bg-primary text-primary-foreground" },
  examiner: { Icon: TeacherIcon, className: "bg-muted text-muted-foreground" },
};

/**
 * The speaker, as a mark rather than a label.
 *
 * `float` puts the disc in the prose's flow so the words wrap UNDER it rather
 * than being indented to clear it — on a phone that is the difference between
 * full-measure prose and a narrow column beside a gutter of avatars. Off in
 * the monologue's head, where the disc sits in a row beside the name.
 */
function SpeakerAvatar({
  speaker,
  float = false,
}: {
  speaker: TranscriptSpeaker;
  float?: boolean;
}) {
  const { Icon, className } = SPEAKER_AVATAR[speaker];
  const name = speakerLabel(speaker);
  return (
    <span
      title={name}
      aria-label={name}
      role="img"
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-full",
        float && "float-left mt-px mr-2.5",
        className,
      )}
    >
      <Icon className="size-4" />
    </span>
  );
}

/** The paragraphs of a dictated exposé. The transcriber returns run-on blocks. */
function paragraphsOf(turns: readonly CorrectionTranscriptTurn[]): string[] {
  return turns
    .flatMap((turn) => turn.entry.text.split(/\n{2,}/))
    .map((part) => part.trim())
    .filter(Boolean);
}

/** The exposé: attributed once at its head, then read as prose. */
function MonologueBody({ turns }: { turns: readonly CorrectionTranscriptTurn[] }) {
  return (
    <div className="mt-3">
      <div className="flex items-center gap-2.5">
        <SpeakerAvatar speaker="candidate" />
        {/* The kicker recipe in the candidate's ink — not `Kicker`, whose
            muted ink is fixed and would win or lose against a passed colour
            by Tailwind's ordering rather than by intent. */}
        <span className="text-primary text-[0.6875rem] font-semibold tracking-[0.16em] uppercase">
          {speakerLabel("candidate")}
        </span>
      </div>
      <div className="mt-3 flex flex-col gap-3">
        {paragraphsOf(turns).map((paragraph, index) => (
          <p key={`p-${index}`} className="text-[0.84375rem] leading-[1.75]">
            {paragraph}
          </p>
        ))}
      </div>
    </div>
  );
}

/**
 * The débat: who said what, in order. `overflow-hidden` contains the floated
 * face so the next turn starts clean below it rather than wrapping alongside;
 * `break-inside-avoid` so a turn prints whole or not at all.
 */
function ExchangeBody({ turns }: { turns: readonly CorrectionTranscriptTurn[] }) {
  return (
    <div className="mt-3 flex flex-col gap-4">
      {turns.map(({ entry, timeLabel }, index) => (
        <div key={turnKey(entry, index)} className="break-inside-avoid overflow-hidden">
          <span className="text-muted-foreground/80 tabular float-right ml-3 text-[0.6875rem]">
            {timeLabel}
          </span>
          <SpeakerAvatar speaker={entry.speaker} float />
          <p className="text-[0.8125rem] leading-relaxed">{entry.text}</p>
        </div>
      ))}
    </div>
  );
}

export function TranscriptDocument({
  examId,
  title,
  transcript,
  monologueSeconds,
  debateSeconds,
  playable,
  drawerInset = false,
}: {
  examId: string;
  title: string;
  transcript: readonly TranscriptEntry[];
  monologueSeconds: number;
  debateSeconds: number;
  playable: readonly PlayableRecording[];
  /**
   * Reserve room at the foot for the phone's evaluation drawer, which floats
   * over this pane. The drawer writes its covered height to
   * `--po-drawer-inset` on an ancestor as it moves; without the reserve,
   * opening it at the end of the transcript pins the last turns underneath
   * with no scroll left to recover them. Padding, not margin: the scroll RANGE
   * has to grow. The `0px` fallback is what makes it nothing from `lg`, where
   * the drawer is never placed and never writes the variable.
   */
  drawerInset?: boolean;
}) {
  const { sections, silentNotice } = correctionTranscriptView(transcript, {
    monologueSeconds,
    debateSeconds,
  });
  const seconds: Record<TranscriptPhase, number> = {
    monologue: monologueSeconds,
    debate: debateSeconds,
  };

  return (
    /* The scroll is unconditional, not `lg:`-only: below `lg` this pane is
       the whole screen with the evaluation in a drawer over it, so it owns
       its own scrolling at every width. `print:overflow-visible` releases the
       clip so the sheet paginates (#70). */
    <section className="bg-muted/30 min-h-0 overflow-y-auto print:overflow-visible">
      <div
        className="mx-auto max-w-[42.5rem] px-4 py-5 sm:px-7 sm:py-6"
        style={
          drawerInset
            ? { paddingBottom: "calc(4rem + var(--po-drawer-inset, 0px))" }
            : { paddingBottom: "4rem" }
        }
      >
        <article className="border-paper-border bg-paper sheet border p-5 sm:p-8">
          <div className="border-border flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b pb-3">
            <Kicker>{CORRECTION_TRANSCRIPT_COPY.kicker}</Kicker>
            <span className="text-muted-foreground tabular shrink-0 text-[0.6875rem] whitespace-nowrap">
              Durée totale {formatClock(monologueSeconds + debateSeconds)}
            </span>
          </div>

          <h2 className="mt-4 font-serif text-xl leading-tight font-semibold">{title}</h2>

          {silentNotice && (
            <div className="border-danger/40 bg-danger-subtle sheet mt-5 border border-dashed p-4">
              <p className="text-danger text-[0.8125rem] font-bold">{silentNotice.title}</p>
              <p className="text-muted-foreground mt-1.5 text-xs leading-relaxed">
                {silentNotice.body}
              </p>
            </div>
          )}

          <div className="mt-6 flex flex-col gap-5">
            {sections.map((section) => {
              const recording = playable.find((entry) => entry.phase === section.phase) ?? null;
              // A part where nobody but the examiner spoke is a monologue only
              // by accident; the shape follows who actually talked, so a
              // silent sitting still reads as an exchange rather than as an
              // empty exposé.
              const isMonologue =
                section.turns.length > 0 &&
                section.turns.every((turn) => turn.entry.speaker === "candidate");

              return (
                <section
                  key={section.phase}
                  className="border-border border-t pt-4 first:border-t-0 first:pt-0"
                >
                  {/* `break-after-avoid`: a heading that lands as the last
                      line of a printed page sends the candidate over the fold
                      to find out which half they are reading. */}
                  <div className="flex break-inside-avoid break-after-avoid items-baseline justify-between gap-3">
                    {/* An `h3` wearing the kicker's recipe, not `Kicker` —
                        that renders a `<p>`, and these two labels are the only
                        sub-headings under the sheet's `h2`. A transcript set as
                        a document has to be navigable as one: losing them
                        leaves a screen reader no way to jump from the exposé to
                        the débat. */}
                    <h3 className="text-muted-foreground text-[0.6875rem] font-semibold tracking-[0.16em] uppercase">
                      {section.heading}
                    </h3>
                    <span className="text-muted-foreground tabular shrink-0 text-[0.6875rem]">
                      {section.durationLabel}
                    </span>
                  </div>

                  {/* The recording, above the words it produced: play, then
                      read along. `no-print` is the player's own. */}
                  {recording ? (
                    <RecordingPlayer
                      src={`/api/exams/${examId}/recordings/${section.phase}`}
                      deleteHref={`/api/exams/${examId}/recordings/${section.phase}`}
                      mimeType={recording.mimeType}
                      durationSeconds={recording.durationSeconds}
                      className="mt-3"
                    />
                  ) : (
                    seconds[section.phase] > 0 && (
                      <p className="no-print text-muted-foreground mt-2.5 text-xs leading-relaxed italic">
                        L&apos;enregistrement de cette partie n&apos;est plus disponible : il a été
                        supprimé, ou il n&apos;a pas pu être conservé.
                      </p>
                    )
                  )}

                  {section.emptyNote ? (
                    <p className="text-muted-foreground mt-3 text-xs leading-relaxed italic">
                      {section.emptyNote}
                    </p>
                  ) : isMonologue ? (
                    <MonologueBody turns={section.turns} />
                  ) : (
                    <ExchangeBody turns={section.turns} />
                  )}
                </section>
              );
            })}
          </div>

          <p className="border-border text-muted-foreground mt-6 border-t pt-3 text-[0.6875rem] leading-relaxed">
            {CORRECTION_TRANSCRIPT_COPY.footnote}
          </p>
        </article>
      </div>
    </section>
  );
}
