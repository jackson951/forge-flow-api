// k6 scenario (Part 21, AC-21.1): COUNT manual runs of a `util.log` workflow, started through
// all API instances in turn. setup() registers a fresh user and publishes the workflow; the
// workspace id is printed for check-runs.sql. Rate limiting must be off (THROTTLE_ENABLED=false,
// non-production) or the per-user limit of 300/min applies.
//
//   k6 run -e TARGETS=http://api:3000,http://api2:3000 [-e COUNT=1000] manual-runs.js
import exec from 'k6/execution';
import http from 'k6/http';
import { check } from 'k6';

const TARGETS = (__ENV.TARGETS || 'http://localhost:3000').split(',');
const COUNT = Number(__ENV.COUNT || 1000);
const json = { 'content-type': 'application/json' };

export const options = {
  scenarios: {
    start: { executor: 'shared-iterations', vus: 20, iterations: COUNT, maxDuration: '5m' },
  },
  thresholds: { checks: ['rate==1'] },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

function call(method, url, body, token) {
  const headers = token ? { ...json, Authorization: `Bearer ${token}` } : json;
  const res = http.request(method, url, body && JSON.stringify(body), { headers });
  if (res.status >= 300) throw new Error(`${method} ${url} -> ${res.status} ${res.body}`);
  return res.json();
}

export function setup() {
  const api = `${TARGETS[0]}/api/v1`;
  const email = `load-${Date.now()}@perf.test`;
  const { accessToken } = call('POST', `${api}/auth/register`, {
    email,
    password: 'load test password 123',
    name: 'Load Test',
  });
  const [ws] = call('GET', `${api}/workspaces`, null, accessToken);
  const wf = call('POST', `${api}/workspaces/${ws.id}/workflows`, { name: 'load' }, accessToken);
  call(
    'PUT',
    `${api}/workspaces/${ws.id}/workflows/${wf.id}/draft`,
    {
      expectedRevision: 0,
      definition: {
        schemaVersion: 1,
        nodes: [
          { key: 'trigger', kind: 'TRIGGER', type: 'manual.trigger', config: {} },
          { key: 'log', kind: 'ACTION', type: 'util.log', config: { message: 'load' } },
        ],
        edges: [{ from: 'trigger', to: 'log' }],
      },
    },
    accessToken,
  );
  call(
    'POST',
    `${api}/workspaces/${ws.id}/workflows/${wf.id}/publish`,
    { expectedRevision: 1 },
    accessToken,
  );
  console.log(`workspace=${ws.id} workflow=${wf.id}`);
  return { token: accessToken, ws: ws.id, wf: wf.id };
}

export default function (data) {
  const n = exec.scenario.iterationInTest;
  const res = http.post(
    `${TARGETS[n % TARGETS.length]}/api/v1/workspaces/${data.ws}/workflows/${data.wf}/runs`,
    JSON.stringify({ input: { n } }),
    { headers: { ...json, Authorization: `Bearer ${data.token}` } },
  );
  check(res, { queued: (r) => r.status === 202 });
}
