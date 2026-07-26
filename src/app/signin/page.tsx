import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SignInButtons } from "./signin-buttons";

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ callbackUrl?: string }> }) {
  const { callbackUrl } = await searchParams;
  const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Sign in to versional</CardTitle>
        </CardHeader>
        <CardContent>
          <SignInButtons callbackUrl={callbackUrl ?? "/"} googleEnabled={googleEnabled} />
        </CardContent>
      </Card>
    </div>
  );
}
