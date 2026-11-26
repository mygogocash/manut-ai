// Looking over every file before a skill is published or installed (item 84). A skill tells a coding agent what to do and can hold
// scripts, so the ask's Yes is reachable only once every file of it was opened on the page, or the person ticked "I have looked at
// every file". This keeps that record for one ask: the files it showed, the ones opened, and the tick. The ask modules
// (artifactAsks.ts, skillInstallAsks.ts) refuse a Yes while it is not done, so a button the page forgot to hold back still settles
// nothing.
export class FileReview {
  private readonly files: ReadonlySet<string>;
  private readonly seen = new Set<string>();
  private ticked = false;

  constructor(keys: readonly string[]) {
    this.files = new Set(keys);
  }

  /** The person opened file `key`; a key the ask did not show counts for nothing. */
  open(key: string): void {
    if (this.files.has(key)) this.seen.add(key);
  }

  /** The tick "I have looked at every file", on or off. */
  tick(on: boolean): void {
    this.ticked = on;
  }

  opened(key: string): boolean {
    return this.seen.has(key);
  }

  get lookedAtAll(): boolean {
    return this.ticked;
  }

  /** Every file opened, or the tick on. An ask with no files is never done. */
  get done(): boolean {
    return this.files.size > 0 && (this.ticked || [...this.files].every((key) => this.seen.has(key)));
  }
}
