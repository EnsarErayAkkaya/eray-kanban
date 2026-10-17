// Stands in for the claude CLI in tests. Echoes stdin, argv and env, replays a fixture, then exits or hangs.
import fs from 'node:fs';

const say = (text) =>
  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }));

let stdin = '';
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  say(`PROMPT:${stdin}`);
  say(`ARGS:${process.argv.slice(2).join(' ')}`);
  const promptFile = process.argv[process.argv.indexOf('--append-system-prompt-file') + 1];
  if (process.argv.includes('--append-system-prompt-file')) say(`SYSTEM:${fs.readFileSync(promptFile, 'utf8')}`);
  say(`API_KEY:${process.env.ANTHROPIC_API_KEY ? 'set' : 'unset'}`);
  const fixture = process.env.FAKE_CLAUDE_FIXTURE;
  if (fixture) process.stdout.write(fs.readFileSync(fixture, 'utf8'));
  if (process.env.FAKE_CLAUDE_HANG) setInterval(() => {}, 1000);
  else {
    if (process.env.FAKE_CLAUDE_STDERR) console.error(process.env.FAKE_CLAUDE_STDERR);
    process.exitCode = Number(process.env.FAKE_CLAUDE_EXIT ?? 0);
  }
});
