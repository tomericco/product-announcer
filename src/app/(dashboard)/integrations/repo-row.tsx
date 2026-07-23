"use client";

import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
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

export function RepoRow({
  index,
  fullName,
  branches,
  defaultBranch,
  defaultChecked,
}: {
  index: number;
  fullName: string;
  branches: string[];
  defaultBranch: string;
  defaultChecked: boolean;
}) {
  const [branch, setBranch] = useState(defaultBranch);
  const [open, setOpen] = useState(false);

  return (
    <div className="flex items-center gap-3">
      <input type="hidden" name={`repo-${index}-fullName`} value={fullName} />
      <input type="hidden" name={`repo-${index}-branch`} value={branch} />
      <label className="flex flex-1 items-center gap-2 text-sm">
        <input
          type="checkbox"
          name={`repo-${index}-selected`}
          defaultChecked={defaultChecked}
          className="size-4 rounded border-input"
        />
        {fullName}
      </label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger render={<Button type="button" variant="outline" role="combobox" className="w-44 justify-between font-normal" />}>
          <span className="truncate">{branch || "Select branch"}</span>
          <ChevronsUpDown className="size-4 opacity-50" />
        </PopoverTrigger>
        <PopoverContent className="w-56 p-0">
          <Command>
            <CommandInput placeholder="Search branches…" />
            <CommandList>
              <CommandEmpty>No branch found.</CommandEmpty>
              <CommandGroup>
                {branches.map((b) => (
                  <CommandItem
                    key={b}
                    value={b}
                    onSelect={(value) => {
                      setBranch(value);
                      setOpen(false);
                    }}
                  >
                    <Check className={cn("mr-2 size-4", branch === b ? "opacity-100" : "opacity-0")} />
                    {b}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
