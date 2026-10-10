// The app's localStorage keys (STATE_KEY and SAVED_TOURNAMENTS_KEY in
// web/index.html), and the unprefixed legacy keys the app migrates from once.
// Page functions run in the browser and cannot see these: pass them in as the
// argument of page.evaluate / addInitScript.
module.exports = {
  STATE_KEY: 'padeltournament:tournamentState',
  SAVED_TOURNAMENTS_KEY: 'padeltournament:savedTournaments',
  LEGACY_STATE_KEY: 'tournamentState',
  LEGACY_SAVED_TOURNAMENTS_KEY: 'savedTournaments',
};
