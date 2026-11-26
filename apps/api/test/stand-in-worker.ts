import type { WorkerPort } from "../src/job-flow";

/// A deterministic stand-in for one of Buddy's team members running in the cloud (Phase 4), for the Phase 2 gate
/// (docs/phase-0-spikes.md, section 3). It runs the same script every time and knows the control plane only through
/// the port it is handed: it has no environment, no vault and no provider client, so the only way it can reach a
/// model, a credential or an external system is the port, which never hands it a secret.
///
/// It reports what it does as agent events in the wire shape of `packages/agent-events` (one flat object with a
/// `type`; `src/events.ts` there is the contract), including one kind that contract does not know yet, to show that
/// the control plane keeps unknown kinds rather than dropping them.

export type Script = {
  /// The issue it files in the shop's tracker once the owner approves.
  issue: { projectId: string; title: string; description: string };
};

export const STAND_IN_MODEL = "claude-haiku-5-5";

/// A kind `packages/agent-events` does not have yet, as a newer worker might send.
export const FUTURE_EVENT = { type: "handoffNote", to: "Ton", summary: "books need the refund" } as const;

export type Started =
  | { asked: true; requestId: string }
  | { asked: false; stoppedBy: string; ended: boolean };

export type Resumed =
  | { finished: "done" | "failed"; outcome: string }
  | { waiting: string }
  | { stoppedBy: string };

export class StandInWorker {
  /// Every answer the port gave this worker, in order, so a test can show what the worker ever held.
  readonly heard: unknown[] = [];
  requestId: string | null = null;

  constructor(
    private readonly port: WorkerPort,
    private readonly script: Script,
  ) {}

  private async listen<T>(answer: Promise<T>): Promise<T> {
    const heard = await answer;
    this.heard.push(heard);
    return heard;
  }

  /// Up to the pause: opens a turn, asks the model for a draft through the gateway, reports what it wrote and spent,
  /// then stops before the external write and asks for exactly that write.
  async start(): Promise<Started> {
    const opened = await this.listen(this.port.report([{ type: "turnStarted", providerTurnID: "turn-1" }]));
    if (!opened.ok) return { asked: false, stoppedBy: opened.error, ended: opened.ended === true };
    const drafted = await this.listen(this.port.callModel({
      model: STAND_IN_MODEL,
      system: "You write short issue descriptions for a small shop.",
      messages: [{ role: "user", content: this.port.job.goal }],
      maxOutputTokens: 200,
    }));
    if (!drafted.ok) return { asked: false, stoppedBy: drafted.error, ended: drafted.ended === true };
    const reported = await this.listen(this.port.report([
      { type: "messageCompleted", id: "draft-1", text: drafted.value.text },
      { type: "spend", tokens: drafted.value.usage.inputTokens + drafted.value.usage.outputTokens, model: STAND_IN_MODEL },
      FUTURE_EVENT,
    ]));
    if (!reported.ok) return { asked: false, stoppedBy: reported.error, ended: reported.ended === true };
    const asked = await this.listen(this.port.ask({
      operationType: "linear.issue.create",
      targetResourceId: this.script.issue.projectId,
      payload: { title: this.script.issue.title, description: this.script.issue.description },
    }));
    if (!asked.ok) return { asked: false, stoppedBy: asked.error, ended: asked.ended === true };
    this.requestId = asked.value.requestId;
    return { asked: true, requestId: asked.value.requestId };
  }

  /// After the decision: reads how the request and its write settled, reports it, and finishes. A write still on its
  /// way leaves the attempt running for the next resume.
  async resume(): Promise<Resumed> {
    if (!this.requestId) return { stoppedBy: "nothing_asked" };
    const read = await this.listen(this.port.outcome(this.requestId));
    if (!read.ok) return { stoppedBy: read.error };
    const { standing, approved, action } = read.value;
    if (standing === "open" || (approved && (action === "approved" || action === "dispatching"))) {
      return { waiting: standing === "open" ? "decision" : action };
    }
    const filed = approved === true && action === "confirmed";
    const text = filed ? "Filed the issue." : approved === false ? "The owner said no; nothing was filed." :
      `Nothing was filed (${standing === "decided" ? action : standing}).`;
    const reported = await this.listen(this.port.report([
      { type: "messageCompleted", id: "result-1", text },
      { type: "turnCompleted", status: filed || approved === false ? "completed" : "failed" },
    ]));
    if (!reported.ok) return { stoppedBy: reported.error };
    const outcome = filed || approved === false ? "done" : "failed";
    const finished = await this.listen(outcome === "done" ? this.port.finish("done") :
      this.port.finish("failed", standing === "decided" ? `dispatch_${action}` : standing));
    if (!finished.ok) return { stoppedBy: finished.error };
    return { finished: outcome, outcome: filed ? "filed" : approved === false ? "declined" : standing };
  }
}
