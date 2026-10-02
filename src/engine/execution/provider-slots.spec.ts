import { ProviderConcurrencyLimiter, providerOf } from './provider-slots';

describe('provider slots', () => {
  it('maps provider node types by prefix; built-in types have no provider', () => {
    expect(providerOf('slack.sendMessage')).toBe('slack');
    expect(providerOf('microsoft.todo.createTask')).toBe('microsoft');
    expect(providerOf('github.issue.created')).toBe('github');
    expect(providerOf('ai.summarize')).toBe('ai');
    expect(providerOf('util.log')).toBeUndefined();
    expect(providerOf('manual.trigger')).toBeUndefined();
    expect(providerOf('slackish.thing')).toBeUndefined();
  });

  it('limits each provider separately and frees slots on release', () => {
    const limiter = new ProviderConcurrencyLimiter(2);
    const s1 = limiter.tryAcquire('slack.sendMessage');
    const s2 = limiter.tryAcquire('slack.sendMessage');
    expect(s1 && s2).toBeTruthy();
    expect(limiter.tryAcquire('slack.sendMessage')).toBeNull();
    // Another provider is unaffected by Slack being full.
    expect(limiter.tryAcquire('ai.summarize')).not.toBeNull();
    expect(limiter.active('slack')).toBe(2);

    s1!();
    s1!(); // releasing twice frees one slot only
    expect(limiter.active('slack')).toBe(1);
    expect(limiter.tryAcquire('slack.sendMessage')).not.toBeNull();
    expect(limiter.tryAcquire('slack.sendMessage')).toBeNull();
  });

  it('never limits types without a provider', () => {
    const limiter = new ProviderConcurrencyLimiter(1);
    for (let i = 0; i < 10; i++) expect(limiter.tryAcquire('util.log')).not.toBeNull();
    expect(limiter.active('util')).toBe(0);
  });

  it('rejects a limit below one', () => {
    expect(() => new ProviderConcurrencyLimiter(0)).toThrow('positive integer');
  });
});
