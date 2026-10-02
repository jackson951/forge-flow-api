// k6 scenario (Part 21, AC-21.3): signed TEST-provider webhooks at a constant arrival rate,
// spread over one or more API instances. Each delivery is unique and routes to the seeded
// "load-test" trigger, so every request stores a delivery, creates a run and enqueues it.
//
//   k6 run -e TARGETS=http://api:3000,http://api2:3000 -e WEBHOOK_TEST_SECRET=... \
//          [-e RATE=50] [-e DURATION=2m] webhook-intake.js
import crypto from 'k6/crypto';
import exec from 'k6/execution';
import http from 'k6/http';
import { check } from 'k6';

const TARGETS = (__ENV.TARGETS || 'http://localhost:3000').split(',');
const SECRET = __ENV.WEBHOOK_TEST_SECRET;
const RUN_TAG = `${Date.now()}`;

export const options = {
  scenarios: {
    intake: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 50),
      timeUnit: '1s',
      duration: __ENV.DURATION || '2m',
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<200'],
    checks: ['rate>0.999'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  if (!SECRET) throw new Error('WEBHOOK_TEST_SECRET is required');
}

export default function () {
  const n = exec.scenario.iterationInTest;
  const body = JSON.stringify({ resource: 'load-test', data: { n } });
  const ts = Math.floor(Date.now() / 1000);
  const signature = crypto.hmac('sha256', SECRET, `${ts}.${body}`, 'hex');
  const res = http.post(`${TARGETS[n % TARGETS.length]}/api/v1/webhooks/test`, body, {
    headers: {
      'content-type': 'application/json',
      'x-flowforge-delivery': `load-${RUN_TAG}-${n}`,
      'x-flowforge-event': 'load.event',
      'x-flowforge-timestamp': String(ts),
      'x-flowforge-signature': `sha256=${signature}`,
    },
  });
  check(res, { 'accepted, one run': (r) => r.status === 202 && r.json('runs') === 1 });
}
