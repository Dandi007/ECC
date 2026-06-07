#!/usr/bin/env node
// Generate sandbox Claude Code settings.json wiring the parity hook subset
// through the SAME run-with-flags tuples the ECC plugin registers.
'use strict';
const root = process.argv[2];
const run = (id, script, profiles) =>
  ({ type: 'command', command: `node "${root}/scripts/hooks/run-with-flags.js" ${id} ${script} ${profiles}` });
const settings = {
  hooks: {
    SessionStart: [{ hooks: [run('session:start', 'scripts/hooks/session-start.js', 'minimal,standard,strict')] }],
    PostToolUse: [
      { matcher: '*', hooks: [run('post:ecc-metrics-bridge', 'scripts/hooks/ecc-metrics-bridge.js', 'minimal,standard,strict')] },
      { matcher: '*', hooks: [run('post:ecc-context-monitor', 'scripts/hooks/ecc-context-monitor.js', 'standard,strict')] },
      { matcher: 'Bash', hooks: [run('post:bash:dispatcher', 'scripts/hooks/post-bash-dispatcher.js', 'minimal,standard,strict')] },
    ],
    Stop: [
      { hooks: [run('stop:session-end', 'scripts/hooks/session-end.js', 'minimal,standard,strict')] },
      { hooks: [run('stop:desktop-notify', 'scripts/hooks/desktop-notify.js', 'standard,strict')] },
    ],
    PreCompact: [{ hooks: [run('pre:compact', 'scripts/hooks/pre-compact.js', 'standard,strict')] }],
  },
  env: {
    CLAUDE_PLUGIN_ROOT: root,
    ECC_HOOK_PROFILE: 'standard',
    ECC_DISABLED_HOOKS: 'post:bash:command-log-cost,stop:cost-tracker',
  },
};
process.stdout.write(JSON.stringify(settings, null, 2) + '\n');
