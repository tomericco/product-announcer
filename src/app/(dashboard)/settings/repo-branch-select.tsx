"use client";

import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { updateRepoBranch } from "./actions";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export function RepoBranchSelect({
  repoId,
  currentBranch,
  branches,
}: {
  repoId: string;
  currentBranch: string;
  branches: string[];
}) {
  const [branch, setBranch] = useState(currentBranch);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // Always keep the currently watched branch selectable, even if the freshly
  // fetched list happens to miss it (e.g. a transient fetch error).
  const options = branch && !branches.includes(branch) ? [branch, ...branches] : branches;

  async function selectBranch(value: string) {
    setOpen(false);
    if (value === branch) return;

    const previous = branch;
    setBranch(value);
    setSaving(true);
    try {
      const formData = new FormData();
      formData.set("repoId", repoId);
      formData.set("branch", value);
      await updateRepoBranch(formData);
      toast.success("Watched branch updated");
    } catch {
      setBranch(previous); // revert on failure
    } finally {
      setSaving(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            role="combobox"
            disabled={saving}
            className="w-36 justify-between font-normal"
          />
        }
      >
        <span className="truncate">{branch || "Select branch"}</span>
        <ChevronsUpDown className="size-4 opacity-50" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <Command>
          <CommandInput placeholder="Search branches…" />
          <CommandList>
            <CommandEmpty>No branch found.</CommandEmpty>
            <CommandGroup>
              {options.map((b) => (
                <CommandItem key={b} value={b} onSelect={selectBranch}>
                  <Check className={cn("mr-2 size-4", branch === b ? "opacity-100" : "opacity-0")} />
                  {b}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
