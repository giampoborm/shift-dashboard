// Display helpers. These format for the screen ONLY — stored dates stay ISO
// "yyyy-MM-dd" everywhere (sorting, Dexie keys, rateForDate string compares all
// depend on that). Never feed a formatted string back into storage or comparisons.

/** ISO "yyyy-MM-dd" -> "dd.MM.yyyy" (German/European). Leaves non-ISO input untouched. */
export function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

/** ISO "yyyy-MM-dd" -> "dd.MM" (no year). For tight spots like the mobile hero. */
export function formatDateShort(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  return m ? `${m[3]}.${m[2]}` : iso;
}
