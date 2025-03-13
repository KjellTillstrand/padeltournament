/******************************************************
 * Example: Backtracking Doubles Schedule for 12 players
 * with unique partners each round & minimal repeat opponents
 ******************************************************/

const NUM_PLAYERS = 12;
const NUM_ROUNDS = NUM_PLAYERS - 1; // 11 for 12 players

// Players array
const players = Array.from({ length: NUM_PLAYERS }, (_, i) => "P" + (i + 1));

// Data structures for constraints
// partnerUsed[pA][pB] = true if pA has partnered with pB
// meetCount[pA][pB] = how many times pA faced pB as an opponent
const partnerUsed = {};
const meetCount = {};

// Helper: create nested objects for each player
players.forEach(p => {
  partnerUsed[p] = {};
  meetCount[p] = {};
  players.forEach(o => {
    partnerUsed[p][o] = false;
    meetCount[p][o] = 0;
  });
});

// We'll store the final schedule here: array of rounds
// Each round is: { roundNumber, matches }
// Each match is: { court, teams: [ [pA, pB], [pC, pD] ] }
const schedule = [];

/******************************************************
 * Attempt to build the entire schedule round by round
 ******************************************************/
function solveSchedule(roundIndex = 1) {
  if (roundIndex > NUM_ROUNDS) {
    // We have successfully built all rounds
    return true;
  }

  // 1) Form 6 pairs for this round that haven't partnered yet
  const pairs = formPairsUniquePartner();
  if (!pairs) {
    return false; // no valid pairing arrangement => backtrack
  }

  // 2) Now we have 6 pairs, we want to group them into 3 matches
  //    so that each pair meets the opponent pair with minimal repeated matchups
  const matches = formMatchesWithMinRepeats(pairs);
  if (!matches) {
    // Could not form valid matches => revert partnership usage & backtrack
    // Mark these pairs as "unused" again
    for (let [pA, pB] of pairs) {
      partnerUsed[pA][pB] = false;
      partnerUsed[pB][pA] = false;
    }
    return false;
  }

  // 3) If we formed matches successfully, update meetCount
  //    and finalize the round in 'schedule'
  const thisRound = {
    roundNumber: roundIndex,
    matches: []
  };
  let courtNum = 1;
  for (let [teamA, teamB] of matches) {
    // teamA and teamB are each an array of 2 players
    // update meetCount
    for (let pA of teamA) {
      for (let pB of teamB) {
        meetCount[pA][pB]++;
        meetCount[pB][pA]++;
      }
    }
    thisRound.matches.push({
      court: courtNum,
      teams: [teamA, teamB]
    });
    courtNum++;
  }
  schedule.push(thisRound);

  // 4) Recurse to next round
  if (solveSchedule(roundIndex + 1)) {
    return true;
  }

  // 5) If recursion failed, revert usage, revert meetCounts, remove round from schedule
  schedule.pop(); // remove this round

  for (let [teamA, teamB] of matches) {
    for (let pA of teamA) {
      for (let pB of teamB) {
        meetCount[pA][pB]--;
        meetCount[pB][pA]--;
      }
    }
  }
  // revert partner usage for pairs
  for (let [pA, pB] of pairs) {
    partnerUsed[pA][pB] = false;
    partnerUsed[pB][pA] = false;
  }

  return false;
}

/******************************************************
 * 1) Form 6 pairs such that no two players have
 *    partnered before.
 *
 * We'll do a backtracking approach, picking pairs
 * one by one from the pool of 12 players.
 ******************************************************/
