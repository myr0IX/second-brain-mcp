const TICKET_PATTERN = /\b[A-Z]{2,5}-\d{1,5}\b/g;

/** Uppercase-dash-number tokens that are standards, not tickets. */
const NOT_TICKETS = new Set(["UTF", "ISO", "SHA", "RFC", "ES", "HTTP", "TLS", "WCAG", "CVE"]);

/** Ticket ids (PROJ-123, ABC-7…) found in any of the given texts, deduplicated and sorted. */
export function extractTickets(...texts: (string | null | undefined)[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    for (const match of text?.match(TICKET_PATTERN) ?? []) {
      if (!NOT_TICKETS.has(match.split("-")[0] ?? "")) found.add(match);
    }
  }
  return [...found].sort();
}
