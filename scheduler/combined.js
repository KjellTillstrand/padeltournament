/************************************************************
 * multi_run_random_pairs.js (Dynamic Courts + Save Best Schedule)
 *
 * - We run the solver multiple times (RUNS times).
 * - Each run:
 *    1) Re-initializes data structures.
 *    2) Shuffles the global players array.
 *    3) Builds a schedule round-by-round with extra randomization:
 *       * In forming pairs, we shuffle the "unused" players at each step.
 *       * We also shuffle the order of potential partners for pA.
 *       * Then we group the pairs into matches (each match uses 2 pairs)
 *         with the goal of minimizing repeated opponent meetings.
 *    4) If successful, compute the standard deviation (stdev) from 2
 *       for the head-to-head matrix.
 *    5) After all runs, the schedule with the lowest stdev is saved to a file:
 *       "standardXpYr.json", where X is the number of players and Y is the number of rounds.
 ************************************************************/

const fs = require('fs'); // Node's file system module

const NUM_PLAYERS = 12;                 // Change as needed; must be even and divisible by 4
const NUM_ROUNDS = NUM_PLAYERS - 1;       // Standard round-robin rounds for unique partners
const RUNS = 11000;                     // Number of times to attempt

let playersGlobal = [];
let partnerUsed = {};
let meetCount = {};
let schedule = [];

let bestSolution = null;
let bestStdev = Infinity;

/******************************************************
 * main: run the multi-run approach
 ******************************************************/
async function main() {
  for (let runIndex = 1; runIndex <= RUNS; runIndex++) {
    console.log(`=== Run ${runIndex} of ${RUNS} ===`);

    initDataStructures();
    shuffleArray(playersGlobal);

    if (solveSchedule()) {
      const finalSchedule = buildScheduleObject();
      const matrix = createHeadToHeadMatrix(finalSchedule);
      const stdevVal = stdevFrom2(matrix);
      console.log(`Run ${runIndex} => stdev=${stdevVal.toFixed(3)}`);

      if (stdevVal < bestStdev) {
        bestStdev = stdevVal;
        bestSolution = finalSchedule;
      }
    } else {
      console.log(`Run ${runIndex} => No solution found`);
    }
  }

  if (bestSolution) {
    console.log("\n=== BEST SOLUTION FOUND ===");
    console.log(`stdev from 2 = ${bestStdev.toFixed(3)}`);
    console.log(JSON.stringify(bestSolution, null, 2));

    const matrix = createHeadToHeadMatrix(bestSolution);
    const verifyOk = verifyAllPairsTwice(matrix);
    console.log(verifyOk ? "OK - every pair is 2" : "Not every pair is 2. (But we have stdev measure anyway.)");
    console.log(matrixToCSV(matrix));

    console.log(`stdev from 2 = ${bestStdev.toFixed(3)}`);

    // Build file name: "standardXpYr.json"
    const fileName = `${NUM_PLAYERS}p${NUM_ROUNDS}r.json`;
    fs.writeFileSync(fileName, JSON.stringify(bestSolution, null, 2));
    console.log(`Best schedule saved to file "${fileName}"`);
  } else {
    console.log("No solution found in any run.");
  }
}

/******************************************************
 * initDataStructures: re-init global data for a run
 ******************************************************/
function initDataStructures() {
  playersGlobal = Array.from({ length: NUM_PLAYERS }, (_, i) => "P" + (i + 1));

  partnerUsed = {};
  meetCount = {};
  playersGlobal.forEach(p => {
    partnerUsed[p] = {};
    meetCount[p] = {};
    playersGlobal.forEach(o => {
      partnerUsed[p][o] = false;
      meetCount[p][o] = 0;
    });
  });

  schedule = [];
}

/******************************************************
 * shuffleArray: in-place Fisher–Yates shuffle
 ******************************************************/
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/******************************************************
 * solveSchedule: recursively build all rounds.
 * Number of rounds = NUM_ROUNDS.
 ******************************************************/
function solveSchedule(roundIndex = 1) {
  if (roundIndex > NUM_ROUNDS) {
    return true;
  }
  const pairs = formPairsUniquePartner();
  if (!pairs) return false;

  const matches = formMatchesWithMinRepeats(pairs);
  if (!matches) {
    for (let [pA, pB] of pairs) {
      partnerUsed[pA][pB] = false;
      partnerUsed[pB][pA] = false;
    }
    return false;
  }

  const roundObj = { roundNumber: roundIndex, matches: [] };
  // Number of courts = NUM_PLAYERS/4
  let numCourts = pairs.length / 2;
  let courtNum = 1;
  for (let [teamA, teamB] of matches) {
    for (let pA of teamA) {
      for (let pB of teamB) {
        meetCount[pA][pB]++;
        meetCount[pB][pA]++;
      }
    }
    roundObj.matches.push({
      court: courtNum,
      teams: [teamA, teamB]
    });
    courtNum++;
  }
  schedule.push(roundObj);

  if (solveSchedule(roundIndex + 1)) return true;

  // Revert changes on backtracking:
  schedule.pop();
  for (let [teamA, teamB] of matches) {
    for (let pA of teamA) {
      for (let pB of teamB) {
        meetCount[pA][pB]--;
        meetCount[pB][pA]--;
      }
    }
  }
  for (let [pA, pB] of pairs) {
    partnerUsed[pA][pB] = false;
    partnerUsed[pB][pA] = false;
  }
  return false;
}

