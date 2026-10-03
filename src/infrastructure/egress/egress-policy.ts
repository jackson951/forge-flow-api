import { BlockList, isIP } from 'node:net';

/**
 * Egress policy for user-chosen destinations (Part 24; Part 18 SSRF section). Pure: no DNS,
 * no sockets. The client (egress-client.ts) resolves names, checks every address here and
 * connects only to an address that passed.
 */

export interface EgressPolicy {
  /** `http:` in addition to `https:` (dev / self-hosted only). */
  allowPlainHttp: boolean;
  /** Private, loopback and link-local destinations (self-hosted deployments only). */
  allowPrivateNetworks: boolean;
  /** Ports never connected to, e.g. SMTP, Redis, Postgres. */
  deniedPorts: number[];
  /** Exact host names or `*.suffix` patterns that are always refused. */
  deniedHosts: string[];
}

export class EgressBlockedError extends Error {
  constructor(readonly reason: string) {
    super(`Destination not allowed: ${reason}`);
    this.name = 'EgressBlockedError';
  }
}

/** Ranges that must never be reached from a multi-tenant service (IPv4 and IPv6). */
const BLOCKED = new BlockList();
const V4: [string, number][] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. cloud metadata 169.254.169.254
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. broadcast
];
const V6: [string, number][] = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b::', 96], // NAT64 (embeds IPv4)
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local, incl. AWS metadata fd00:ec2::254
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
];
for (const [net, prefix] of V4) BLOCKED.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of V6) BLOCKED.addSubnet(net, prefix, 'ipv6');

/** Embedded IPv4 of IPv4-mapped (`::ffff:a.b.c.d`) and IPv4-compatible (`::a.b.c.d`) forms. */
function embeddedIPv4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = /^::(?:ffff:(?:0:)?)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted) return dotted[1];
  // Hex form, e.g. ::ffff:7f00:1 (as some parsers normalise it).
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

/** True when the address is in a range no workflow may reach (unless private is allowed). */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return BLOCKED.check(address, 'ipv4');
  if (family === 6) {
    const v4 = embeddedIPv4(address);
    if (v4) return BLOCKED.check(v4, 'ipv4');
    return BLOCKED.check(address, 'ipv6');
  }
  return true; // not an IP at all: refuse
}

/** Names of the deployment's own services and local-only suffixes (defence in depth). */
const INTERNAL_NAMES = /^(localhost|postgres|redis|api|worker|web|db|database|metadata)$/i;
const INTERNAL_SUFFIX = /\.(localhost|local|internal|localdomain|home\.arpa|cluster\.local)$/i;

function hostMatches(host: string, pattern: string): boolean {
  const p = pattern.toLowerCase();
  return p.startsWith('*.') ? host.endsWith(p.slice(1)) : host === p;
}

export interface CheckedUrl {
  url: URL;
  /** Host name without IPv6 brackets. */
  hostname: string;
  port: number;
  /** Set when the host is an IP literal (already checked). */
  literalAddress?: string;
}

/**
 * Static checks before any DNS lookup: scheme, credentials in the URL, port, host names.
 * IP literals are checked here; names are checked again after resolution by the client.
 */
export function checkUrl(raw: string | URL, policy: EgressPolicy): CheckedUrl {
  let url: URL;
  try {
    url = typeof raw === 'string' ? new URL(raw) : raw;
  } catch {
    throw new EgressBlockedError('not a valid absolute URL');
  }
  if (url.protocol !== 'https:' && !(policy.allowPlainHttp && url.protocol === 'http:')) {
    throw new EgressBlockedError(
      policy.allowPlainHttp ? 'only http and https are supported' : 'only https is allowed',
    );
  }
  if (url.username || url.password) {
    throw new EgressBlockedError('credentials in the URL are not allowed; use an HTTP connection');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname) throw new EgressBlockedError('missing host');
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (policy.deniedPorts.includes(port)) throw new EgressBlockedError(`port ${port} is blocked`);
  if (policy.deniedHosts.some((p) => hostMatches(hostname, p))) {
    throw new EgressBlockedError('host is blocked by the server configuration');
  }

  if (isIP(hostname)) {
    if (!policy.allowPrivateNetworks && isBlockedAddress(hostname)) {
      throw new EgressBlockedError('private, loopback or reserved address');
    }
    return { url, hostname, port, literalAddress: hostname };
  }
  if (!policy.allowPrivateNetworks) {
    // Single-label names resolve through search domains to internal services.
    if (
      !hostname.includes('.') ||
      INTERNAL_NAMES.test(hostname) ||
      INTERNAL_SUFFIX.test(hostname)
    ) {
      throw new EgressBlockedError('internal host name');
    }
  }
  return { url, hostname, port };
}

/** After resolution: every address must be allowed, or the whole request is refused. */
export function checkResolvedAddresses(addresses: string[], policy: EgressPolicy): void {
  if (addresses.length === 0) throw new EgressBlockedError('host did not resolve');
  if (policy.allowPrivateNetworks) return;
  if (addresses.some(isBlockedAddress)) {
    throw new EgressBlockedError('host resolves to a private, loopback or reserved address');
  }
}

/** Host allow-list of an HTTP connection: exact names or `*.example.com`. */
export function hostAllowed(hostname: string, allowedHosts: string[] | undefined): boolean {
  if (!allowedHosts?.length) return true;
  return allowedHosts.some((p) => hostMatches(hostname.toLowerCase(), p));
}

/** For logs: scheme, host and path only — query values and fragments never leave. */
export function describeUrl(url: URL): string {
  const keys = [...new Set(url.searchParams.keys())];
  return `${url.protocol}//${url.host}${url.pathname}${keys.length ? `?${keys.map((k) => `${k}=…`).join('&')}` : ''}`;
}
