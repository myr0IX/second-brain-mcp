/** Three Claude Code sessions on distinct topics, written in the transcript format the indexer reads. */
import fs from "node:fs";
import path from "node:path";

export type FixtureSession = {
  id: string;
  label: string;
  repo: string;
  /** Each turn is one user prompt followed by the agent's answer. */
  turns: { user: string; agent: string }[];
};

export const sessions: FixtureSession[] = [
  {
    id: "0f6a1c52-9a3e-4d7b-8c11-2b5e7d9f4a01",
    label: "invoice reminders",
    repo: "billing-app",
    turns: [
      {
        user: "Je relance mes clients à la main quand une facture n'est pas payée, et j'en oublie toujours une ou deux.",
        agent: "On peut ajouter une tâche planifiée qui liste chaque lundi les factures dont l'échéance est dépassée.",
      },
      {
        user: "Ajoute l'envoi automatique d'un mail de relance à J+7 puis J+15 après l'échéance.",
        agent: "C'est fait : un job quotidien envoie la relance au client et note la date du dernier rappel sur la facture.",
      },
      {
        user: "Il ne faut pas relancer une facture déjà réglée entre-temps.",
        agent: "Le job relit le statut de paiement juste avant l'envoi et ignore les factures marquées payées.",
      },
    ],
  },
  {
    id: "5b2d8e14-3c7f-4a69-9e02-71c4a8d6b3f2",
    label: "checkout retries",
    repo: "shop-frontend",
    turns: [
      {
        user: "The checkout fails intermittently when the payment provider times out.",
        agent: "The payment call has no retry; a single timeout aborts the order.",
      },
      {
        user: "Add a retry with exponential backoff on the payment call, at most three attempts.",
        agent: "Added a retry wrapper with backoff of 1 s, 2 s and 4 s, keyed by an idempotency key so the card is charged once.",
      },
      {
        user: "Show the customer a clear message if all attempts fail.",
        agent: "The checkout page now shows 'Payment could not be completed, you were not charged' and keeps the cart.",
      },
    ],
  },
  {
    id: "c93e7a20-6d15-4b8e-a4f7-0e8b2c5d1967",
    label: "onboarding emails",
    repo: "growth-service",
    turns: [
      {
        user: "New users sign up and never come back. Let's send a welcome email sequence.",
        agent: "I'll add a three-step onboarding sequence: welcome on day 0, tips on day 2, a check-in on day 7.",
      },
      {
        user: "Le deuxième mail doit montrer comment importer ses données.",
        agent: "Le mail du jour 2 contient maintenant un guide d'import en trois étapes avec des captures.",
      },
      {
        user: "Stop the sequence as soon as the user completes their first project.",
        agent: "The scheduler now checks the first-project event and cancels the remaining onboarding emails.",
      },
    ],
  },
];

function transcriptLines(session: FixtureSession): string[] {
  const cwd = `/home/dev/code/${session.repo}`;
  return session.turns.flatMap((turn, i) => {
    const timestamp = `2026-09-1${i}T09:00:00Z`;
    const base = { cwd, gitBranch: "main", timestamp, sessionId: session.id };
    return [
      JSON.stringify({ ...base, type: "user", uuid: `${session.id}-u${i}`, message: { content: turn.user } }),
      JSON.stringify({
        ...base,
        type: "assistant",
        uuid: `${session.id}-a${i}`,
        message: { content: [{ type: "text", text: turn.agent }] },
      }),
    ];
  });
}

/** Writes one `.jsonl` file per session under `<transcriptsDir>/<repo>/`. */
export function writeTranscripts(transcriptsDir: string): void {
  for (const session of sessions) {
    const dir = path.join(transcriptsDir, session.repo);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${session.id}.jsonl`), transcriptLines(session).join("\n"));
  }
}
