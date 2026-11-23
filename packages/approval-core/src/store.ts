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

/// Where requests wait and are settled, exactly once each.
///
/// Every method is async so the same interface can sit on a Durable Object, a SQLite table or
/// memory. Implementations apply the pure transitions in `transitions.ts` and add only atomicity:
/// each call's read and write must be one step, so that of any number of concurrent decisions on
/// one request the first valid one settles it and every other one hears `already_decided` with
/// that first decision. In a Durable Object that is a method with no `await` between the read and
/// the write, or a storage transaction. In SQLite it is the conditional write described in
/// `transitions.ts`. `test/store-contract.ts` is the suite every implementation must pass.
///
/// Nothing a surface sends can widen what it may do. The running turn and attempt come from the
/// runtime, and the decider's role from the signed-in session. A client body supplies only the
/// request id, the option and the revision it showed.
export interface ApprovalStore {
  /// Asks a new request, at revision 1, created now.
  open(request: NewApprovalRequest): Promise<OpenResult>;

  /// Replaces what a pending request asks with its next revision.
  revise(requestId: string, next: RequestRevision): Promise<ReviseResult>;

  /// Takes a pending request back.
  withdraw(requestId: string): Promise<WithdrawResult>;

  /// Settles a request with `decision` if every rule allows it, and otherwise leaves it as it was.
  decide(decision: Decision, context: { readonly running: Running }): Promise<DecideResult>;

  /// The record as stored, or undefined. A copy: changing it changes nothing in the store.
  get(requestId: string): Promise<ApprovalRecord | undefined>;

  /// Where the request a surface shows at `seenRevision` stands now. Reads only.
  standing(requestId: string, view: { readonly seenRevision: number; readonly running: Running }): Promise<Standing>;
}
