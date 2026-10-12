import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Joins class names; a later Tailwind utility replaces an earlier one of the same property. */
export function cn(...values: readonly ClassValue[]): string { return twMerge(clsx(values)); }
