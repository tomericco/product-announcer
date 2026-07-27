import { clsx, type ClassValue } from "clsx"
import { format } from "date-fns"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Day, full month name, 2-digit year — e.g. "27 July, 26". */
export function formatShortDate(date: Date): string {
  return format(date, "d MMMM, yy")
}
