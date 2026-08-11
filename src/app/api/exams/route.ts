/**
 * POST /api/exams — start an attempt.
 *
 * Creates the exam row up front rather than at the end, so an abandoned attempt
 * (tab closed mid-débat) still leaves a trace instead of vanishing.
 *
 * Degrades deliberately: with no `DATABASE_URL` the route hands back a local
 * id and the exam runs anyway. The whole Gemini experience is worth exercising
 * before a Neon database exists, and refusing to start an exam for want of a
 * row that only matters at the end would be the wrong trade.
 */

import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { getDb, isDatabaseConfigured, oralExams, oralTopics } from "@/lib/db";
import { findTopic } from "@/lib/delf/topics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const body = (await request.json().catch(() => null)) as { topicSlug?: string } | null;
  const slug = body?.topicSlug;
  if (!slug) return NextResponse.json({ error: "topicSlug manquant" }, { status: 400 });

  const topic = findTopic(slug);
  if (!topic) return NextResponse.json({ error: "Sujet inconnu" }, { status: 404 });

  if (!isDatabaseConfigured()) {
    return NextResponse.json({ examId: `local-${Date.now()}`, persisted: false });
  }

  try {
    const db = getDb();

    // The catalogue lives in code; the table is a mirror so exams can reference
    // a stable row. Upsert on first use rather than requiring a seed script.
    const existing = await db
      .select({ id: oralTopics.id })
      .from(oralTopics)
      .where(eq(oralTopics.slug, slug))
      .limit(1);

    const topicId =
      existing[0]?.id ??
      (
        await db
          .insert(oralTopics)
          .values({
            slug: topic.slug,
            title: topic.title,
            document: topic.document,
            consigne: topic.consigne,
          })
          .returning({ id: oralTopics.id })
      )[0].id;

    const [exam] = await db
      .insert(oralExams)
      .values({ userId, topicId, phase: "preparation" })
      .returning({ id: oralExams.id });

    return NextResponse.json({ examId: String(exam.id), persisted: true });
  } catch (error) {
    console.error("[exams] could not create exam:", error);
    // A database outage must not block a candidate mid-session.
    return NextResponse.json({ examId: `local-${Date.now()}`, persisted: false });
  }
}
