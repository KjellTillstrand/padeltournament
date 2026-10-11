// The app's localStorage keys (STATE_KEY, SAVED_TOURNAMENTS_KEY and
// STATE_BACKUP_KEY in web/index.html), the unprefixed legacy keys the app
// migrates from once, and the markers that record each done migration.
// Page functions run in the browser and cannot see these: pass them in as the
// argument of page.evaluate / addInitScript.
module.exports = {
  STATE_KEY: 'padeltournament:tournamentState',
  SAVED_TOURNAMENTS_KEY: 'padeltournament:savedTournaments',
  STATE_BACKUP_KEY: 'padeltournament:tournamentState.backup',
  LEGACY_STATE_KEY: 'tournamentState',
  LEGACY_SAVED_TOURNAMENTS_KEY: 'savedTournaments',
  STATE_MIGRATED_KEY: 'padeltournament:migrated:tournamentState',
  SAVED_TOURNAMENTS_MIGRATED_KEY: 'padeltournament:migrated:savedTournaments',
};
