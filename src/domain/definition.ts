import { z } from 'zod';

/**
 * A published automation is a validated document: one trigger and a short, ordered list of typed steps.
 * Deliberately not a general graph or user code: bounded branches (valid / invalid / timeout / failed /
 * unknown) are handled by the engine, which keeps every run explainable and every send auditable.
 */

const StepId = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/, 'step id must be snake_case');
const Text = z.string().trim().min(1).max(1000);

const ReplyCommentStep = z.object({ id: StepId, type: z.literal('reply_comment'), text: Text });
const SendPrivateReplyStep = z.object({ id: StepId, type: z.literal('send_private_reply'), text: Text });
const AwaitInputStep = z.object({
  id: StepId,
  type: z.literal('await_input'),
  validator: z.literal('email'),
  promptStep: StepId,
  timeout: z.string(),
  maxClarifications: z.number().int().min(0).max(3),
  clarificationText: Text,
});
const SendMessageStep = z.object({ id: StepId, type: z.literal('send_message'), text: Text });

export const StepSchema = z.discriminatedUnion('type', [
  ReplyCommentStep,
  SendPrivateReplyStep,
  AwaitInputStep,
  SendMessageStep,
]);

export const AutomationDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  trigger: z.object({
    type: z.literal('comment.created'),
    platform: z.literal('instagram'),
    keyword: z.string().trim().min(1).max(60),
    match: z.literal('whole_word_case_insensitive'),
    posts: z.union([z.literal('all_supported'), z.object({ mediaIds: z.array(z.string().min(1)).min(1) })]),
  }),
  steps: z.array(StepSchema).min(1).max(10),
});

export type AutomationDefinition = z.infer<typeof AutomationDefinitionSchema>;
export type Step = z.infer<typeof StepSchema>;
export type AwaitInput = z.infer<typeof AwaitInputStep>;
export type SendStep = Exclude<Step, AwaitInput>;

export class DefinitionError extends Error {
  constructor(public readonly issues: string[]) {
    super(`invalid automation definition: ${issues.join('; ')}`);
    this.name = 'DefinitionError';
  }
}

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30 * 86_400_000;

export function parseDuration(s: string): number {
  const m = /^(\d+)\s*([smhd])$/.exec(s.trim());
  if (!m) throw new Error(`invalid duration "${s}" (expected e.g. 30s, 15m, 72h, 7d)`);
  return Number(m[1]) * UNIT_MS[m[2]];
}

export function parseDefinition(input: unknown): AutomationDefinition {
  const parsed = AutomationDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    throw new DefinitionError(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  const def = parsed.data;
  const issues: string[] = [];
  const seen = new Set<string>();
  let privateReplies = 0;
  let sawInput = false;

  def.steps.forEach((step, index) => {
    if (seen.has(step.id)) issues.push(`duplicate step id "${step.id}"`);
    seen.add(step.id);

    switch (step.type) {
      case 'send_private_reply':
        privateReplies += 1;
        break;
      case 'await_input': {
        const prev = def.steps[index - 1];
        if (!prev || prev.id !== step.promptStep || (prev.type !== 'send_private_reply' && prev.type !== 'send_message')) {
          issues.push(`step "${step.id}": promptStep must name the private reply / message step right before it`);
        }
        try {
          const ms = parseDuration(step.timeout);
          if (ms < MIN_TIMEOUT_MS || ms > MAX_TIMEOUT_MS) issues.push(`step "${step.id}": timeout must be within 1s..30d`);
        } catch (e) {
          issues.push(`step "${step.id}": timeout ${(e as Error).message}`);
        }
        sawInput = true;
        break;
      }
      case 'send_message':
        // A regular DM needs the participant to have messaged the account first (Meta Send API rule).
        if (!sawInput) issues.push(`step "${step.id}": send_message is only allowed after an await_input step`);
        break;
      case 'reply_comment':
        break;
    }
  });
  if (privateReplies > 1) issues.push('only one private reply per comment is allowed');

  if (issues.length) throw new DefinitionError(issues);
  return def;
}
