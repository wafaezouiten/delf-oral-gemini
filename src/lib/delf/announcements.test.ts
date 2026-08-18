import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  ANNOUNCEMENTS,
  ANNOUNCEMENT_IDS,
  announcementDigest,
  spokenMinutes,
  type AnnouncementManifest,
} from "./announcements";
import { PHASE_DURATIONS } from "./phases";

const DIR = join(process.cwd(), "public", "announcements");

function manifest(): AnnouncementManifest {
  return JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")) as AnnouncementManifest;
}

describe("spoken consignes", () => {
  it("has one script per moment, and no more", () => {
    // Four, not five: the monologue ending and the débat opening are one moment.
    assert.deepEqual([...ANNOUNCEMENT_IDS], ["preparation", "monologue", "debate", "finished"]);
    for (const id of ANNOUNCEMENT_IDS) {
      const announcement = ANNOUNCEMENTS[id];
      assert.equal(announcement.id, id, "the record's key and the id must agree");
      assert.ok(announcement.title.length > 0);
      assert.ok(announcement.text.length > 80, `${id} is too short to be a consigne`);
      assert.equal(announcement.src, `/announcements/${id}.wav`);
    }
  });

  it("never uses an em dash or en dash", () => {
    // The same house rule the examiner's prompt follows, and for a stronger
    // reason: this text is both spoken by a TTS voice, which reads a dash as a
    // pause it was not given, and printed under the player.
    for (const id of ANNOUNCEMENT_IDS) {
      const { text, title } = ANNOUNCEMENTS[id];
      assert.ok(!`${text}${title}`.includes("—"), `${id} contains an em dash`);
      assert.ok(!`${text}${title}`.includes("–"), `${id} contains an en dash`);
    }
  });

  it("evaluates nothing and offers no help", () => {
    // An examiner reads a consigne. They do not encourage, coach or grade, and a
    // voice that did would be telling the candidate something about their
    // performance before it has happened.
    //
    // Word boundaries, not substrings: « prendre des notes » is the préparation
    // consigne doing its job, and a bare `includes("note")` calls it a grade.
    const forbidden = [
      /\bbravo\b/,
      /très bien\b/,
      /bonne chance\b/,
      /\bnote\b/,
      /\bnotée?\b/,
      // Plural only. « présenter votre point de vue » is the consigne itself;
      // « des points » would be a mark.
      /\bpoints\b/,
      /\bniveau\b/,
    ];
    for (const id of ANNOUNCEMENT_IDS) {
      const text = ANNOUNCEMENTS[id].text.toLowerCase();
      for (const pattern of forbidden) {
        assert.ok(!pattern.test(text), `${id} matches ${pattern}`);
      }
    }
  });

  it("speaks each phase's length as the state machine defines it", () => {
    // The point of `spokenMinutes`: the voice and the timer read the same
    // constant, so a phase whose duration changes cannot leave an examiner
    // promising the old one.
    assert.equal(spokenMinutes(PHASE_DURATIONS.preparation), "trente");
    assert.equal(spokenMinutes(PHASE_DURATIONS.monologue), "sept");
    assert.equal(spokenMinutes(PHASE_DURATIONS.debate), "treize");

    assert.match(
      ANNOUNCEMENTS.preparation.text,
      new RegExp(`${spokenMinutes(PHASE_DURATIONS.preparation)} minutes`),
    );
    assert.match(
      ANNOUNCEMENTS.monologue.text,
      new RegExp(`${spokenMinutes(PHASE_DURATIONS.monologue)} minutes`),
    );
    assert.match(
      ANNOUNCEMENTS.debate.text,
      new RegExp(`${spokenMinutes(PHASE_DURATIONS.debate)} minutes`),
    );
  });

  it("falls back to digits for a duration it has no word for", () => {
    // A TTS voice reads "37" correctly. An unlisted duration is less controlled
    // prosody, never a broken sentence.
    assert.equal(spokenMinutes(37 * 60), "37");
    // Rounded to whole minutes, and floored at one rather than at zero: a
    // consigne saying "vous disposez de zéro minutes" is worse than a rounded one.
    assert.equal(spokenMinutes(100), "deux");
    assert.equal(spokenMinutes(1), "une");
  });

  it("says what each moment is for", () => {
    // Each consigne has one job, and the words that do it are worth pinning: this
    // is the text a candidate who cannot hear the audio reads instead.
    assert.match(ANNOUNCEMENTS.preparation.text, /notes/, "must mention that notes are allowed");
    assert.match(
      ANNOUNCEMENTS.monologue.text,
      /interromprai pas/,
      "must promise the monologue will not be interrupted",
    );
    assert.match(ANNOUNCEMENTS.debate.text, /débat/, "must name the phase it opens");
    assert.match(ANNOUNCEMENTS.finished.text, /terminée/, "must say the épreuve is over");
  });

  describe("the committed clips", () => {
    it("has one generated clip per script, and the manifest names it", () => {
      const { clips, voice } = manifest();
      // The consignes must be read by the same voice that argues the débat
      // (`lib/gemini/live-config.ts`). Two voices would be a stranger experience
      // than no consigne at all.
      assert.equal(voice, "Charon");

      for (const id of ANNOUNCEMENT_IDS) {
        const clip = clips[id];
        assert.ok(clip, `no manifest entry for ${id}`);
        assert.equal(clip.file, `${id}.wav`);
        assert.ok(clip.seconds > 1, `${id} is suspiciously short`);
        // Nothing about the épreuve justifies a two-minute consigne, and a clip
        // that long is a model that started improvising rather than reading.
        assert.ok(clip.seconds < 60, `${id} runs ${clip.seconds}s`);

        const bytes = readFileSync(join(DIR, clip.file)).byteLength;
        assert.equal(bytes, clip.bytes, `${id}.wav is not the file the manifest describes`);
      }
    });

    it("fails when a script is reworded and the audio is not regenerated", () => {
      // The reason it is safe for the audio to be a committed artefact. A
      // reviewer cannot proofread a WAV in a diff, so this is what stops a
      // reworded consigne shipping still spoken the old way: edit the text above
      // without running `pnpm announcements`, and this test says so.
      const { clips } = manifest();
      for (const id of ANNOUNCEMENT_IDS) {
        assert.equal(
          clips[id].digest,
          announcementDigest(ANNOUNCEMENTS[id].text),
          `${id}: the script has changed since the clip was generated. Run \`pnpm announcements\`.`,
        );
      }
    });
  });

  describe("announcementDigest", () => {
    it("is stable, and changes when a single character does", () => {
      assert.equal(announcementDigest("Bonjour."), announcementDigest("Bonjour."));
      assert.notEqual(announcementDigest("Bonjour."), announcementDigest("Bonjour ."));
      // Eight hex characters, always — a padded 32-bit value.
      assert.match(announcementDigest(""), /^[0-9a-f]{8}$/);
      assert.match(announcementDigest(ANNOUNCEMENTS.debate.text), /^[0-9a-f]{8}$/);
    });
  });
});
