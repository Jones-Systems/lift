import { z } from 'zod';
import { dispatchOutcomeSchema, parseInput, reportIdSchema, reportInputSchema, trustedBindingSchema,
  type ReportInput, type TrustedBinding } from '../schemas.js';
import type { BugIntakeDependencies, DispatchOutcome, PreparedHandoff } from '../types.js';

export type JonesCurrentGrant = Readonly<{ handoffId: string; binding: TrustedBinding }>;
export type JonesBugRequest = Readonly<{
  handoffId: string;
  binding: TrustedBinding;
  report: Readonly<{
    kind: 'untrusted_user_report';
    authorityEffect: 'none';
    executionAuthorized: false;
    content: Readonly<ReportInput>;
  }>;
}>;
export type JonesBugPort = Readonly<{ submit: (request: JonesBugRequest) => Promise<unknown> }>;
export type JonesDispatchBindings = Readonly<{
  binding: TrustedBinding;
  currentGrantFor: (handoffId: string) => unknown;
  port?: JonesBugPort;
}>;

const handoffSchema = z.object({
  handoffId: reportIdSchema,
  binding: trustedBindingSchema,
  report: z.object({ kind: z.literal('untrusted_user_report'), content: reportInputSchema }).strict(),
}).strict();
const grantSchema = z.object({ handoffId: reportIdSchema, binding: trustedBindingSchema }).strict();
const sameBinding = (a: TrustedBinding, b: TrustedBinding) =>
  a.repository === b.repository && a.sourceRevision === b.sourceRevision &&
  a.acceptedScopeId === b.acceptedScopeId && a.authorityId === b.authorityId;

function projectReport(input: ReportInput): Readonly<ReportInput> {
  const diagnostics = input.diagnosticConsent && input.diagnostics ? Object.freeze({
    platform: input.diagnostics.platform,
    appVersion: input.diagnostics.appVersion,
    ...(input.diagnostics.buildNumber === undefined ? {} : { buildNumber: input.diagnostics.buildNumber }),
    ...(input.diagnostics.screen === undefined ? {} : { screen: input.diagnostics.screen }),
  }) : undefined;
  return Object.freeze({ title: input.title, description: input.description,
    diagnosticConsent: input.diagnosticConsent, ...(diagnostics === undefined ? {} : { diagnostics }) });
}

export function createJonesBugDispatchAdapter(bindings: JonesDispatchBindings): NonNullable<BugIntakeDependencies['dispatch']> {
  const expectedBinding = Object.freeze(trustedBindingSchema.parse(bindings.binding));
  const currentGrantFor = bindings.currentGrantFor, port = bindings.port;
  return Object.freeze({
    async submit(handoff: PreparedHandoff): Promise<DispatchOutcome> {
      let request: JonesBugRequest;
      try {
        const parsed = handoffSchema.parse(handoff);
        if (!port || !sameBinding(parsed.binding, expectedBinding)) return { status: 'known_no_effect' };
        request = Object.freeze({ handoffId: parsed.handoffId, binding: Object.freeze(parsed.binding),
          report: Object.freeze({ kind: 'untrusted_user_report', authorityEffect: 'none', executionAuthorized: false,
            content: projectReport(parseInput(parsed.report.content)) }) });
        const grant = grantSchema.parse(currentGrantFor(parsed.handoffId));
        if (grant.handoffId !== parsed.handoffId || !sameBinding(grant.binding, expectedBinding))
          return { status: 'known_no_effect' };
      } catch {
        return { status: 'known_no_effect' };
      }
      // The service owns the durable fence. After this call, exceptions cannot establish that no effect occurred.
      try {
        return dispatchOutcomeSchema.parse(await port!.submit(request));
      } catch {
        return { status: 'unknown' };
      }
    },
  });
}
