import { ask, corpusSize } from '../lib/resolve-query.js';
import { close } from '../lib/db.js';

const question = process.argv.slice(2).join(' ').trim();
if (!question) {
  const s = corpusSize();
  process.stdout.write(`usage: npm run ask -- "your question"\n`);
  process.stdout.write(`store: ${s.vehicles} vehicles, ${s.documents} documents, ${s.rules} rules\n`);
  close();
} else {
  const r = ask(question);
  process.stdout.write(`\n${r.sufficient ? 'ANSWER' : 'INSUFFICIENT DATA'}\n\n${r.answer}\n`);
  if (r.citations.length) {
    process.stdout.write(`\ncitations\n`);
    for (const c of r.citations) {
      process.stdout.write(`  ${c.source}${c.quote ? `  "${c.quote}"` : ''}${c.entity ? `  ${c.entity}` : ''}${c.note ? `  ${c.note}` : ''}\n`);
    }
  }
  process.stdout.write('\n');
  close();
  process.exitCode = r.sufficient ? 0 : 2;
}
