import { Kicker } from "@/app/_components/po/tag";
import { EXPOSE_PLAN } from "@/lib/ui/po-player-view";

/**
 * « Votre plan » — the four beats of the exposé, kept in front of the candidate
 * while they deliver it.
 *
 * The list is `EXPOSE_PLAN`, the same one the préparation rail prints as
 * « Structure attendue ». That is the point of it being one list: the plan you
 * are given thirty minutes to internalise is the plan still on screen when you
 * start speaking, rather than something you were shown once and then had to
 * remember under a running clock.
 *
 * The exposé only. During the débat the candidate is answering objections, not
 * following a script, and the screen gives that space to the exchange instead.
 *
 * It sits in a column beside the sujet rather than under it (#59), so scrolling
 * back through the document does not take the plan off screen with it.
 */
export function ExposePlan() {
  return (
    <section aria-labelledby="plan-title" className="border-border bg-card rounded-lg border p-5">
      <Kicker>
        <span id="plan-title">Votre plan</span>
      </Kicker>
      <ol className="mt-3 flex flex-col gap-3">
        {EXPOSE_PLAN.map((step, index) => (
          <li key={step.title} className="flex items-start gap-3">
            <span
              className="bg-primary-subtle text-primary tabular mt-px flex size-5 shrink-0 items-center justify-center rounded-md text-[0.625rem] font-semibold"
              aria-hidden
            >
              {index + 1}
            </span>
            <div className="min-w-0">
              <p className="text-[0.8125rem] font-semibold">{step.title}</p>
              <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">{step.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