/******************************************************
 * formPairsUniquePartner:
 *   Create NUM_PLAYERS/2 pairs among all players,
 *   ensuring no repeated partnership.
 *   Randomize the unused list and candidate partners.
 ******************************************************/
function formPairsUniquePartner() {
  let pairs = [];
  let unused = [...playersGlobal];

  function backtrackPairs() {
    if (unused.length === 0) return true;

    shuffleArray(unused);
    const pA = unused[0];
    let candidates = [];
    for (let i = 1; i < unused.length; i++) {
      const pB = unused[i];
      if (!partnerUsed[pA][pB]) {
        candidates.push(pB);
      }
    }
    if (candidates.length === 0) return false;
    shuffleArray(candidates);

    for (let pB of candidates) {
      partnerUsed[pA][pB] = true;
      partnerUsed[pB][pA] = true;

      const idxB = unused.indexOf(pB);
      unused.splice(idxB, 1);
      unused.splice(0, 1);
      pairs.push([pA, pB]);

      if (backtrackPairs()) return true;

      pairs.pop();
      partnerUsed[pA][pB] = false;
      partnerUsed[pB][pA] = false;
      unused.splice(0, 0, pA);
      unused.splice(idxB, 0, pB);
    }
    return false;
  }

  if (backtrackPairs()) {
    return pairs;
  }
  return null;
}

/******************************************************
 * formMatchesWithMinRepeats:
 *   Given all pairs (dynamic number: NUM_PLAYERS/2),
 *   group them into matches (each match has 2 pairs)
 *   so that the sum of meetCount for cross-team pairings
 *   is minimized.
 *   Dynamic: number of matches = pairs.length/2.
 ******************************************************/
function formMatchesWithMinRepeats(pairs) {
  const numPairs = pairs.length;
  const numMatches = numPairs / 2;
  const used = Array(numPairs).fill(false);
  const chosen = [];
  let bestArrangement = null;
  let bestScore = Infinity;

  function backtrackMatch() {
    if (chosen.length === numMatches) {
      let sum = 0;
      for (let [iA, iB] of chosen) {
        const teamA = pairs[iA];
        const teamB = pairs[iB];
        for (let pA of teamA) {
          for (let pB of teamB) {
            sum += meetCount[pA][pB];
          }
        }
      }
      if (sum < bestScore) {
        bestScore = sum;
        bestArrangement = chosen.map(x => x.slice());
      }
      return;
    }
    let first = -1;
    for (let i = 0; i < numPairs; i++) {
      if (!used[i]) { first = i; break; }
    }
    if (first < 0) return;
    used[first] = true;
    let candidates = [];
    for (let j = first + 1; j < numPairs; j++) {
      if (!used[j]) candidates.push(j);
    }
    shuffleArray(candidates);
    for (let j of candidates) {
      used[j] = true;
      chosen.push([first, j]);
      backtrackMatch();
      chosen.pop();
      used[j] = false;
    }
    used[first] = false;
  }

  backtrackMatch();
  if (!bestArrangement) return null;
  let result = [];
  for (let [iA, iB] of bestArrangement) {
    result.push([pairs[iA], pairs[iB]]);
  }
  return result;
}

//--------------------------------------
// Build final schedule object
//--------------------------------------
function buildScheduleObject() {
  return {
    playerCount: NUM_PLAYERS,
    totalRounds: NUM_ROUNDS,
    players: playersGlobal.slice(),
    rounds: schedule
  };
}

/******************************************************
 * Helper functions for analysis:
 * createHeadToHeadMatrix, stdevFrom2, verifyAllPairsTwice,
 * matrixToCSV
 ******************************************************/
function createHeadToHeadMatrix(scheduleObj) {
  const playersArr = scheduleObj.players;
  const mat = {};
  playersArr.forEach(p => {
    mat[p] = {};
    playersArr.forEach(o => {
      mat[p][o] = 0;
    });
  });
  scheduleObj.rounds.forEach(r => {
    r.matches.forEach(m => {
      const [teamA, teamB] = m.teams;
      teamA.forEach(a => {
        teamB.forEach(b => {
          mat[a][b]++;
          mat[b][a]++;
        });
      });
    });
  });
  return mat;
}

function stdevFrom2(mat) {
  const pList = Object.keys(mat);
  const values = [];
  for (let i = 0; i < pList.length; i++) {
    for (let j = 0; j < pList.length; j++) {
      if (i !== j) {
        let pA = pList[i];
        let pB = pList[j];
        values.push(mat[pA][pB]);
      }
    }
  }
  let sumSq = 0;
  for (let val of values) {
    let diff = val - 2;
    sumSq += diff * diff;
  }
  let meanSq = sumSq / values.length;
  return Math.sqrt(meanSq);
}

function verifyAllPairsTwice(mat) {
  const pList = Object.keys(mat);
  for (let i = 0; i < pList.length; i++) {
    for (let j = i + 1; j < pList.length; j++) {
      const pA = pList[i], pB = pList[j];
      if (mat[pA][pB] !== 2) {
        console.log("Mismatch:", pA, pB, "=", mat[pA][pB]);
        return false;
      }
    }
  }
  return true;
}

function matrixToCSV(mat) {
  const pList = Object.keys(mat);
  let csv = "Player," + pList.join(",") + "\n";
  pList.forEach(p => {
    let row = [p];
    pList.forEach(o => {
      row.push(mat[p][o]);
    });
    csv += row.join(",") + "\n";
  });
  return csv;
}

//--------------------------------------
// Run main
//--------------------------------------
main();
