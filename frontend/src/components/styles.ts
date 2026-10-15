// Class strings shared by more than one component. Kept as full literals so
// Tailwind's source scan still sees every class.

/** Text inputs: hairline box, no fill change on focus, just a brighter edge. */
export const field =
  'border border-rule-strong bg-bg px-2 py-1 text-text outline-none placeholder:text-text-dim focus:border-text-muted'

/**
 * Bracketed text buttons like [ - ] / [ + ] / [ filters ]. No resting colour
 * on purpose: callers add `text-text-muted` or `text-text`. Putting both on
 * one element doesn't work as "last one wins" — Tailwind decides by the
 * order of rules in its generated CSS, not the order in `className`.
 */
export const textButton = 'cursor-pointer whitespace-nowrap hover:text-text'
