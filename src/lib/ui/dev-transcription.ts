/**
 * The arithmetic and the copy behind the development transcription panel (#36).
 *
 * DEVELOPMENT ONLY in effect, but a plain module by construction: nothing here
 * reads `NODE_ENV`, touches a device or knows what a controller is. The guards
 * live where the consequences are — the panel's render, the controller's
 * `injectCandidateSpeech`, and the finish route's duration override — and this
 * is the part that can be checked by `node --test`.
 */

import { formatClock } from "@/lib/delf/phases";

/**
 * Words per minute assumed when turning a typed transcript into a spoken
 * duration.
 *
 * A DELF B2 exposé is prepared, argued and delivered to an examiner, which is
 * slower than conversation and much slower than reading aloud. 140 is the middle
 * of the usual 130–160 range quoted for French presentation delivery.
 *
 * It only has to be plausible. The number it produces is a development
 * convenience for testing the duration penalty either side of its threshold, not
 * a measurement of anything — a real sitting's duration is measured from the
 * audio, on the server, out of the bytes that arrived.
 */
export const SPOKEN_WORDS_PER_MINUTE = 140;

/**
 * The longest duration the panel will accept, matching the audit column's own
 * bound (`MAX_PHASE_SECONDS`). Typing four hours into a 13-minute épreuve is a
 * slip, and a slip that reaches the server comes back as a validation error
 * rather than as the thing you meant.
 */
export const MAX_DEV_SECONDS = 4 * 60 * 60;

/**
 * Words in a block of typed text.
 *
 * Not `candidateWordCount`, which counts a transcript rather than a draft, and
 * splits without filtering — harmless where it is used, wrong for a live counter
 * that has to read 0 for an empty field and for a field holding one space.
 */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).filter(Boolean).length;
}

/** How long `words` would plausibly take to say, in whole seconds. */
export function estimateSpokenSeconds(words: number): number {
  if (!Number.isFinite(words) || words <= 0) return 0;
  return Math.round((words / SPOKEN_WORDS_PER_MINUTE) * 60);
}

/**
 * Read the duration field.
 *
 * `null` means "auto" — an empty field, and also anything unreadable, because a
 * half-typed number should behave like the placeholder it is still showing
 * rather than like a zero. `0` is accepted as typed: a phase of no seconds at
 * all is the very case the duration penalty exists for, so it has to be
 * expressible.
 */
export function parseDurationInput(raw: string): number | null {
  const trimmed = raw.trim().replace(",", ".");
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.min(Math.round(value), MAX_DEV_SECONDS);
}

/**
 * The seconds this submission should claim: what was typed, or the estimate when
 * the field is on "auto".
 */
export function resolveDevSeconds(text: string, rawDuration: string): number {
  const typed = parseDurationInput(rawDuration);
  if (typed !== null) return typed;
  return estimateSpokenSeconds(countWords(text));
}

/** `« 412 mots · 2:57 »` — the counter under the field. */
export function describeDraft(text: string, rawDuration: string): string {
  const words = countWords(text);
  const seconds = resolveDevSeconds(text, rawDuration);
  return `${words} ${words === 1 ? "mot" : "mots"} · ${formatClock(seconds)}`;
}

/**
 * The panel's words, per phase (#142).
 *
 * Two tables rather than one, because the button means two different things.
 * On the exposé, sending IS finishing: the text is the whole monologue and the
 * press leaves for the débat. On the débat, sending is one turn of a
 * conversation that keeps going — the examiner answers and the field waits for
 * the next reply. Copy that papered over that difference is how a developer
 * ends a débat they meant to continue.
 */
export const DEV_PANEL_COPY = {
  title: "Transcription directe",
  /** What it replaces, and what it leaves alone. */
  description:
    "Remplace l'enregistrement et la transcription de l'exposé. Le débat et la correction se déroulent normalement.",
  placeholder: "Collez ici la transcription de l'exposé.",
  submit: "Envoyer l'exposé",
} as const;

export const DEV_DEBATE_PANEL_COPY = {
  title: "Réponse au débat",
  /** One turn, not the phase: the débat continues around the panel. */
  description:
    "Remplace une réponse orale du candidat. L'examinateur entend le texte et y répond ; le débat continue.",
  placeholder: "Écrivez la réponse du candidat à la question de l'examinateur.",
  submit: "Envoyer la réponse",
} as const;

/**
 * What « Envoyer l'exposé » can do at this instant.
 *
 * There is one button and it means one thing — this text *is* the monologue —
 * but four of the five states below are ones in which pressing it would do
 * nothing. Before #53 all four were spelled the same way: an enabled button, a
 * field that emptied itself, and no change on screen. So they are named here,
 * with the copy that says which one you are in.
 *
 *  - `empty` — nothing typed. The one state that was already disabled.
 *  - `consigne` — the examiner is speaking. The controller refuses to start a
 *    part underneath its own instruction, so the exposé has nowhere to go yet.
 *  - `sending` — a press is in flight. Brief to the point of invisible now that
 *    an accepted exposé waits for nothing, and kept for that reason: it is what
 *    stops a second press landing on a phase the first one is already ending.
 *  - `closing` — the monologue is being ended the spoken way, by the mic button
 *    or by the clock, and the examiner has been asked for its closing sentence.
 *    A typed exposé never produces this state: it leaves for the débat at once.
 *  - `awaitingStart` — the débat is armed and « Enregistrer » has not been
 *    pressed (#142). The exposé never reports this: its panel starts the part
 *    itself, because sending the exposé and starting the part are one act. The
 *    débat's cannot — the part opens with the EXAMINER's question, asked over a
 *    socket that « Enregistrer » is what connects — so the panel names the
 *    button that actually starts it.
 *  - `ready` — press it.
 */
