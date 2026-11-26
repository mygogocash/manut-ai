import { requestStanding } from "./standing";
import type { ApprovalStore } from "./store";
import {
  decideTransition,
  openTransition,
  reviseTransition,
  withdrawTransition,
  type Transition,
} from "./transitions";
import type {
  ApprovalRecord,
  DecideResult,
  Decision,
  NewApprovalRequest,
  OpenResult,
  RequestRevision,
  ReviseResult,
  Running,
  Standing,
  WithdrawResult,
} from "./types";

/// An `ApprovalStore` held in memory, for tests, local development and a single-process client.
///
/// Each call reads the record, runs its transition and writes the result in one synchronous run
/// with no `await` in between. JavaScript runs one such run at a time, so no other call can see or
/// change the record half way, and the first valid decision is the only one that settles it.
/// Keep it that way: an `await` between the read and the write would let two decisions both read
/// `pending` and both settle.
///
/// Values are copied on the way in and on the way out, so a caller holding a request or a record
/// cannot change what is stored by changing its own copy. Records are never dropped, so a second
/// decision is always told who decided first rather than mistaken for an unknown request.
export class InMemoryApprovalStore implements ApprovalStore {
  readonly #records = new Map<string, ApprovalRecord>();
  readonly #now: () => number;

  /// `now` is the clock, injectable so tests can move time; it defaults to the system clock.
  constructor(options: { readonly now?: () => number } = {}) {
    this.#now = options.now ?? (() => Date.now());
  }

  async open(request: NewApprovalRequest): Promise<OpenResult> {
    const input = structuredClone(request);
    return this.#apply(input.id, (current) => openTransition(current, input, this.#now()));
  }

  async revise(requestId: string, next: RequestRevision): Promise<ReviseResult> {
    const input = structuredClone(next);
    return this.#apply(requestId, (current) => reviseTransition(current, input));
  }

  async withdraw(requestId: string): Promise<WithdrawResult> {
    return this.#apply(requestId, (current) => withdrawTransition(current, this.#now()));
  }

  async decide(decision: Decision, context: { readonly running: Running }): Promise<DecideResult> {
    const input = structuredClone(decision);
    const running = structuredClone(context.running);
    return this.#apply(input.requestId, (current) => decideTransition(current, input, { running, now: this.#now() }));
  }

  async get(requestId: string): Promise<ApprovalRecord | undefined> {
    return structuredClone(this.#records.get(requestId));
  }

  async standing(requestId: string, view: { readonly seenRevision: number; readonly running: Running }): Promise<Standing> {
    return structuredClone(
      requestStanding(this.#records.get(requestId), {
        seenRevision: view.seenRevision,
        running: view.running,
        now: this.#now(),
      }),
    );
  }

  /// The one place a record is read and written. It must stay synchronous; see the class comment.
  #apply<R>(requestId: string, step: (current: ApprovalRecord | undefined) => Transition<R>): R {
    const { result, next } = step(this.#records.get(requestId));
    if (next !== undefined) this.#records.set(requestId, next);
    return structuredClone(result);
  }
}
