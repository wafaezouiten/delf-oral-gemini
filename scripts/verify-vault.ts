/**
 * Verify the recording vault against the REAL Vercel Blob store (#98).
 *
 * The unit tests prove the policy around the vault — when `preserve` runs, what
 * a row says when it fails, what the playback route may serve. What they cannot
 * prove is that the credentials in `.env.local` reach an actual store and that
 * the port's three verbs round-trip real bytes. This does, the same bargain as
 * `verify:db`: exercise the real service, assert every step, delete what it
 * wrote.
 *
 * Everything goes under exam id 0 — no real sitting can have it (serials start
 * at 1), so a probe that crashes between store and discard leaves an orphan no
 * row will ever point at, not a recording on somebody's record.
 *
 *   pnpm verify:vault
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import assert from "node:assert/strict";

import { isRecordingVaultConfigured, recordingVault } from "../src/lib/storage/recording-vault";

async function main(): Promise<void> {
  if (!isRecordingVaultConfigured()) {
    console.error(
      "No vault configured: set BLOB_READ_WRITE_TOKEN (or VERCEL_OIDC_TOKEN + BLOB_STORE_ID) in .env.local — see .env.example.",
    );
    process.exit(1);
  }

  const vault = recordingVault();
  assert.ok(vault, "isRecordingVaultConfigured() said yes, so the vault must exist");

  // Recognisably fake audio: an OggS magic so a human finding the orphan knows
  // what it pretended to be, then a deterministic ramp. The vault does not parse
  // its bytes — `measureUploadedRecording` did that before anything is stored —
  // so the probe only has to be bytes that either round-trip exactly or don't.
  const bytes = new Uint8Array(64 * 1024);
  bytes.set([0x4f, 0x67, 0x67, 0x53]);
  for (let i = 4; i < bytes.length; i++) bytes[i] = i % 251;

  console.log("→ store: uploading a 64 KiB probe under exam 0…");
  const uri = await vault.store(0, "monologue", new Blob([bytes]), "audio/ogg");
  assert.match(uri, /^https:\/\//, "the uri is the store's, ready for oral_recordings.uri");
  console.log(`  kept at ${uri}`);

  try {
    console.log("→ open: reading it back…");
    const opened = await vault.open(uri);
    assert.ok(opened, "the bytes just stored must be openable");
    assert.equal(opened.status, 200);
    assert.equal(opened.byteSize, bytes.length, "the store reports the size we gave it");
    const returned = new Uint8Array(await new Response(opened.stream).arrayBuffer());
    assert.deepEqual(returned, bytes, "every byte comes back exactly as stored");
    console.log(`  ${returned.length} bytes back, identical, etag ${opened.etag}`);

    console.log("→ open with If-None-Match: expecting the bodiless 304…");
    const revalidated = await vault.open(uri, opened.etag);
    assert.ok(revalidated);
    assert.equal(
      revalidated.status,
      304,
      "an unchanged recording revalidates without moving its megabytes",
    );
    console.log("  304, as the playback route's Cache-Control: no-cache relies on");
  } finally {
    console.log("→ discard: deleting the probe…");
    await vault.discard(uri);
  }

  // Deletion can take a moment to propagate through the store's cache; what must
  // hold is that the uri stops answering, which is what a purged row relies on.
  for (let attempt = 1; ; attempt++) {
    const gone = await vault.open(uri);
    if (gone === null) break;
    assert.ok(attempt < 10, "a discarded recording must stop answering");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  console.log("  gone: open() now answers null");

  console.log(
    "\n✓ The vault round-trips against the real store. New sittings will keep their recordings.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
