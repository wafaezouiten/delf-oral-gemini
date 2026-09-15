/**
 * What the two faces' scene decides (#234): how far the part has run as a
 * percentage of its length, and the one sentence a screen reader hears when
 * the floor changes hands — the visible status lines are `aria-hidden`, so
 * this is the only spoken account of whose turn it is.
 */

export function progressPercent(elapsed: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((Math.min(elapsed, total) / total) * 100));
}

export function turnAnnouncement(scene: {
  examinerSpeaking: boolean;
  examinerStatus: string;
  candidateRecording: boolean;
  candidateStatus: string;
}): string {
  if (scene.examinerSpeaking) return `L'examinateur parle. ${scene.examinerStatus}`;
  if (scene.candidateRecording) return `À vous de parler. ${scene.candidateStatus}`;
  return scene.examinerStatus;
}
