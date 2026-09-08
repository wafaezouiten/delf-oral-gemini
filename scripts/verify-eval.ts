/**
 * Verify the /25 evaluation pipeline against the real model.
 *
 * Two things are being checked, and they are different:
 *
 *   1. **Plumbing.** Does a transcript go in and a well-formed, legal grille
 *      score come out — five bands from {0,1,3,5}, summing to the /25 we
 *      recompute ourselves? Including through the audio path (Files API upload).
 *
 *   2. **Discrimination.** Does a deliberately weak performance actually score
 *      lower than a strong one? A corrector that returns plausible prose and the
 *      same 3/5 for everything is worse than useless, because it looks fine.
 *
 * This is NOT the §20 phonology experiment. Audio here is synthetic, and is used
 * only to prove the upload path works end to end. Nothing about the reliability
 * of audio-based phonology scoring can be concluded from it — see
 * docs/AUDIO_EVALUATION.md.
 *
 *   pnpm verify:eval
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { GoogleGenAI, Modality } from "@google/genai";

import { ORAL_CRITERIA } from "../src/lib/delf/criteria";
import { GRILLE_BANDS } from "../src/lib/delf/grille";
import { FULL_DEVELOPMENT_SECONDS, criteriaToScore25 } from "../src/lib/delf/orale-rubric";
import { ORAL_TOPICS } from "../src/lib/delf/topics";
import type { TranscriptEntry } from "../src/lib/delf/transcript";
import { evaluateExam } from "../src/lib/gemini/evaluate";

const TOPIC = ORAL_TOPICS[0];

function entry(
  phase: "monologue" | "debate",
  speaker: "candidate" | "examiner",
  text: string,
  timestamp: number,
): TranscriptEntry {
  return { phase, speaker, text, timestamp };
}

/** A competent B2 performance: structured, connected, defends under pressure. */
const STRONG: TranscriptEntry[] = [
  entry(
    "monologue",
    "candidate",
    "Le document soulève la question de savoir si le télétravail a réellement amélioré la vie des salariés. Je défendrai l'idée qu'il constitue un progrès, à condition qu'il soit encadré. Premièrement, la suppression des trajets quotidiens rend aux salariés un temps considérable, souvent plus d'une heure par jour, qu'ils peuvent consacrer à leur famille ou à leur santé. Deuxièmement, le travail à distance a permis à des personnes qui en étaient exclues, notamment celles en situation de handicap ou vivant loin des grandes métropoles, d'accéder à des postes qualifiés. Cela dit, je ne nie pas les risques : l'effacement de la frontière entre vie professionnelle et vie privée est réel, et l'isolement des jeunes recrues me paraît le danger le plus sérieux, car on apprend son métier en observant ses collègues. C'est pourquoi je plaide pour un modèle hybride, deux ou trois jours sur site, qui préserve le collectif tout en conservant la souplesse acquise. En conclusion, le télétravail n'est ni un remède ni un piège : c'est un outil dont la valeur dépend entièrement de la manière dont les entreprises choisissent de l'encadrer.",
    1000,
  ),
  entry(
    "debate",
    "examiner",
    "Vous dites que le télétravail rend du temps aux salariés. Pourtant, plusieurs études montrent que ce temps gagné est immédiatement réinvesti dans le travail, et que les journées s'allongent. Votre argument ne se retourne-t-il pas contre vous ?",
    500000,
  ),
  entry(
    "debate",
    "candidate",
    "Votre objection est juste, et elle vise un point faible réel. Je nuancerais toutefois : ce que vous décrivez n'est pas un effet du télétravail lui-même, mais d'une culture managériale qui mesure l'engagement à la disponibilité. La preuve, c'est que les entreprises qui ont instauré un droit à la déconnexion effectif, comme certaines entreprises portugaises depuis la loi de 2021, n'observent pas cet allongement. Autrement dit, l'outil révèle un problème préexistant plutôt qu'il ne le crée.",
    520000,
  ),
  entry(
    "debate",
    "examiner",
    "Admettons. Mais votre modèle hybride ne crée-t-il pas une inégalité nouvelle, entre ceux dont le métier est télétravaillable et les autres ?",
    560000,
  ),
  entry(
    "debate",
    "candidate",
    "Si, et c'est l'argument qui me fait le plus hésiter. Un caissier ou une infirmière ne bénéficieront jamais de cette souplesse. Mais j'en tire une conclusion différente de la vôtre : plutôt que de renoncer à un progrès pour ceux qui peuvent en bénéficier, il faudrait chercher l'équivalent pour les métiers de terrain, par exemple la semaine de quatre jours ou une réelle maîtrise des plannings. Refuser une avancée parce qu'elle ne profite pas à tous immédiatement me semble un raisonnement dangereux.",
    590000,
  ),
];

