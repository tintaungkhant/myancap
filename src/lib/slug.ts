/**
 * Turn a video title into a safe lowercase snake_case filename base.
 * Falls back to `fallback` (e.g. the YouTube id) when the title has no
 * usable [a-z0-9] characters.
 */
const MAX_LEN = 80;

export function slugify(title: string, fallback: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_") // any run of non-alphanumerics -> one underscore
    .replace(/^_+|_+$/g, "") // trim leading/trailing underscores
    .slice(0, MAX_LEN)
    .replace(/_+$/g, ""); // re-trim if the slice cut mid-underscore

  return slug.length > 0 ? slug : fallback;
}
