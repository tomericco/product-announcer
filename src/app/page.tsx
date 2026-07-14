import { requireSession } from "@/lib/session";

export default async function HomePage() {
  const session = await requireSession();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-2 p-8">
      <h1 className="text-2xl font-semibold">Product Announcer</h1>
      <p>Signed in as {session.user.email}</p>
      <p className="text-sm text-gray-500">Tenant: {session.user.tenantId}</p>
    </main>
  );
}
