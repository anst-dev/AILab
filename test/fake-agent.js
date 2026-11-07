'use strict';
// A stand-in for a real agent CLI, used by the tests. Behaviour is chosen at random
// (or forced with FAKE_BEHAVIOUR) to exercise every path of the orchestrator.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

if (!fs.existsSync('.swarm_task.md')) {
  console.error('task file missing');
  process.exit(2);
}
const agent = process.env.SWARM_AGENT || 'agent-?';
const behaviours = (process.env.FAKE_BEHAVIOURS || 'improve,improve,improve,worse,hang,nothing,break,commit,protected,ownfile').split(',');
const pick = process.env.FAKE_BEHAVIOUR || behaviours[Math.floor(Math.random() * behaviours.length)];
const value = () => parseFloat(fs.readFileSync('value.txt', 'utf8'));

fs.writeFileSync('.swarm_note.md', `${pick} by ${agent}\n`);
console.log(`[fake] ${agent} behaviour=${pick}`);

switch (pick) {
  case 'improve':
    fs.writeFileSync('value.txt', String(+(value() - 1 - Math.random()).toFixed(3)));
    break;
  case 'worse':
    fs.writeFileSync('value.txt', String(+(value() + 1).toFixed(3)));
    break;
  case 'hang':
    // Spawn a grandchild that would outlive us if the tree were not killed.
    require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    setInterval(() => {}, 1000);
    break;
  case 'nothing':
    break;
  case 'break':
    fs.writeFileSync('value.txt', 'BROKEN');
    break;
  case 'commit':
    fs.writeFileSync('value.txt', String(+(value() - 0.5).toFixed(3)));
    execFileSync('git', ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-qam', 'agent committed by itself']);
    break;
  case 'protected':
    fs.writeFileSync('protected.txt', 'tampered');
    fs.writeFileSync('value.txt', String(+(value() - 0.25).toFixed(3)));
    break;
  case 'ownfile':
    fs.mkdirSync('notes', { recursive: true });
    fs.writeFileSync(`notes/${agent}-${Date.now()}.txt`, 'hello');
    break;
  case 'conflict':
    fs.writeFileSync('shared.txt', `${agent} ${Date.now()} ${Math.random()}\n`);
    break;
}
if (pick !== 'hang') setTimeout(() => process.exit(0), 300 + Math.random() * 1500);
