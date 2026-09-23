import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/lib/wf.mjs';
import { opsErrorHandler, utilBuildXlsx } from '../src/workflows/shared.mjs';

const workflows = [opsErrorHandler(), utilBuildXlsx()];
for (const mod of ['rfq.mjs', 'voice.mjs', 'payments.mjs', 'agent.mjs']) {
  if (fs.existsSync(path.join(ROOT, 'src', 'workflows', mod))) {
    const m = await import(new URL(`../src/workflows/${mod}`, import.meta.url));
    workflows.push(...m.default());
  }
}

const outDir = path.join(ROOT, 'workflows');
fs.mkdirSync(outDir, { recursive: true });
for (const f of fs.readdirSync(outDir)) if (f.endsWith('.json')) fs.unlinkSync(path.join(outDir, f));

workflows.forEach((wf, i) => {
  const slug = wf.name.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const file = path.join(outDir, `${String(i + 1).padStart(2, '0')}-${slug}.json`);
  fs.writeFileSync(file, JSON.stringify(wf.toJSON(), null, 2) + '\n');
  console.log(`${path.basename(file)}  (${wf.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote').length} nodes)`);
});
