import { currentUser } from "@clerk/nextjs/server";

import { requireUserId } from "@/lib/auth/exam-guard";
import { ORAL_TOPICS } from "@/lib/delf/topics";
import { PHASE_DURATIONS } from "@/lib/delf/phases";
import { StartExamButton } from "./_components/start-exam-button";

/** Subject picker — the entry point to an exam. */
export default async function DashboardPage() {
  // On the page, not only in the layout: a layout does not re-render on a client
  // transition and does not decide whether this segment renders.
  await requireUserId();

  const user = await currentUser();
  const firstName = user?.firstName;

  const prepMinutes = PHASE_DURATIONS.preparation / 60;
  const monologueMinutes = PHASE_DURATIONS.monologue / 60;
  const debateMinutes = PHASE_DURATIONS.debate / 60;

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10">
      <div className="space-y-2">
        <p className="text-primary text-[0.6875rem] font-semibold tracking-[0.16em] uppercase">
          Choix du sujet
        </p>
        <h1 className="font-serif text-2xl leading-tight font-semibold tracking-tight">
          {firstName ? `Bonjour ${firstName}, choisissez votre sujet` : "Choisissez votre sujet"}
        </h1>
        <p className="text-muted-foreground max-w-2xl text-sm leading-relaxed">
          {prepMinutes} minutes de préparation, un monologue suivi de 5 à{" "}
          {monologueMinutes} minutes, puis un débat d&apos;environ {debateMinutes} minutes
          avec l&apos;examinateur. Prévoyez un endroit calme et un casque.
        </p>
      </div>

      {/* The subjects as a stack of sheets: the same paper the sujet is printed
          on inside the épreuve, so the thing the candidate picks and the thing
          they read are visibly the same object. */}
      <ul className="mt-8 space-y-4">
        {ORAL_TOPICS.map((topic, index) => (
          <li
            key={topic.slug}
            className="border-paper-border bg-paper rounded-lg border p-5 sm:p-6"
          >
            <p className="text-muted-foreground text-[0.6875rem] font-semibold tracking-[0.16em] uppercase">
              Sujet {index + 1}
            </p>
            <h2 className="font-serif mt-1 text-lg leading-snug font-semibold">
              {topic.title}
            </h2>
            <p className="text-muted-foreground mt-2 line-clamp-3 text-sm leading-relaxed">
              {topic.document}
            </p>
            <div className="mt-4">
              <StartExamButton topicSlug={topic.slug} topicTitle={topic.title} />
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
