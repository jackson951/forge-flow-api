/** Trimmed copy of a real `issues` webhook payload (action: opened). */
export const issuesOpenedPayload = (installationId = 123, repo = 'Octo-Org/Hello-World') => ({
  action: 'opened',
  issue: {
    number: 42,
    title: 'Login page crashes',
    body: 'Steps to reproduce…',
    html_url: `https://github.com/${repo}/issues/42`,
    state: 'open',
    created_at: '2026-10-01T10:00:00Z',
    labels: [
      { id: 1, name: 'bug', color: 'd73a4a' },
      { id: 2, name: 'production' },
    ],
    user: { login: 'octocat', id: 1, type: 'User' },
  },
  repository: { id: 1296269, full_name: repo, private: false, owner: { login: 'Octo-Org' } },
  sender: { login: 'octocat', type: 'User' },
  installation: { id: installationId, node_id: 'MDIz' },
});
