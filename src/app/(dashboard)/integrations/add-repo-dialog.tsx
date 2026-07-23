"use client";

import { useState } from "react";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { addRepo } from "../settings/actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

type AvailableRepo = { fullName: string; defaultBranch: string; branches: string[] };

export function AddRepoDialog({ availableRepos }: { availableRepos: AvailableRepo[] }) {
  const [open, setOpen] = useState(false);
  const [repoOpen, setRepoOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [fullName, setFullName] = useState("");
  const [branch, setBranch] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const selected = availableRepos.find((r) => r.fullName === fullName);
  const branches = selected?.branches ?? [];

  function reset() {
    setFullName("");
    setBranch("");
  }

  async function onAdd(formData: FormData) {
    setSubmitting(true);
    try {
      await addRepo(formData);
      toast.success("Repo added");
      reset();
      setOpen(false);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger
        render={
          <Button variant="outline" disabled={availableRepos.length === 0}>
            <Plus />
            Add repo
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a repo</DialogTitle>
        </DialogHeader>
        <form action={onAdd} className="space-y-4">
          <input type="hidden" name="fullName" value={fullName} />
          <input type="hidden" name="branch" value={branch} />

          <div className="space-y-2">
            <Label>Repository</Label>
            <Popover open={repoOpen} onOpenChange={setRepoOpen}>
              <PopoverTrigger
                render={
                  <Button
                    type="button"
                    variant="outline"
                    role="combobox"
                    className="w-full justify-between font-normal"
                  />
                }
              >
                <span className="truncate">{fullName || "Select a repo"}</span>
                <ChevronsUpDown className="size-4 opacity-50" />
              </PopoverTrigger>
              <PopoverContent className="w-(--anchor-width) p-0">
                <Command>
                  <CommandInput placeholder="Search repos…" />
                  <CommandList>
                    <CommandEmpty>No repo found.</CommandEmpty>
                    <CommandGroup>
                      {availableRepos.map((r) => (
                        <CommandItem
                          key={r.fullName}
                          value={r.fullName}
                          onSelect={(value) => {
                            const picked = availableRepos.find((x) => x.fullName === value);
                            setFullName(value);
                            setBranch(picked?.defaultBranch ?? "");
                            setRepoOpen(false);
                          }}
                        >
                          <Check
                            className={cn("mr-2 size-4", fullName === r.fullName ? "opacity-100" : "opacity-0")}
                          />
                          {r.fullName}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>

          <div className="space-y-2">
            <Label>Branch</Label>
            <Popover open={branchOpen} onOpenChange={setBranchOpen}>
              <PopoverTrigger
                render={
                  <Button
                    type="button"
                    variant="outline"
                    role="combobox"
                    disabled={!fullName}
                    className="w-full justify-between font-normal"
                  />
                }
              >
                <span className="truncate">{branch || "Select branch"}</span>
                <ChevronsUpDown className="size-4 opacity-50" />
              </PopoverTrigger>
              <PopoverContent className="w-(--anchor-width) p-0">
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
                            setBranchOpen(false);
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

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline">Cancel</Button>} />
            <Button type="submit" disabled={!fullName || !branch || submitting}>
              {submitting ? "Adding…" : "Add repo"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
