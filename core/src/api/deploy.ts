/**
 * Deploy API.
 * GET    /api/deploy/jenkins       — whether Jenkins is set up (address and user; never the token)
 * PUT    /api/deploy/jenkins       — { baseUrl, user, token }: set it up (owner at the UI only)
 * DELETE /api/deploy/jenkins       — forget it (owner at the UI only)
 * POST   /api/deploy/jenkins/test  — { job? }: check the address and credentials, and the job if given.
 *                                    Read-only: nothing is started in Jenkins.
 */

import { Router, type Response } from 'express';
import { DeployConfigError, jenkinsStatus, loadJenkinsCredentials, removeJenkinsCredentials, saveJenkinsCredentials } from '../deploy/config.js';
import { JenkinsClient, JenkinsError } from '../deploy/jenkins.js';

export const deployRouter = Router();

function ownerOnly(res: Response): boolean {
  if (res.locals['authVia'] === 'cookie') return true;
  res.status(403).json({ error: 'Set up Jenkins in the FryDay Code UI' });
  return false;
}

deployRouter.get('/jenkins', (_req, res) => {
  res.json({ jenkins: jenkinsStatus() });
});

deployRouter.put('/jenkins', (req, res) => {
  if (!ownerOnly(res)) return;
  try {
    res.json({ jenkins: saveJenkinsCredentials(req.body ?? {}) });
  } catch (err) {
    if (!(err instanceof DeployConfigError)) throw err;
    res.status(400).json({ error: err.message });
  }
});

deployRouter.delete('/jenkins', (_req, res) => {
  if (!ownerOnly(res)) return;
  res.json({ jenkins: removeJenkinsCredentials() });
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
