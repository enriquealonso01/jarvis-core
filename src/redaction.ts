/**
 * ADR 005 — Supervisor payload redaction.
 *
 * The Supervisor runs on free/consumer provider accounts. Repository contents,
 * logs, and confidential attachments must never reach it: a confidential
 * project's body is reduced to metadata, and an unrouted body that *looks* like
 * code fails closed rather than being sent and apologised for afterwards.
 */

/**
 * Heuristic from ADR 005: fences, tracebacks, and repo file paths. Deliberately
 * conservative — a false positive costs one routing question, a false negative
 * sends source code to a consumer account.
 */
export function looksConfidential(text: string): boolean {
  if (!text) return false;
  const patterns: RegExp[] = [
    /```/, // fenced code block
    /\bTraceback \(most recent call last\)/i,
    /\bat [\w.$]+ \(.*:\d+:\d+\)/, // JS stack frame
    /^\s*(File|at)\s+".*",\s+line\s+\d+/m, // Python stack frame
    /\b[\w./-]+\.(ts|tsx|js|jsx|py|go|rs|java|rb|php|c|cpp|h|sql|sh)\b:\d+/, // path:line
    /^\s*(diff --git|--- a\/|\+\+\+ b\/|@@ )/m, // patch
    /\b(BEGIN|END) (RSA |OPENSSH |EC )?PRIVATE KEY\b/,
    /^\s*(import|from|export|package|func|class|def|const|SELECT|INSERT|UPDATE)\s+\S/m,
  ];
  return patterns.some((re) => re.test(text));
}

/** ADR 005 metadata_only payload. No bytes, no repo contents, no logs. */
export function metadataOnlyPayload(args: {
  projectId: string | null;
  projectName: string | null;
  confidentiality: string | null;
  channel: string;
  sender: string;
  occurredAt: string;
  text: string;
  attachmentCount?: number;
}): string {
  const bytes = Buffer.byteLength(args.text ?? "", "utf8");
  const summary = looksConfidential(args.text)
    ? "[redacted confidential body; open in that project's task context]"
    : (args.text ?? "").slice(0, 120);

  return [
    "[metadata_only event — the body is withheld from the Supervisor by policy]",
    `project: ${args.projectName ?? "unknown"} (${args.projectId ?? "none"})`,
    `confidentiality: ${args.confidentiality ?? "unknown"}`,
    `channel: ${args.channel} · sender: ${args.sender} · at: ${args.occurredAt}`,
    `size: ${bytes} bytes · attachments: ${args.attachmentCount ?? 0}`,
    `summary: ${summary}`,
    "You may attach this to the conversation, create a task, or store a note.",
    "A task worker with a profile allowlisted for that project reads the full event later.",
  ].join("\n");
}
