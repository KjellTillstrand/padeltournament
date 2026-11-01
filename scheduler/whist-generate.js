/************************************************************
 * whist-generate.js — perfect-mix schedule generator (R-PERFECT-MIX,
 * R-SPACED-MIX)
 *
 * Writes the shipped whist tables Wh(N) for N players (N divisible by 4):
 * N-1 rounds of N/4 matches in which every pair of players partners
 * exactly once and opposes exactly twice, with repeat encounters spaced
 * out and every player on every court.
 *
 * This file is the Node CLI only (arguments, report, file writes). The
 * construction, the spacing and court balancing stages and the independent
 * verifiers live in web/engine/whist.mjs, a plain ES module with no imports
 * that the in-browser engine shares; see its header for the method.
 *
 * Every generated schedule is checked by those verifiers, which count
 * meetings over the full round list. The script refuses to write any file
 * unless the partner matrix is all 1s, the opponent matrix is all 2s, no
 * player misses a court, and adjacent repeat encounters (verifySpacing) are
 * none with 4+ courts, or exactly the proven minimum with fewer (with 2
 * courts: all of them partner-adjacent, none back-to-back).
 *
 * Usage:
 *   node scheduler/whist-generate.js            # writes all five tables
 *   node scheduler/whist-generate.js 16 20      # writes selected sizes
 *   node scheduler/whist-generate.js --check    # generate + verify, no write
 *
 * Output: web/schedules/<N>p<N-1>r.js assigning window.schedule<N>p<N-1>r.
 * Deterministic: a fixed seed per size reproduces the same files.
 ************************************************************/

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const SIZES = [8, 12, 16, 20, 24];
const SCHEDULE_DIR = path.join(__dirname, '..', 'web', 'schedules');
const WHIST_MODULE = path.join(__dirname, '..', 'web', 'engine', 'whist.mjs');

function main(whist) {
  const {
    defaultSeed, spacedWhist, verifySchedule, courtSpread, verifySpacing,
    adjacentRepeatBound, zeroBackToBackRequired,
  } = whist;
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const requested = args.filter((a) => a !== '--check').map(Number);
  const sizes = requested.length ? requested : SIZES;

  let failed = false;
  for (const N of sizes) {
    if (!Number.isInteger(N) || N < 4 || N % 4 !== 0) {
      console.error(`Wh(${N}): player count must be a positive multiple of 4`);
      failed = true;
      continue;
    }
    const result = spacedWhist(N, defaultSeed(N));
    if (!result) {
      console.error(`Wh(${N}): no base round found within the search budget; nothing written`);
      failed = true;
      continue;
    }
    const { schedule } = result;
    const problems = verifySchedule(schedule);
    const spread = courtSpread(schedule);
    if (spread.missing.length) {
      problems.push(`players missing a court: ${spread.missing.join(', ')}`);
    }
    const spacing = verifySpacing(schedule);
    const adjacent = spacing.backToBack + spacing.partnerAdjacent;
    const bound = adjacentRepeatBound(N);
    if (bound === 0) {
      problems.push(...spacing.problems);
    } else if (adjacent !== bound) {
      // Fewer than the bound is impossible, so anything else is above it.
      problems.push(
        `${adjacent} adjacent repeat encounters; with ${N / 4} courts the minimum is ${bound} ` +
          '(adjacentRepeatBound) and a table must meet it exactly',
        ...spacing.problems
      );
    } else if (zeroBackToBackRequired(N) && spacing.backToBack > 0) {
      problems.push(
        `${spacing.backToBack} back-to-back oppositions; with ${N / 4} courts the ${bound} ` +
          'adjacent repeats must all be partner-adjacent (zeroBackToBackRequired)',
        ...spacing.problems
      );
    }
    const spacingLine =
      `  spacing: ${spacing.backToBack} back-to-back oppositions, ` +
      `${spacing.partnerAdjacent} partner-adjacent oppositions ` +
      `(${adjacent} adjacent repeats, minimum possible ${bound}), min meeting gap ${spacing.minGap} ` +
      `(winning seed offset +${result.candidate}; ${result.built} base rounds built from ` +
      `${result.tried} candidate seeds; ${result.evaluations} order evaluations)`;
    if (problems.length) {
      console.error(`Wh(${N}): VERIFICATION FAILED (${problems.length} problems); nothing written`);
      console.error(spacingLine);
      problems.slice(0, 20).forEach((p) => console.error(`  ${p}`));
      failed = true;
      continue;
    }
    const pairs = (N * (N - 1)) / 2;
    console.log(
      `Wh(${N}): verified — ${N - 1} rounds x ${N / 4} courts; ` +
        `${pairs} pairs all partnered 1x and opposed 2x (search restarts: ${result.restarts})`
    );
    console.log(`  court visits per player per court: min ${spread.min}, max ${spread.max}`);
    console.log(spacingLine);
    if (!checkOnly) {
      const name = `${N}p${N - 1}r`;
      const file = path.join(SCHEDULE_DIR, `${name}.js`);
      fs.writeFileSync(file, `window.schedule${name} = ${JSON.stringify(schedule, null, 2)}`);
      console.log(`  wrote ${path.relative(process.cwd(), file)}`);
    }
  }
  if (failed) process.exit(1);
}

// whist.mjs is an ES module, so it is loaded with import() (works on every
// supported Node version, unlike require() of an ES module).
if (require.main === module) {
  import(pathToFileURL(WHIST_MODULE).href).then(main);
}