/** A weak performance: thin, repetitive, hesitant, concedes without defending. */
const WEAK: TranscriptEntry[] = [
  entry(
    "monologue",
    "candidate",
    "Euh… alors le document il parle du télétravail. Euh… moi je pense que c'est bien. Parce que… euh… c'est bien pour les gens. Ils peuvent rester à la maison. Euh… c'est pratique. Et aussi… euh… comment dire… il y a pas le transport. Le transport c'est fatigant. Donc c'est bien. Euh… mais aussi c'est pas bien parce que… euh… on est seul. Voilà. Je pense que c'est bien.",
    1000,
  ),
  entry(
    "debate",
    "examiner",
    "Vous dites que le télétravail est pratique parce qu'il supprime les transports. Mais ne pensez-vous pas que l'isolement annule ce bénéfice ?",
    200000,
  ),
  entry("debate", "candidate", "Euh… oui. Vous avez raison. C'est vrai.", 210000),
  entry(
    "debate",
    "examiner",
    "Vous abandonnez donc votre position ? Pouvez-vous tout de même défendre l'idée de départ ?",
    230000,
  ),
  entry("debate", "candidate", "Euh… je sais pas. Peut-être. C'est difficile.", 240000),
];

/**
 * A deliberately UNEVEN performance: strong ideas and a well-defended position,
 * carried by conspicuously broken grammar.
 *
 * This is the fixture that matters. A corrector which forms one global
 * impression and stamps it across all five criteria will score this uniformly;
 * a corrector genuinely applying the grille should split it — high on
 * réalisation de la tâche and interaction, low on morphosyntaxe. Without this
 * case, "strong scores high and weak scores low" is equally consistent with the
 * model just measuring overall vibe.
 */
const MIXED: TranscriptEntry[] = [
  entry(
    "monologue",
    "candidate",
    "Le document il pose la question du télétravail. Moi je pense que c'est un progrès mais il faut encadrer. Premièrement, les salariés ils gagne beaucoup de temps parce que il y a pas les transports, et ce temps il est rendu à la famille. Deuxièmement, des personnes qui avant elles pouvait pas travailler, par exemple les personnes handicapées ou qui habite loin des villes, maintenant elles peut accéder à des postes qualifiés. C'est une vraie ouverture. Mais je vois aussi le danger : les jeunes qui commence, ils apprend le métier en regardant les collègues, et si ils reste à la maison ils apprend rien. Donc moi je défends le modèle hybride, deux ou trois jours au bureau, comme ça on garde le collectif et aussi la souplesse. Pour conclure, le télétravail c'est pas un remède et c'est pas un piège, ça dépend comment les entreprises elles l'organise.",
    1000,
  ),
  entry(
    "debate",
    "examiner",
    "Vous dites que le télétravail rend du temps aux salariés. Mais des études montrent que ce temps est réinvesti dans le travail et que les journées s'allongent. Votre argument ne se retourne-t-il pas contre vous ?",
    400000,
  ),
  entry(
    "debate",
    "candidate",
    "Votre objection elle est juste, je le reconnais. Mais je pense que ce que vous décrivez c'est pas la faute du télétravail, c'est la faute d'une culture du management qui mesure l'engagement avec la disponibilité. La preuve c'est que les entreprises qui ont mis un vrai droit à la déconnexion, ils observe pas ce problème. Donc l'outil il révèle un problème qui existait déjà, il le crée pas.",
    420000,
  ),
  entry(
    "debate",
    "examiner",
    "Admettons. Mais votre modèle hybride ne crée-t-il pas une inégalité entre ceux dont le métier est télétravaillable et les autres ?",
    460000,
  ),
  entry(
    "debate",
    "candidate",
    "Oui, et c'est l'argument qui me gêne le plus, je vais pas le nier. Une infirmière elle aura jamais cette souplesse. Mais moi j'en tire une conclusion différente de vous : au lieu de refuser le progrès pour ceux qui peuvent en profiter, il faut chercher l'équivalent pour les métiers de terrain, par exemple la semaine de quatre jours ou la maîtrise des plannings. Refuser une avancée parce que tout le monde il en profite pas tout de suite, pour moi c'est un raisonnement dangereux.",
    490000,
  ),
];

async function synthesiseWav(text: string): Promise<Blob | null> {
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ role: "user", parts: [{ text }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
      },
    });
    const data = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!data) return null;
    const buf = Buffer.from(data, "base64");
    const pcm = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

    // 44-byte WAV header around 24 kHz mono PCM16.
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + pcm.byteLength, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(24000, 24);
    header.writeUInt32LE(24000 * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(pcm.byteLength, 40);

    return new Blob([header, Buffer.from(pcm)], { type: "audio/wav" });
  } catch {
    return null;
  }
}

