import Link from "next/link";
import { ScanSearch } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import {
  EmptyState,
  EmptyStateActions,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@/components/ui/empty-state";

/**
 * "AI visibility is off" — the overview's state and the prompts page's, which
 * the spec's States table calls "same" and which were two copies of the same
 * markup differing in one clause.
 *
 * That clause is the prop: each page reassures the reader about what survives
 * being switched off, and they have different things to reassure them about.
 */
export function AiVisibilityOffEmptyState({ kept }: { kept: string }) {
  return (
    <EmptyState>
      <EmptyStateIcon>
        <ScanSearch />
      </EmptyStateIcon>
      <EmptyStateTitle>AI visibility is off</EmptyStateTitle>
      <EmptyStateDescription>
        Turn it on in Company to start measuring how often engines name you. {kept}
      </EmptyStateDescription>
      <EmptyStateActions>
        {/* A styled Link, not `Button render={<Link/>}`: Base UI's Button
            stamps role="button" on whatever it renders, and this only
            navigates. */}
        <Link href="/company#ai-visibility" className={buttonVariants({ variant: "outline" })}>
          Open Company
        </Link>
      </EmptyStateActions>
    </EmptyState>
  );
}
