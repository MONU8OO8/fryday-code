/**
 * Deploy API.
 * GET    /api/deploy/jenkins       — whether Jenkins is set up (address and user; never the token)
 * PUT    /api/deploy/jenkins       — { baseUrl, user, token }: set it up (owner at the UI only)
 * DELETE /api/deploy/jenkins       — forget it (owner at the UI only)
 * POST   /api/deploy/jenkins/test  — { job? }: check the address and credentials, and the job if given.
 *                                    Read-only: nothing is started in Jenkins.
 * POST   /api/deploy/jenkins/job   — { job, branchParam? }: is that job there, and can it take the branch?
 * GET    /api/deploy/jenkins/mcp   — whether Claude Code has an MCP server for Jenkins to take settings from
 * POST   /api/deploy/jenkins/mcp   — take the address, user and token from it (owner at the UI only)
 */

import { Router, type Response } from 'express';
import { checkJenkins, DeployConfigError, jenkinsStatus, loadJenkinsCredentials, readCredentials, removeJenkinsCredentials, saveJenkinsCredentials } from '../deploy/config.js';
import { JenkinsClient, JenkinsError } from '../deploy/jenkins.js';
import { credentialsFromMcp, findJenkinsServer, FromMcpError } from '../deploy/fromMcp.js';

export const deployRouter = Router();

function ownerOnly(res: Response): boolean {
  if (res.locals['authVia'] === 'cookie') return true;
  res.status(403).json({ error: 'Set up Jenkins in the FryDay Code UI' });
  return false;
}

deployRouter.get('/jenkins', (_req, res) => {
  res.json({ jenkins: jenkinsStatus() });
});

// Credentials are tried against Jenkins before they are kept: a token Jenkins refuses is never
// stored, so it cannot sit there looking set up until a deploy fails on it days later.
deployRouter.put('/jenkins', async (req, res) => {
  if (!ownerOnly(res)) return;
  let creds;
  try {
    creds = readCredentials(req.body ?? {});
  } catch (err) {
    if (!(err instanceof DeployConfigError)) throw err;
    res.status(400).json({ error: err.message }); return;
  }
  const check = await checkJenkins(creds);
  // Jenkins answering "no" is about these credentials; not reaching it is not, so those are kept.
  if (!check.ok && !check.unreachable) { res.status(400).json({ error: check.problem }); return; }
  const jenkins = saveJenkinsCredentials(creds);
  res.json({ jenkins, user: check.user, warning: check.unreachable ? `Saved, but Jenkins could not be reached to check them: ${check.problem}` : null });
});

deployRouter.delete('/jenkins', (_req, res) => {
  if (!ownerOnly(res)) return;
  res.json({ jenkins: removeJenkinsCredentials() });
});

// What a project's deploy needs, checked before the project is kept (registry.ts calls this).
deployRouter.post('/jenkins/job', async (req, res) => {
  if (!ownerOnly(res)) return;
  const creds = loadJenkinsCredentials();
  if (!creds) { res.status(409).json({ error: 'Jenkins is not set up' }); return; }
  const name = typeof req.body?.job === 'string' ? req.body.job.trim() : '';
  const branchParam = typeof req.body?.branchParam === 'string' && req.body.branchParam.trim() ? req.body.branchParam.trim() : 'BRANCH';
  if (!name) { res.status(400).json({ error: 'Name the job that deploys this project' }); return; }
  try {
    res.json(await checkJenkins(creds, { name, branchParam }));
  } catch (err) {
    if (!(err instanceof JenkinsError)) throw err;
    res.status(502).json({ ok: false, problem: err.message, didYouMean: [], user: null, unreachable: true });
  }
});

// Claude Code already starts an MCP server for Jenkins on many machines, with the credentials
// in the developer's own file. Rather than a second copy here, take them from there.
deployRouter.get('/jenkins/mcp', (_req, res) => {
  const found = findJenkinsServer();
  res.json({ server: found?.name ?? null });
});

deployRouter.post('/jenkins/mcp', async (_req, res) => {
  if (!ownerOnly(res)) return;
  try {
    const { server, creds } = await credentialsFromMcp();
    const check = await checkJenkins(creds);
    if (!check.ok) { res.status(400).json({ error: `The settings from "${server}" did not work: ${check.problem}` }); return; }
    res.json({ jenkins: saveJenkinsCredentials(creds), user: check.user, server });
  } catch (err) {
    if (!(err instanceof FromMcpError)) throw err;
    res.status(400).json({ error: err.message });
  }
});

deployRouter.post('/jenkins/test', async (req, res) => {
  const creds = loadJenkinsCredentials();
  if (!creds) { res.status(409).json({ error: 'Jenkins is not set up' }); return; }
  const job = typeof req.body?.job === 'string' && req.body.job.trim() ? req.body.job.trim() : null;
  try {
    const client = new JenkinsClient(creds);
    const user = await client.whoAmI();
    const info = job ? await client.jobInfo(job) : null;
    res.json({ ok: true, user, job: info });
  } catch (err) {
    if (!(err instanceof JenkinsError)) throw err;
    res.status(502).json({ ok: false, error: err.message });
  }
});