const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
function record(name: string, pass: boolean, detail: string) {
  checks.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}\n        ${detail}\n`);
}

async function main() {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");

  console.log("\n1. Grading a strong and a weak B2 performance from transcript\n");

  const strong = await evaluateExam({
    mode: "text",
    topic: TOPIC,
    transcript: STRONG,
    monologueSeconds: FULL_DEVELOPMENT_SECONDS.monologue + 20,
    debateSeconds: FULL_DEVELOPMENT_SECONDS.debate + 220,
  });
  const weak = await evaluateExam({
    mode: "text",
    topic: TOPIC,
    transcript: WEAK,
    monologueSeconds: FULL_DEVELOPMENT_SECONDS.monologue + 20,
    debateSeconds: FULL_DEVELOPMENT_SECONDS.debate + 220,
  });

  const show = (label: string, r: typeof strong) =>
    `${label}: ${r.score25}/25 [` +
    ORAL_CRITERIA.map((k) => `${k.slice(0, 4)}=${r.criteria[k]}`).join(" ") +
    `]`;

  console.log(`        ${show("strong", strong)}`);
  console.log(`        ${show("weak  ", weak)}\n`);

  const allLegal = [strong, weak].every((r) =>
    ORAL_CRITERIA.every((k) => (GRILLE_BANDS as readonly number[]).includes(r.criteria[k])),
  );
  record(
    "every criterion lands on a legal grille band (0/1/3/5)",
    allLegal,
    "no 2s or 4s survived into a stored score",
  );

  const arithmeticOk = [strong, weak].every((r) => criteriaToScore25(r.criteria) === r.rawScore25);
  record(
    "the /25 is recomputed from the bands, not taken from the model",
    arithmeticOk,
    `model totals were ${strong.modelTotal25} and ${weak.modelTotal25}; ` +
      `we independently computed ${strong.rawScore25} and ${weak.rawScore25}`,
  );

  record(
    "a weak performance scores below a strong one",
    weak.score25 < strong.score25,
    `strong ${strong.score25}/25 vs weak ${weak.score25}/25 (gap of ${strong.score25 - weak.score25})`,
  );

  // The regression this fixture caught once, now asserted on every run (#189).
  // WEAK is a real if poor monologue beside a débat of four monosyllables —
  // exactly the shape that satisfied « CAS LIMITE » on a literal reading and
  // came back 0 on all five criteria, including the two language criteria the
  // exposé gives real evidence for. It cost an API call to find and nothing to
  // keep: the correction is already in hand, so this is a `record()` and not a
  // fourth call.
  const weakLanguage = ["lexique", "morphosyntaxe"] as const;
  record(
    "an evaluable monologue is not zeroed by a near-empty débat",
    weakLanguage.some((criterion) => weak.criteria[criterion] > 0),
    weakLanguage.map((criterion) => `${criterion}=${weak.criteria[criterion]}`).join(" ") +
      ` — 0 on both would mean the corrector read one empty part as an empty sitting`,
  );

  // The discriminating case: rich argumentation carried by broken grammar.
  const mixed = await evaluateExam({
    mode: "text",
    topic: TOPIC,
    transcript: MIXED,
    monologueSeconds: FULL_DEVELOPMENT_SECONDS.monologue + 20,
    debateSeconds: FULL_DEVELOPMENT_SECONDS.debate + 220,
  });
  console.log(`        ${show("mixed ", mixed)}\n`);

  record(
    "criteria are scored independently, not as one global impression",
    new Set(ORAL_CRITERIA.map((k) => mixed.criteria[k] as number)).size > 1,
    `an uneven performance produced ${new Set(ORAL_CRITERIA.map((k) => mixed.criteria[k] as number)).size} ` +
      `distinct bands: réalisation=${mixed.criteria.realisationTache}, ` +
      `interaction=${mixed.criteria.interaction}, morphosyntaxe=${mixed.criteria.morphosyntaxe}`,
  );

  record(
    "broken grammar is penalised without dragging down argumentation",
    mixed.criteria.morphosyntaxe < mixed.criteria.realisationTache,
    `morphosyntaxe ${mixed.criteria.morphosyntaxe}/5 sits below ` +
      `réalisation de la tâche ${mixed.criteria.realisationTache}/5, as the grille intends`,
  );

  record(
    "feedback is populated and in French",
    strong.feedback.appreciationGlobale.length > 40 &&
      strong.feedback.pointsForts.length > 0 &&
      strong.feedback.axesPrioritaires.length > 0,
    `"${strong.feedback.appreciationGlobale.slice(0, 120)}…"`,
  );

  const noDashes = [strong, weak].every(
    (r) => !r.feedback.appreciationGlobale.includes("—") && !r.feedback.conseil.includes("—"),
  );
  record(
    "feedback contains no em dashes (house style)",
    noDashes,
    noDashes ? "clean" : "an em dash reached candidate-facing copy",
  );

  console.log("2. The audio path (plumbing only, synthetic speech)\n");
  const wav = await synthesiseWav(
    "Euh, alors, le document il parle du télétravail. Moi je pense que c'est bien parce que c'est pratique.",
  );
  if (!wav) {
    record("audio evaluation completes via the Files API", false, "TTS unavailable, skipped");
  } else {
    try {
      const audioResult = await evaluateExam({
        mode: "audio",
        topic: TOPIC,
        transcript: WEAK,
        monologueSeconds: FULL_DEVELOPMENT_SECONDS.monologue + 20,
        debateSeconds: FULL_DEVELOPMENT_SECONDS.debate + 220,
        audio: wav,
      });
      record(
        "audio evaluation completes via the Files API",
        audioResult.score25 >= 0 && audioResult.mode === "audio",
        `uploaded ${(wav.size / 1024).toFixed(0)} KB, scored ${audioResult.score25}/25 in ` +
          `${audioResult.latencySeconds.toFixed(1)}s (text run took ${weak.latencySeconds.toFixed(1)}s). ` +
          `Phonologie: ${audioResult.criteria.phonologie}/5 vs ${weak.criteria.phonologie}/5 from text. ` +
          `NOT a phonology finding: the audio is synthetic.`,
      );
    } catch (error) {
      record("audio evaluation completes via the Files API", false, String(error).slice(0, 200));
    }
  }

  console.log("3. The duration rule, through the real corrector\n");

  // The same strong transcript, against a débat that produced 40 seconds and a
  // monologue that ran its full development time. The rubric — not the model,
  // which is never told the rule — has to notice, charge the débat alone, and
  // charge it to « interaction » (#189).
  const shortSitting = await evaluateExam({
    mode: "text",
    topic: TOPIC,
    transcript: STRONG,
    monologueSeconds: FULL_DEVELOPMENT_SECONDS.monologue + 20,
    debateSeconds: 40,
  });

  const debateCharge = shortSitting.durationCharges[0];

  record(
    "the short part is charged, and the part that was short is named",
    shortSitting.durationPenalty > 0 &&
      shortSitting.shortParts.length === 1 &&
      shortSitting.shortParts[0] === "debate" &&
      shortSitting.durationTiers.monologue === "full" &&
      shortSitting.durationTiers.debate === "strong",
    `penalty ${shortSitting.durationPenalty}, short: [${shortSitting.shortParts.join(", ")}], ` +
      `tiers ${JSON.stringify(shortSitting.durationTiers)} ` +
      `(débat 40s against a ${FULL_DEVELOPMENT_SECONDS.debate}s full-development time)`,
  );

  record(
    "the charge comes off interaction, and off nothing else",
    shortSitting.durationCharges.length === 1 &&
      debateCharge?.criterion === "interaction" &&
      debateCharge?.points === shortSitting.durationPenalty,
    debateCharge
      ? `${debateCharge.criterion} ${debateCharge.from} → ${debateCharge.to} ` +
          `(${debateCharge.points} point(s)), lexique/morphosyntaxe/phonologie untouched`
      : "no charge was recorded",
  );

  record(
    "the three stored scores tell one story",
    shortSitting.score25 === Math.max(shortSitting.rawScore25 - shortSitting.durationPenalty, 0),
    `${shortSitting.rawScore25} − ${shortSitting.durationPenalty} = ${shortSitting.score25}/25, ` +
      `which is what evaluations_score_25_check asserts in SQL`,
  );

  record(
    "a full sitting of the same transcript is not charged at all",
    strong.durationPenalty === 0 &&
      strong.shortParts.length === 0 &&
      strong.durationCharges.length === 0,
    `the same transcript over ${FULL_DEVELOPMENT_SECONDS.monologue + 20}s + ` +
      `${FULL_DEVELOPMENT_SECONDS.debate + 220}s ` +
      `scored ${strong.score25}/25 with no penalty`,
  );

  const passed = checks.filter((c) => c.pass).length;
  console.log(`${"=".repeat(64)}\n${passed}/${checks.length} checks passed\n`);
  process.exitCode = passed === checks.length ? 0 : 1;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
