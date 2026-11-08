import { describe, expect, it } from 'vitest';
import { DefinitionError, parseDefinition, parseDuration } from '../../src/domain/definition';
import { pricingDefinition } from '../helpers/definitions';

const clone = () => structuredClone(pricingDefinition);

describe('parseDuration', () => {
  it('parses hours, minutes, seconds and days into milliseconds', () => {
    expect(parseDuration('72h')).toBe(259_200_000);
    expect(parseDuration('30m')).toBe(1_800_000);
    expect(parseDuration('5s')).toBe(5_000);
    expect(parseDuration('7d')).toBe(604_800_000);
  });
  it('rejects garbage', () => {
    expect(() => parseDuration('soon')).toThrow();
  });
});

describe('parseDefinition', () => {
  it('accepts the four-step pricing automation', () => {
    expect(parseDefinition(clone()).steps).toHaveLength(4);
  });

  it('rejects send_message before any await_input (platform requires the user to message first)', () => {
    const d = clone();
    d.steps = [d.steps[0], { id: 'early', type: 'send_message', text: 'hi' } as any];
    expect(() => parseDefinition(d)).toThrow(DefinitionError);
  });

  it('rejects duplicate step ids', () => {
    const d = clone();
    (d.steps[1] as any).id = 'public_reply';
    expect(() => parseDefinition(d)).toThrow(/duplicate step id/);
  });

  it('rejects an await_input whose promptStep is not the step right before it', () => {
    const d = clone();
    (d.steps[2] as any).promptStep = 'public_reply';
    expect(() => parseDefinition(d)).toThrow(/promptStep/);
  });

  it('rejects a timeout outside 1s..30d', () => {
    const d = clone();
    (d.steps[2] as any).timeout = '45d';
    expect(() => parseDefinition(d)).toThrow(/timeout/);
  });

  it('rejects more than one private reply (one per comment on Instagram)', () => {
    const d = clone();
    d.steps.splice(1, 0, { id: 'ask_twice', type: 'send_private_reply', text: 'again' } as any);
    expect(() => parseDefinition(d)).toThrow(/private reply/);
  });

  it('rejects a second email wait because a run captures one lead', () => {
    const d = clone();
    d.steps.push({ ...d.steps[2], id: 'second_email', promptStep: 'send_link' } as any);
    expect(() => parseDefinition(d)).toThrow(/one.*await_input/);
  });

  it('rejects a keyword without letters or digits, which could never match (review finding)', () => {
    const d = clone();
    (d.trigger as any).keyword = '🔥🔥';
    expect(() => parseDefinition(d)).toThrow(/keyword/);
  });

  it('reports schema issues with paths', () => {
    try {
      parseDefinition({ schemaVersion: 2 });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DefinitionError);
      expect((e as DefinitionError).issues.length).toBeGreaterThan(0);
    }
  });
});