export type DevSubmitState =
  "ready" | "empty" | "consigne" | "sending" | "closing" | "awaitingStart";

export function devSubmitState(input: {
  text: string;
  /** The examiner is giving this part's consigne (#37). */
  awaitingConsigne: boolean;
  /** A submission is in flight: the part is starting, the socket is opening. */
  sending: boolean;
  /** The closing handshake is under way, whoever started it. */
  closing: boolean;
  /** The part is armed and waiting for « Enregistrer » (#142, débat only). */
  awaitingStart?: boolean;
}): DevSubmitState {
  // `sending` outranks `closing`: a press in flight is this panel's own, and a
  // button that switched mid-press to reporting somebody else's ending would be
  // answering a question nobody asked. It resolves a tick later either way.
  if (input.sending) return "sending";
  if (input.closing) return "closing";
  // The consigne outranks the armed state it overlaps: while the examiner is
  // speaking the instruction, that is the thing happening, and « cliquez
  // Enregistrer » is advice the start button itself still refuses to take.
  if (input.awaitingConsigne) return "consigne";
  if (input.awaitingStart) return "awaitingStart";
  if (!input.text.trim()) return "empty";
  return "ready";
}

/**
 * The button's label and the line under it, per state.
 *
 * `note: null` for the two ordinary states — a panel that explains itself when
 * there is nothing to explain trains you to stop reading it, which is exactly
 * the habit the other three states need broken.
 */
export const DEV_SUBMIT_COPY: Record<DevSubmitState, { label: string; note: string | null }> = {
  ready: { label: DEV_PANEL_COPY.submit, note: null },
  empty: { label: DEV_PANEL_COPY.submit, note: null },
  consigne: {
    label: DEV_PANEL_COPY.submit,
    note: "L'examinateur donne la consigne. L'exposé partira dès qu'il aura fini.",
  },
  sending: { label: "Envoi…", note: "La partie démarre et l'exposé est remis." },
  closing: {
    label: DEV_PANEL_COPY.submit,
    note: "L'examinateur conclut la partie. Trop tard pour envoyer un exposé.",
  },
  // Unreachable from the exposé's panel, which starts the part itself — kept
  // honest rather than blank in case a refactor ever routes it here, because a
  // disabled button with no reason is #53's failure repeated.
  awaitingStart: {
    label: DEV_PANEL_COPY.submit,
    note: "La partie n'a pas commencé. Cliquez « Enregistrer ».",
  },
};

/** The débat's table (#142). Same states, the conversation's words. */
export const DEV_DEBATE_SUBMIT_COPY: Record<
  DevSubmitState,
  { label: string; note: string | null }
> = {
  ready: { label: DEV_DEBATE_PANEL_COPY.submit, note: null },
  empty: { label: DEV_DEBATE_PANEL_COPY.submit, note: null },
  consigne: {
    label: DEV_DEBATE_PANEL_COPY.submit,
    note: "L'examinateur donne la consigne. Le débat s'ouvrira ensuite avec « Enregistrer ».",
  },
  sending: { label: "Envoi…", note: "La réponse part vers l'examinateur." },
  closing: {
    label: DEV_DEBATE_PANEL_COPY.submit,
    note: "L'examinateur conclut l'épreuve. Trop tard pour répondre.",
  },
  awaitingStart: {
    label: DEV_DEBATE_PANEL_COPY.submit,
    note: "Le débat n'a pas commencé. Cliquez « Enregistrer » : l'examinateur posera sa première question.",
  },
};

/** Whether the button should refuse the press. Everything but `ready`. */
export function devSubmitDisabled(state: DevSubmitState): boolean {
  return state !== "ready";
}

/**
 * A sample exposé, for the « Exemple » button.
 *
 * Long enough that {@link SPOKEN_WORDS_PER_MINUTE} puts it clear of
 * `MONOLOGUE_FLOOR_SECONDS` (168 s) on its own, so the button produces a
 * monologue graded on its content rather than docked for its length.
 *
 * That is only half of a penalty-free sitting: the flat −3 fires when *either*
 * part is short, and the débat's own floor is 312 s. A typed sitting that is
 * meant to score without the penalty has to claim a débat as well — which is
 * what the duration field is for, since nobody is going to type five minutes of
 * argument twice.
 */
