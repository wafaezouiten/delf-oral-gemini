import { SignIn } from "@clerk/nextjs";

/** Catch-all so Clerk can own its own sub-routes (factor-two, reset, SSO callback). */
export default function SignInPage() {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <SignIn />
    </main>
  );
}
