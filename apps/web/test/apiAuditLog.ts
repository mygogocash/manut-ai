// The API's audit log module, read as text. It cannot be imported: it runs on Durable Object storage and pulls in the
// Worker's other modules, none of which belong in the console's bundle or its jsdom tests. `?raw` hands a test the file's own
// words, so what it holds the console to is the API as it stands, not what someone remembered of it.
import auditLogSource from "../../api/src/audit-log.ts?raw";

/// The string literals of one `export const NAME = [ ... ] as const;` in the API's audit log, comments left out.
export function apiList(name: string): string[] {
  const start = auditLogSource.indexOf(`export const ${name} = [`);
  const end = auditLogSource.indexOf("] as const;", start);
  if (start < 0 || end < 0) {
    throw new Error(`apps/api/src/audit-log.ts no longer has "export const ${name} = [ ... ] as const;": teach this test where the list went`);
  }
  const body = auditLogSource.slice(start, end).replace(/\/\/.*$/gm, "");
  return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

/// The kinds of the API's `AuditActor` union: the text between its declaration and the next export.
export function apiActorKinds(): string[] {
  const start = auditLogSource.indexOf("export type AuditActor =");
  const end = auditLogSource.indexOf("export type AuditEntry", start);
  if (start < 0 || end < 0) throw new Error("apps/api/src/audit-log.ts no longer declares `AuditActor` before `AuditEntry`");
  return [...auditLogSource.slice(start, end).matchAll(/\{ kind: "([a-z_]+)"/g)].map((match) => match[1]!);
}
