import { Card, CardContent } from "@/components/ui/card";
import { SignInButtons } from "./signin-buttons";
import { Logo } from "@/components/brand/logo";
import { safeCallbackUrl } from "@/lib/workspace/callback-url";

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ callbackUrl?: string }> }) {
  const { callbackUrl } = await searchParams;
  const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center gap-5 text-center">
          <Logo />
          <div className="space-y-1.5">
            <h1 className="font-heading text-4xl leading-[1.15] tracking-[0.015em] text-balance">
              Sign in to Versional
            </h1>
            <p className="text-muted-foreground text-sm">
              Continue to your signal feed.
            </p>
          </div>
        </div>
        <Card>
          <CardContent>
            <SignInButtons callbackUrl={safeCallbackUrl(callbackUrl)} googleEnabled={googleEnabled} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
