import type { OralTopic } from "@/lib/delf/topics";

/**
 * The sujet, set as the printed page it is on the day.
 *
 * On a real épreuve the candidate is handed a sheet with the document déclencheur
 * and the consigne under it, and the whole of the preparation is spent reading
 * it. That is why this is not a card with a paragraph in it: warm paper stock,
 * a serif at a reading size, justified with a measure wide enough to be read
 * rather than scanned, and the consigne ruled off below rather than run on — a
 * candidate who confuses the document with the instruction answers the wrong
 * question.
 *
 * The caps labels are the sheet's own, and they are `<h2>`/`<h3>` rather than
 * styled paragraphs: the two blocks are the structure of the subject, so they
 * are the structure of the page too.
 */
export function SubjectDocument({ topic }: { topic: OralTopic }) {
  return (
    <section className="border-paper-border bg-paper rounded-lg border p-6 sm:p-8">
      <h2 className="text-muted-foreground border-border border-b pb-2 text-[0.6875rem] font-semibold tracking-[0.16em] uppercase">
        Document déclencheur
      </h2>
      <p className="document-text mt-4">{topic.document}</p>

      <h3 className="text-muted-foreground border-border mt-8 border-b pb-2 text-[0.6875rem] font-semibold tracking-[0.16em] uppercase">
        Consigne
      </h3>
      <p className="document-text mt-4">{topic.consigne}</p>
    </section>
  );
}
