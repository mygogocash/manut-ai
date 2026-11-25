/// Why a step of the channel refused. Every refusal is one of these codes with a fixed sentence,
/// so no error, log line or crash report built from one can carry a key, a secret, a token, a tag
/// or any byte that arrived: the message is chosen from the table below and never formatted with
/// a value.
///
/// - `malformed`: bytes that are not the message expected at this step.
/// - `unauthenticated`: a proof, a tag or a commitment did not check out.
/// - `expired`: the pairing offer's two minutes are over.
/// - `used`: a one-use thing (a pairing offer, a handshake step) was used again.
/// - `unknown_device`: the Mac holds no key for the device a hello names.
/// - `too_large`: a frame or a whole message over its limit.
/// - `exhausted`: a counter reached its limit, so the session must be opened again.
/// - `closed`: the channel already refused something, or was closed, and takes nothing more.
/// - `busy`: too many decision challenges wait at once.
/// - `invalid`: the caller passed a value this package cannot use (a wrong length, a bad id).
export type RemoteChannelProblem =
  | "malformed"
  | "unauthenticated"
  | "expired"
  | "used"
  | "unknown_device"
  | "too_large"
  | "exhausted"
  | "closed"
  | "busy"
  | "invalid";

const MESSAGES: Readonly<Record<RemoteChannelProblem, string>> = {
  malformed: "A message from the other side could not be read.",
  unauthenticated: "A message from the other side did not prove who sent it.",
  expired: "The pairing code has expired.",
  used: "This was already used once.",
  unknown_device: "This device is not paired with this Mac.",
  too_large: "A message was larger than the channel allows.",
  exhausted: "This session has sent all it may. Open a new one.",
  closed: "This session is closed.",
  busy: "Finish an existing decision first.",
  invalid: "A value given to the channel was not valid.",
};

/// The one error this package throws. Its message is fixed per problem; see `RemoteChannelProblem`.
export class RemoteChannelError extends Error {
  readonly problem: RemoteChannelProblem;

  constructor(problem: RemoteChannelProblem) {
    super(MESSAGES[problem]);
    this.name = "RemoteChannelError";
    this.problem = problem;
  }
}

/// Every sentence an error can carry, so a test can check that nothing else ever reaches one.
export const REMOTE_CHANNEL_MESSAGES: readonly string[] = Object.values(MESSAGES);

/// Runs a step that calls Web Crypto or parses bytes, and turns whatever it throws into a
/// `RemoteChannelError`. A platform error's text is never passed on: it is not ours to promise
/// that it names no value.
export async function guarded<T>(problem: RemoteChannelProblem, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (error instanceof RemoteChannelError) throw error;
    throw new RemoteChannelError(problem);
  }
}
