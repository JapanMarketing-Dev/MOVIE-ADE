/**
 * 保存済みの LLM 生出力（llm-raw.json）から feedback.md を作り直す。
 * LLM を呼ばずに、検証・組み立て・出力の変更を既存の実測結果へ反映できる。
 *
 *   npx tsx tools/rebuild-outputs.ts <materialDir> [<materialDir> ...]
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { assembleFromOrganized } from '../../src/main/pipeline/assemble';
import { renderFeedbackMarkdown } from '../../src/main/pipeline/feedback';
import { validateOrganizeOutput } from '../../src/main/pipeline/organize/validate';
import { buildDraftDocument } from '../../src/main/pipeline/decompose';
import type { Material } from '../../src/main/pipeline/types';
import { evaluateOrganize, summarize } from './eval-organize';
import type { Truth } from './eval-organize';

for (const dir of process.argv.slice(2)) {
  const material: Material = JSON.parse(await readFile(join(dir, 'material.large-v3-turbo.json'), 'utf8'));
  const truth: Truth = JSON.parse(await readFile(join(dir, 'truth.json'), 'utf8'));
  const stage = buildDraftDocument(material);
  await writeFile(join(dir, 'out', 'feedback.draft.md'), renderFeedbackMarkdown(stage.document), 'utf8');

  const outRoot = join(dir, 'out');
  if (!existsSync(outRoot)) continue;
  for (const tag of await readdir(outRoot, { withFileTypes: true })) {
    if (!tag.isDirectory()) continue;
    const raw = join(outRoot, tag.name, 'llm-raw.json');
    if (!existsSync(raw)) continue;

    const parsed = JSON.parse(await readFile(raw, 'utf8'));
    const v = validateOrganizeOutput(parsed, stage.organizeInput);
    if (!v.ok || !v.value) {
      console.log(`${dir} / ${tag.name}: 検証不合格 — ${v.issues.filter((i) => i.level === 'error').map((i) => i.message).join(' / ')}`);
      continue;
    }
    const doc = assembleFromOrganized(material, v.value);
    await writeFile(join(outRoot, tag.name, 'feedback.md'), renderFeedbackMarkdown(doc), 'utf8');
    await writeFile(
      join(outRoot, tag.name, 'feedback.with-needs-check.md'),
      renderFeedbackMarkdown(doc, { includeNeedsCheck: true }),
      'utf8',
    );
    await writeFile(join(outRoot, tag.name, 'document.json'), JSON.stringify(doc, null, 2), 'utf8');

    const ev = evaluateOrganize(material, truth, v.value, doc);
    const warn = v.issues.filter((i) => i.level === 'warning');
    console.log(`### ${dir.split('/').pop()} / ${tag.name}`);
    console.log(`  ${summarize(ev)}`);
    if (warn.length > 0) console.log(`  検証の警告 ${warn.length}件: ${[...new Set(warn.map((w) => w.code))].join(', ')}`);
    await writeFile(join(outRoot, tag.name, 'eval.json'), JSON.stringify(ev, null, 2), 'utf8');
  }
}
