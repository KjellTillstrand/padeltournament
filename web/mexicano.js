/*
 * Mexicano pairing (R-MEXICANO-PAIRING, AB#58).
 *
 * Produces the next Mexicano round from the live standings. Round 1 is a
 * seeded random draw; every later round groups the ranking in fours (1st-4th,
 * 5th-8th, ...) and partners 1st & 4th against 2nd & 3rd within each group.
 * When the player count is not a multiple of four, the players with the fewest
 * rests so far sit the round out.
 *
 * A plain script with no build step: the browser gets window.Mexicano, Node
 * gets module.exports. Pure functions only - no DOM, no storage, no
 * Math.random - so the same inputs and seed always give the same round.
 *
 * Mexicano.nextRound({ players, standings, restCounts, roundNumber, seed })
 *   players      distinct ids (non-empty strings or non-negative integers), 8..24
 *   standings    the current ranking, best first: every player exactly once.
 *                Required from round 2 on; ignored (but validated) in round 1.
 *   restCounts   optional plain object, id -> rounds rested so far (missing = 0)
 *   roundNumber  integer >= 1; round 1 is the random draw
 *   seed         integer; required for round 1, the only round it affects
 * returns the app's round shape:
 *   { roundNumber, matches: [{ court, teams: [[a, b], [c, d]] }], byes: [...] }
 *   Court 1 holds the top group. byes is [] when the count is a multiple of 4.
 */
(function (root) {
  'use strict';

  const MIN_PLAYERS = 8;
  const MAX_PLAYERS = 24;

  // Same generator as scheduler/whist-generate.js, so seeds behave alike.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffled(arr, rand) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function fail(message) {
    throw new Error(`Mexicano.nextRound: ${message}`);
  }

  function isPlayerId(id) {
    return (typeof id === 'string' && id.length > 0) || (Number.isInteger(id) && id >= 0);
  }

  // Ids are keyed by their string form: restCounts is a plain object, so 1 and
  // "1" would be the same key and are therefore rejected as duplicates.
  function indexPlayers(players) {
    if (!Array.isArray(players)) fail('players must be an array');
    if (players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) {
      fail(`players must number ${MIN_PLAYERS} to ${MAX_PLAYERS}, got ${players.length}`);
    }
    const byKey = new Map();
    for (const id of players) {
      if (!isPlayerId(id)) fail(`invalid player id ${JSON.stringify(id)}`);
      if (byKey.has(String(id))) fail(`duplicate player id ${JSON.stringify(id)}`);
      byKey.set(String(id), id);
    }
    return byKey;
  }

  function checkStandings(standings, byKey) {
    if (!Array.isArray(standings)) fail('standings must be an array');
    const seen = new Set();
    for (const id of standings) {
      const key = String(id);
      if (byKey.get(key) !== id) fail(`standings names unknown player ${JSON.stringify(id)}`);
      if (seen.has(key)) fail(`standings lists ${JSON.stringify(id)} more than once`);
      seen.add(key);
    }
    if (seen.size !== byKey.size) fail('standings must rank every player exactly once');
  }

  function readRestCounts(restCounts, byKey) {
    if (restCounts === undefined || restCounts === null) return {};
    if (typeof restCounts !== 'object' || Array.isArray(restCounts)) {
      fail('restCounts must be a plain object of id -> rests');
    }
    for (const key of Object.keys(restCounts)) {
      if (!byKey.has(key)) fail(`restCounts names unknown player ${JSON.stringify(key)}`);
      const n = restCounts[key];
      if (!Number.isInteger(n) || n < 0) fail(`restCounts for ${JSON.stringify(key)} must be an integer >= 0`);
    }
    return restCounts;
  }

  function nextRound(options) {
    if (options === null || typeof options !== 'object') fail('expects an options object');
    const { players, standings, restCounts, roundNumber, seed } = options;
    const byKey = indexPlayers(players);
    if (!Number.isInteger(roundNumber) || roundNumber < 1) fail('roundNumber must be an integer >= 1');
    if (seed !== undefined && !Number.isInteger(seed)) fail('seed must be an integer');
    if (standings !== undefined) checkStandings(standings, byKey);
    const rests = readRestCounts(restCounts, byKey);

    let order;
    if (roundNumber === 1) {
      if (seed === undefined) fail('round 1 is a random draw and needs a seed');
      order = shuffled(players, mulberry32(seed));
    } else {
      if (standings === undefined) fail(`round ${roundNumber} pairs by standings, which are missing`);
      order = standings.slice();
    }

    // Fewest rests sit out; among equals the lowest-placed rests first, so the
    // top of the ranking keeps playing. In round 1 the order is the random draw.
    const restingCount = order.length % 4;
    const resting = new Set(
      order
        .map((id, position) => ({ id, position, rests: rests[String(id)] || 0 }))
        .sort((a, b) => a.rests - b.rests || b.position - a.position)
        .slice(0, restingCount)
        .map((entry) => entry.id),
    );

    const fielded = order.filter((id) => !resting.has(id));
    const matches = [];
    for (let i = 0; i < fielded.length; i += 4) {
      const [first, second, third, fourth] = fielded.slice(i, i + 4);
      matches.push({ court: i / 4 + 1, teams: [[first, fourth], [second, third]] });
    }
    return {
      roundNumber,
      matches,
      byes: order.filter((id) => resting.has(id)),
    };
  }

  const api = { nextRound, MIN_PLAYERS, MAX_PLAYERS };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.Mexicano = api;
})(typeof window !== 'undefined' ? window : undefined);