function formPairsUniquePartner() {
  let unusedPlayers = [...players];
  // We'll build up pairs as [ [pA, pB], [pC, pD], ... ]
  const pairs = [];

  function backtrackPairs() {
    if (unusedPlayers.length === 0) {
      return true; // formed all 6 pairs
    }
    let pA = unusedPlayers[0];
    for (let i = 1; i < unusedPlayers.length; i++) {
      let pB = unusedPlayers[i];
      // Check partnerUsed constraint
      if (!partnerUsed[pA][pB]) {
        // pair them
        partnerUsed[pA][pB] = true;
        partnerUsed[pB][pA] = true;
        // remove from unusedPlayers
        const savedP1 = pA;
        const savedP2 = pB;
        // We'll remove pA and pB from the array
        unusedPlayers.splice(i, 1);
        unusedPlayers.splice(0, 1);
        pairs.push([pA, pB]);

        if (backtrackPairs()) {
          return true;
        }
        // revert
        pairs.pop();
        partnerUsed[savedP1][savedP2] = false;
        partnerUsed[savedP2][savedP1] = false;
        // re-insert pB first to maintain correct order, then pA
        unusedPlayers.splice(0, 0, savedP1);
        unusedPlayers.splice(i, 0, savedP2);
      }
    }
    return false; // no pair for pA worked
  }

  if (backtrackPairs()) {
    return pairs;
  } else {
    return null;
  }
}

/******************************************************
 * 2) formMatchesWithMinRepeats:
 *    We have 6 pairs. We want to group them into 3 matches
 *    such that the sum of meetCount is minimized.
 *
 *    We'll do a small backtracking or a simple
 *    "pair them up in all ways" approach, then pick
 *    arrangement with minimal sum of meetCount
 ******************************************************/
function formMatchesWithMinRepeats(pairs) {
  // pairs is array of length 6, each is [pA, pB]

  // We want to form 3 matches: each match has 2 pairs => 2 vs 2
  // We'll try all permutations of these 6 pairs in groups of 2
  // Then pick the arrangement that yields minimal sum of meetCounts
  const allIndexes = [0,1,2,3,4,5];
  let bestArrangement = null;
  let bestScore = Infinity;

  // We'll do a naive approach: generate all ways to partition 6 items into 3 pairs
  let used = Array(6).fill(false);
  let chosen = [];

  function backtrackMatch() {
    // if chosen has 3 elements => 3 matches
    if (chosen.length === 3) {
      // compute sum of meetCount for this arrangement
      let sum = 0;
      for (let [iA, iB] of chosen) {
        const teamA = pairs[iA];
        const teamB = pairs[iB];
        // sum up cross pair meetCounts
        for (let pA of teamA) {
          for (let pB of teamB) {
            sum += meetCount[pA][pB];
          }
        }
      }
      if (sum < bestScore) {
        bestScore = sum;
        bestArrangement = chosen.map(x => x.slice()); // copy
      }
      return;
    }
    // pick first available pair
    let first = -1;
    for (let i=0; i<6; i++) {
      if (!used[i]) {
        first = i;
        break;
      }
    }
    if (first < 0) return; // should not happen

    used[first] = true;
    // try to pair 'first' with any unused j
    for (let j=first+1; j<6; j++) {
      if (!used[j]) {
        used[j] = true;
        chosen.push([first, j]);
        backtrackMatch();
        chosen.pop();
        used[j] = false;
      }
    }
    used[first] = false;
  }

  backtrackMatch();
  if (!bestArrangement) return null;

  // Construct final array of matches (pairs of pairs)
  // bestArrangement is an array of 3 elements, each is [iA, iB]
  let result = [];
  let courtNum = 1;
  for (let [iA, iB] of bestArrangement) {
    result.push([ pairs[iA], pairs[iB] ]);
  }
  return result;
}

/******************************************************
 * Attempt to build entire schedule
 ******************************************************/
if (solveSchedule(1)) {
  // success
  console.log("Solution found!");
  // Print the schedule as JSON
  const final = {
    playerCount: NUM_PLAYERS,
    totalRounds: NUM_ROUNDS,
    players: [...players],
    rounds: schedule
  };
  console.log(JSON.stringify(final, null, 2));
} else {
  console.log("No solution found");
}
