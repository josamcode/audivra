import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// Teach tailwind-merge about the custom type scale so `text-2xs` and colour utilities don't collide.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['2xs', 'xs', 'sm', 'base', 'lg', 'xl', '2xl'],
    },
  },
})

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
