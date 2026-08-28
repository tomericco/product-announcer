"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

/**
 * Stealth-mode waitlist capture. Not wired to any backend or storage yet —
 * submitting just flips local UI state. Replace handleSubmit with a real
 * mutation when there's somewhere for the email to go.
 */
export function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!email) return;
    setSubmitted(true);
  }

  if (submitted) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        You&apos;re on the list. We&apos;ll be in touch.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex w-full max-w-sm flex-col gap-3 sm:flex-row">
      <Input
        type="email"
        required
        placeholder="you@company.com"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        aria-label="Email address"
        className="flex-1"
      />
      <Button type="submit">Join the waitlist</Button>
    </form>
  );
}
