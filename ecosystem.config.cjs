/**
 * PM2 process definitions (spec 63).
 *
 * Secrets are never listed here — this file is committed. Both processes read
 * the server's own .env via node's --env-file, so rotating a key means editing
 * .env and reloading, with nothing to change in git.
 */
module.exports = {
  apps: [
    {
      name: 'wf-api',
      cwd: __dirname,
      script: 'packages/api/dist/bin/serve.js',
      node_args: ['--env-file-if-exists=.env'],
      // Cluster mode gives zero-downtime reloads and uses every core. Rate
      // limits stay correct across workers because the store is Redis.
      exec_mode: 'cluster',
      instances: process.env.WF_API_INSTANCES || 2,
      max_memory_restart: '512M',
      // Stop restarting a process that dies immediately on boot, so a bad
      // deploy surfaces in `pm2 status` instead of looping forever.
      min_uptime: '20s',
      max_restarts: 10,
      restart_delay: 2000,
      merge_logs: true,
      time: true,
    },
    {
      name: 'wf-tick',
      cwd: __dirname,
      script: 'packages/worker/dist/bin/tick.js',
      args: '--loop',
      node_args: ['--env-file-if-exists=.env'],
      // Exactly one: two schedulers would double-accrue interest.
      exec_mode: 'fork',
      instances: 1,
      max_memory_restart: '256M',
      min_uptime: '20s',
      max_restarts: 10,
      restart_delay: 5000,
      merge_logs: true,
      time: true,
    },
  ],
};
