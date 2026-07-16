"use client";

import { toast } from "sonner";

/**
 * A <form> whose server action fires an animated success toast once it resolves.
 * Lets the server-rendered settings forms keep using plain Server Actions while
 * still confirming the save to the user.
 */
export function ToastForm({
  action,
  successMessage,
  className,
  children,
}: {
  action: (formData: FormData) => Promise<void> | void;
  successMessage: string;
  className?: string;
  children: React.ReactNode;
}) {
  async function handle(formData: FormData) {
    await action(formData);
    toast.success(successMessage);
  }

  return (
    <form action={handle} className={className}>
      {children}
    </form>
  );
}
