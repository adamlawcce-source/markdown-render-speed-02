// Driver for the markdown-render entry: renders every case in /input/cases.json
// with parse() from parse.js and writes the HTML strings, in order, to
// /output/html.json. Outside a container, MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR stand in for /input and /output.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

type Case = { id: string; markdown: string };

const cases: Case[] = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
const rendered: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) rendered[i] = parse(cases[i].markdown);
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));
