import { currentUser } from "@clerk/nextjs/server";

import { ORAL_TOPICS } from "@/lib/delf/topics";
import { PHASE_DURATIONS } from "@/lib/delf/phases";
import { StartExamButton } from "./_components/start-exam-button";

/** Subject picker — the entry point to an exam. */
export default async function DashboardPage() {
  const user = await currentUser();
  const firstName = user?.firstName;

  const prepMinutes = PHASE_DURATIONS.preparation / 60;
  const monologueMinutes = PHASE_DURATIONS.monologue / 60;
  const debateMinutes = PHASE_DURATIONS.debate / 60;

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          {firstName ? `Bonjour ${firstName}, choisissez votre sujet` : "Choisissez votre sujet"}
        </h1>
        <p className="text-muted-foreground text-sm leading-relaxed">
          {prepMinutes} minutes de préparation, un monologue suivi de 5 à{" "}
          {monologueMinutes} minutes, puis un débat d&apos;environ {debateMinutes} minutes
          avec l&apos;examinateur. Prévoyez un endroit calme et un casque.
        </p>
      </div>

      <ul className="mt-8 space-y-3">
        {ORAL_TOPICS.map((topic) => (
          <li
            key={topic.slug}
            className="border-border bg-card rounded-xl border p-5"
          >
            <h2 className="text-base font-semibold">{topic.title}</h2>
            <p className="text-muted-foreground mt-2 line-clamp-3 text-sm leading-relaxed">
              {topic.document}
            </p>
            <div className="mt-4">
              <StartExamButton topicSlug={topic.slug} />
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
