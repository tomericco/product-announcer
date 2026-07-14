"use client";

import { useRef } from "react";

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
  const dialogRef = useRef<HTMLDialogElement>(null);

  return (
    <>
      <button type="button" className="border px-4 py-2" onClick={() => dialogRef.current?.showModal()}>
        Preview
      </button>
      <dialog ref={dialogRef} className="w-full max-w-md rounded-md border border-gray-300 p-0">
        <div className="flex items-center justify-between border-b border-gray-200 p-4">
          <span className="text-sm font-medium text-gray-900">Preview</span>
          <button
            type="button"
            className="text-sm text-gray-500"
            onClick={() => dialogRef.current?.close()}
          >
            Close
          </button>
        </div>
        <div className="space-y-2 p-5">
          <p className="text-xs uppercase text-gray-500">{category}</p>
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <p className="whitespace-pre-wrap text-sm text-gray-700">{body}</p>
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-200 p-4">
          <button type="button" className="border px-4 py-2" onClick={() => dialogRef.current?.close()}>
            Close
          </button>
          <form action={onApprove}>
            <input type="hidden" name="updateId" value={updateId} />
            <button type="submit" className="bg-gray-900 px-4 py-2 text-white">
              Approve &amp; publish
            </button>
          </form>
        </div>
      </dialog>
    </>
  );
}
