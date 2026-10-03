import {
  checkResolvedAddresses,
  checkUrl,
  describeUrl,
  EgressBlockedError,
  EgressPolicy,
  hostAllowed,
  isBlockedAddress,
} from './egress-policy';

const policy: EgressPolicy = {
  allowPlainHttp: false,
  allowPrivateNetworks: false,
  deniedPorts: [25, 6379, 5432],
  deniedHosts: ['evil.example', '*.blocked.example'],
};
const blocked = (url: string, p = policy) => {
  try {
    checkUrl(url, p);
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(EgressBlockedError);
    return (err as EgressBlockedError).reason;
  }
};

describe('egress policy (Part 24, SSRF)', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '127.255.255.254',
    '169.254.169.254', // cloud metadata
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fd00:ec2::254', // AWS IPv6 metadata
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1', // IPv4-mapped
    '::ffff:7f00:1', // IPv4-mapped, hex form
    '::ffff:169.254.169.254',
    '::127.0.0.1', // IPv4-compatible
    '64:ff9b::a9fe:a9fe', // NAT64 of 169.254.169.254
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111'])(
    'allows public %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );

  it('treats anything that is not an IP as blocked', () => {
    expect(isBlockedAddress('example.com')).toBe(true);
  });

  it('allows public https URLs', () => {
    expect(checkUrl('https://api.example.com/v1/items?x=1', policy)).toMatchObject({
      hostname: 'api.example.com',
      port: 443,
    });
    expect(checkUrl('https://[2606:4700:4700::1111]:8443/', policy)).toMatchObject({
      hostname: '2606:4700:4700::1111',
      port: 8443,
      literalAddress: '2606:4700:4700::1111',
    });
  });

  it('requires https unless plain http is enabled', () => {
    expect(blocked('http://api.example.com/')).toBe('only https is allowed');
    expect(blocked('http://api.example.com/', { ...policy, allowPlainHttp: true })).toBeNull();
    expect(blocked('ftp://api.example.com/', { ...policy, allowPlainHttp: true })).toBe(
      'only http and https are supported',
    );
    expect(blocked('file:///etc/passwd')).toBe('only https is allowed');
    expect(blocked('not a url')).toBe('not a valid absolute URL');
  });

  it('refuses credentials in the URL', () => {
    expect(blocked('https://user:pass@api.example.com/')).toMatch(/credentials in the URL/);
  });

  it('blocks private IP literals in every encoding the URL parser accepts', () => {
    for (const url of [
      'https://127.0.0.1/',
      'https://2130706433/', // decimal
      'https://0x7f000001/', // hex
      'https://0177.0.0.1/', // octal
      'https://127.1/', // short form
      'https://[::1]/',
      'https://[::ffff:127.0.0.1]/',
      'https://169.254.169.254/latest/meta-data/',
      'https://[fd00:ec2::254]/',
    ]) {
      expect([url, blocked(url)]).toEqual([url, 'private, loopback or reserved address']);
    }
  });

  it('blocks internal service names before any lookup', () => {
    for (const url of [
      'https://localhost/',
      'https://postgres/',
      'https://redis:6380/',
      'https://api/',
      'https://worker/',
      'https://intranet/', // single label
      'https://db.internal/',
      'https://printer.local/',
      'https://x.localhost/',
      'https://svc.default.svc.cluster.local/',
    ]) {
      expect([url, blocked(url)]).toEqual([url, 'internal host name']);
    }
  });

  it('blocks denied ports and hosts', () => {
    expect(blocked('https://smtp.example.com:25/')).toBe('port 25 is blocked');
    expect(blocked('https://cache.example.com:6379/')).toBe('port 6379 is blocked');
    expect(blocked('https://evil.example/')).toBe('host is blocked by the server configuration');
    expect(blocked('https://a.b.blocked.example/')).toBe(
      'host is blocked by the server configuration',
    );
    expect(blocked('https://api.example.com:8443/')).toBeNull();
  });

  it('private networks can be allowed for self-hosted deployments', () => {
    const selfHosted = { ...policy, allowPrivateNetworks: true };
    expect(blocked('https://10.0.0.5/', selfHosted)).toBeNull();
    expect(blocked('https://intranet/', selfHosted)).toBeNull();
    expect(() => checkResolvedAddresses(['10.0.0.5'], selfHosted)).not.toThrow();
  });

  it('refuses a name when any resolved address is blocked', () => {
    expect(() => checkResolvedAddresses(['93.184.216.34'], policy)).not.toThrow();
    expect(() => checkResolvedAddresses(['93.184.216.34', '10.0.0.1'], policy)).toThrow(
      /resolves to a private/,
    );
    expect(() => checkResolvedAddresses(['::1'], policy)).toThrow(EgressBlockedError);
    expect(() => checkResolvedAddresses([], policy)).toThrow(/did not resolve/);
  });

  it('matches connection host allow-lists', () => {
    expect(hostAllowed('api.example.com', undefined)).toBe(true);
    expect(hostAllowed('api.example.com', ['api.example.com'])).toBe(true);
    expect(hostAllowed('eu.api.example.com', ['*.example.com'])).toBe(true);
    expect(hostAllowed('example.com', ['*.example.com'])).toBe(false);
    expect(hostAllowed('attacker.test', ['api.example.com'])).toBe(false);
  });

  it('describes URLs for logs without query values', () => {
    expect(describeUrl(new URL('https://api.example.com/v1/x?api_key=SECRET&q=1#frag'))).toBe(
      'https://api.example.com/v1/x?api_key=…&q=…',
    );
  });
});