export function exampleExpose(subject: string): string {
  return [
    `Le sujet que j'ai à traiter est le suivant : ${subject}`,
    "",
    "Ce document soulève une question qui traverse aujourd'hui l'ensemble de la société, et qui me paraît d'autant plus intéressante qu'elle ne se prête pas à une réponse tranchée. Je vais d'abord présenter les arguments qui plaident en faveur de cette évolution, puis j'exposerai les réserves que l'on peut légitimement lui opposer, et je défendrai enfin une position personnelle qui tente de concilier les deux.",
    "",
    "Premièrement, il faut reconnaître que les partisans de cette évolution avancent des arguments solides, et il serait malhonnête de les écarter d'un revers de main. Le premier est celui de l'efficacité : le temps que l'on consacrait autrefois à des contraintes purement matérielles peut désormais être réinvesti ailleurs, dans le travail lui-même ou dans la vie personnelle. Le second argument, qui me paraît plus fort encore, est celui de l'autonomie. Chacun devient responsable de son organisation, de son rythme, de ses priorités, et cette confiance accordée produit souvent un engagement supérieur à celui qu'obtiendrait n'importe quel contrôle.",
    "",
    "On peut ajouter un troisième argument, moins souvent cité mais qui me semble décisif : celui de l'accessibilité. Les contraintes géographiques pesaient très lourd sur celles et ceux qui vivent loin des grands centres urbains, et cette évolution les allège considérablement. Des personnes qui, hier encore, devaient choisir entre leur région et leurs ambitions n'ont plus à trancher de la même manière. Il y a là un progrès réel, et je crois qu'on aurait tort de le minimiser au nom d'une nostalgie qui ne dit pas toujours son nom.",
    "",
    "Cependant, et j'en viens à ma deuxième partie, cette lecture me paraît incomplète. Ce que l'on gagne en souplesse, on le perd fréquemment en spontanéité. Les échanges informels, ceux qui naissent d'un couloir, d'une pause ou d'un déjeuner partagé, ne se décrètent pas dans un agenda : ils supposent une présence commune, non planifiée, dont on mesure rarement l'importance avant de l'avoir perdue. Or c'est souvent de ces moments-là que naissent les idées les plus fécondes et les solidarités les plus durables.",
    "",
    "La deuxième réserve tient aux inégalités. L'expérience que l'on fait de cette évolution dépend étroitement de conditions matérielles très inégalement réparties : la taille du logement, la qualité de l'équipement, la présence ou non d'enfants en bas âge, le calme dont on dispose. Autrement dit, une organisation conçue pour celles et ceux qui sont déjà les mieux installés produit mécaniquement de l'exclusion, tout en se présentant comme un progrès offert à tous. Ce décalage entre le discours et la réalité vécue me paraît être le point aveugle du débat.",
    "",
    "J'ajouterai une troisième réserve, plus difficile à formuler : celle du brouillage des frontières. Lorsque les repères qui séparaient les temps et les lieux s'effacent, la disponibilité tend à devenir permanente, et la liberté annoncée se retourne parfois en une contrainte diffuse dont il est très difficile de se protéger, faute précisément de frontière à invoquer.",
    "",
    "Pour ma part, et j'en arrive à ma troisième partie, je considère qu'il ne s'agit pas de choisir entre deux modèles opposés, mais d'organiser leur coexistence de manière réfléchie. Une solution raisonnable consisterait à réserver la présence commune aux moments qui la justifient réellement — la décision collective, l'accueil des nouveaux venus, la formation, la résolution des conflits — et à laisser le reste s'organiser plus librement. Ce qui compte alors n'est plus la proportion, mais la qualité de ce que l'on fait ensemble quand on est effectivement ensemble.",
    "",
    "Encore faudrait-il, et c'est ma condition principale, que ce cadre soit négocié plutôt qu'imposé. Une règle décidée sans les intéressés, même généreuse dans son intention, sera vécue comme une contrainte supplémentaire ; la même règle discutée collectivement devient un accord que chacun a intérêt à faire vivre. C'est une question de méthode autant que de contenu, et je crois qu'on la néglige trop souvent.",
    "",
    "En conclusion, je dirais que l'évolution décrite est souhaitable à condition d'être sérieusement accompagnée. Elle ne vaut que si elle demeure un choix véritable et non une norme déguisée, et si l'on se donne les moyens concrets d'en corriger les effets sur celles et ceux qu'elle fragilise. Ce n'est pas l'évolution en elle-même qu'il faut juger, mais la manière dont nous décidons de l'encadrer.",
  ].join("\n");
}

/**
 * A sample débat reply, for the same button on the other phase (#142).
 *
 * Unlike the exposé's sample it cannot answer the question actually asked —
 * the examiner improvises it — so it is the B2 move that fits ANY objection:
 * concede the point's strength, then hold the position with a reason. Short on
 * purpose: a débat turn is conversational, and the duration a typed sitting
 * needs is claimed through the field, not padded into the text.
 */
export function exampleDebateReply(): string {
  return [
    "C'est une objection sérieuse, et je reconnais volontiers que ma position ne règle pas tout.",
    "Mais je crois qu'elle reste la plus défendable : les inconvénients que vous soulevez tiennent moins au principe lui-même qu'à la manière dont on le met en œuvre, et c'est précisément pour cela que je plaide pour un encadrement négocié plutôt que pour un rejet en bloc.",
  ].join(" ");
}
