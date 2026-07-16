"use client";

import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

const Markdown = dynamic(() => import("@uiw/react-md-editor").then((m) => m.default.Markdown), {
  ssr: false,
});

export function PreviewDialog({
  updateId,
  title,
  body,
  category,
  onApprove,
}: {
  updateId: string;
  title: string;
  body: string;
  category: string;
  onApprove: (formData: FormData) => void;
}) {
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="outline">Preview</Button>} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Preview</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Badge variant="secondary" className="uppercase">
            {category}
          </Badge>
          <h2 className="text-lg font-semibold">{title}</h2>
          <div data-color-mode="light" className="text-sm">
            <Markdown source={body} />
          </div>
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">Close</Button>} />
          <form action={onApprove}>
            <input type="hidden" name="updateId" value={updateId} />
            <Button type="submit">Approve &amp; publish</Button>
          </form>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
