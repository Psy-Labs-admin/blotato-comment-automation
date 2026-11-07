/** The automation from the task statement, as a published definition. */
export const pricingDefinition = {
  schemaVersion: 1,
  trigger: {
    type: 'comment.created',
    platform: 'instagram',
    keyword: 'pricing',
    match: 'whole_word_case_insensitive',
    posts: 'all_supported',
  },
  steps: [
    { id: 'public_reply', type: 'reply_comment', text: 'Sent you a DM!' },
    { id: 'ask_email', type: 'send_private_reply', text: 'What email should we send the pricing to?' },
    {
      id: 'email',
      type: 'await_input',
      validator: 'email',
      promptStep: 'ask_email',
      timeout: '72h',
      maxClarifications: 1,
      clarificationText: "That doesn't look like an email address. Could you send it again?",
    },
    { id: 'send_link', type: 'send_message', text: 'Here you go: https://example.com/pricing' },
  ],
};

export function pricingWith(overrides: { timeout?: string; link?: string; maxClarifications?: number; keyword?: string } = {}) {
  const d = structuredClone(pricingDefinition);
  if (overrides.timeout) (d.steps[2] as any).timeout = overrides.timeout;
  if (overrides.maxClarifications !== undefined) (d.steps[2] as any).maxClarifications = overrides.maxClarifications;
  if (overrides.link) (d.steps[3] as any).text = `Here you go: ${overrides.link}`;
  if (overrides.keyword) d.trigger.keyword = overrides.keyword;
  return d;
}
