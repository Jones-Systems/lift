import type { Plan } from '../../api/domain';

export type PreviewResult = { status: 'ok'; value: Plan } | { status: 'rejected'; code: string };
export type PreviewContext = { isCurrentSession(): boolean };
export type ReadOnlyPlanPort = {
  readonly capability: 'read_only';
  readPlan(context: PreviewContext, id: string): Promise<PreviewResult>;
  commitSuggestion(): Promise<{ status: 'rejected'; code: string }>;
  lookupReceipt(): Promise<{ status: 'reconciliation_required'; code: string }>;
};
export function createReadOnlyFormAdapter(resources: {
  getPlan(id: string): Promise<Plan | undefined>;
}): ReadOnlyPlanPort;
export function createSessionController(context: PreviewContext, port: ReadOnlyPlanPort,
  render: (result: PreviewResult) => void): {
  reviewPlan(id: string): Promise<PreviewResult>;
  dispatch(command: unknown): Promise<PreviewResult>;
  dispose(): void;
};
