'use strict';
// Stand-in for a coordinator CLI: reads request.md and answers with JSON, like a real model would.
//   user message "tối ưu <dir>"  -> inspect <dir>, then (on the tool-results call) start a run with the fake agent
//   run ended                    -> summary, no action
//   anything else                -> plain reply
const fs = require('node:fs');
const req = fs.readFileSync('request.md', 'utf8');
const now = req.slice(req.indexOf('## Now'));
const users = [...req.matchAll(/USER: (.*)/g)].map((m) => m[1]);
const last = users[users.length - 1] || '';
const dir = (last.match(/tối ưu (\S+)/) || [])[1];
const out = (o) => console.log(`some chatter {not json}\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\``);

if (now.includes('has just ended')) out({ reply: 'Phiên đã xong, kết quả tốt.', actions: [] });
else if (now.includes('results are attached')) {
  if (!req.includes('"exists": true')) out({ reply: 'Không thấy thư mục.', actions: [] });
  else
    out({
      reply: 'Bắt đầu tối ưu.',
      actions: [{ type: 'start', options: { workspace: dir, requirement: 'giảm value', agents: [{ cli: 'fake', count: 2 }], timeLimitMin: 0.08, evalMode: 'score', evalCommand: `node "${process.env.FAKE_EVAL}"`, metricRegex: '^score:\\s*([-0-9.]+)', direction: 'min', maxIterations: 2, staggerSec: 0 } }],
    });
} else if (dir) out({ reply: 'Để tôi xem thư mục.', actions: [{ type: 'inspect', path: dir }] });
else out({ reply: `Chào bạn: ${last}`, actions: [{ type: 'bogus' }] });
