import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Adapt an async handler to a void-returning event handler, so it can be passed
 * to onClick/onChange without tripping no-misused-promises. Errors are logged;
 * handlers themselves surface user-facing errors via component state.
 */
export function run(fn: () => Promise<void>): () => void {
  return () => {
    void fn().catch((e: unknown) => console.error(e));
  };
}
