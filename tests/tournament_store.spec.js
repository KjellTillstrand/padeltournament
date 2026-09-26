// tests/tournament_store.spec.js
const { test, expect } = require('@playwright/test');

// --- Screenplay kernel (Actor / Task / Question) ---
class Actor {
  constructor(name, page) {
    this.name = name;
    this.page = page; // ability: drive the UI
  }
  async attemptsTo(...tasks) {
    for (const task of tasks) await task(this);
  }
  async asksFor(question) {
    return question(this);
  }
}
const theOrganizer = (page) => new Actor('the Organizer', page);

// --- Tasks ---
const StartTheTournament = (tournamentName) => async (actor) => {
  await actor.page.fill('#tournamentName', tournamentName);
  await actor.page.click('#startTournamentBtn');
};

const NameAPlayer = (index, name) => async (actor) => {
  await actor.page.fill(`#playerInput_${index}`, name);
};

const RecordAScore = (leftScore) => async (actor) => {
  await actor.page.locator('.result-overlay-left input').first().fill(String(leftScore));
  await actor.page.waitForTimeout(200);
};

const SaveTheTournament = async (actor) => {
  await actor.page.click('#saveTournamentBtn');
  await actor.page.waitForTimeout(200);
};

const AdvanceToTheNextRound = async (actor) => {
  await actor.page.click('.round-header .center button:has-text("NEXT ROUND")');
  await actor.page.waitForTimeout(200);
};

const GoBackToThePreviousRound = async (actor) => {
  await actor.page.click('.round-header .center button:has-text("PREVIOUS ROUND")');
  await actor.page.waitForTimeout(200);
};

const StartANewTournament = async (actor) => {
  await actor.page.click('#newTournamentBtn');
  await actor.page.waitForTimeout(200);
};

const OpenTheSettings = async (actor) => {
  await actor.page.click('#toggleSettingsBtn');
};

const DeleteTheTournament = async (actor) => {
  await actor.page.click('#deleteTournamentBtn');
  await actor.page.waitForTimeout(200);
};

const LoadTheTournamentNamed = (tournamentName) => async (actor) => {
  const dropdown = actor.page.locator('#savedTournamentSelect');
  const option = dropdown.locator('option', { hasText: tournamentName });
  const value = await option.getAttribute('value');
  await dropdown.selectOption(value);
  await actor.page.click('#loadTournamentBtn');
  await actor.page.waitForTimeout(200);
};

// --- Questions ---
const SavedTournamentNames = async (actor) => {
  const saved = await actor.page.evaluate(() =>
    JSON.parse(localStorage.getItem('savedTournaments') || '[]')
  );
  return saved.map((t) => t.tournamentName);
};

const TheDisplayedRoundTitle = async (actor) =>
  actor.page.locator('.round-header .left').textContent();

test.describe('R-TOURNAMENT-STORE: Saving, loading and deleting tournaments', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  });

  // @verifies REQ-11
  test('R-TOURNAMENT-STORE: Saving adds the tournament to the saved list', async ({ page }) => {
    const organizer = theOrganizer(page);
    page.on('dialog', (dialog) => dialog.accept());

    // Given a tournament in progress named "Spring Cup".
    await organizer.attemptsTo(StartTheTournament('Spring Cup'));

    // When the Organizer saves the tournament.
    await organizer.attemptsTo(SaveTheTournament);

    // Then "Spring Cup" shall appear among the saved tournaments.
    expect(await organizer.asksFor(SavedTournamentNames)).toContain('Spring Cup');
  });

  // @verifies REQ-11
  test('R-TOURNAMENT-STORE: Loading restores a saved tournament', async ({ page }) => {
    const organizer = theOrganizer(page);
    page.on('dialog', (dialog) => dialog.dismiss());

    // Given "Spring Cup" is among the saved tournaments, with a custom player name,
    // a recorded score, and advanced to round 2.
    await organizer.attemptsTo(NameAPlayer(0, 'Ada'));
    await organizer.attemptsTo(StartTheTournament('Spring Cup'));
    await organizer.attemptsTo(RecordAScore(10));
    await organizer.attemptsTo(AdvanceToTheNextRound);
    await organizer.attemptsTo(SaveTheTournament);
    await organizer.attemptsTo(StartANewTournament);

    // When the Organizer loads "Spring Cup".
    await organizer.attemptsTo(LoadTheTournamentNamed('Spring Cup'));

    // Then its round, scores and names shall be restored.
    await expect(page.locator('#tournamentTitle')).toHaveText('Spring Cup');
    expect(await organizer.asksFor(TheDisplayedRoundTitle)).toBe('Round 2');
    await expect(page.locator('.scoreboard-container')).toContainText('Ada');

    // And the score recorded back on round 1 is still there.
    await organizer.attemptsTo(GoBackToThePreviousRound);
    const restoredScore = await page.locator('.result-overlay-left input').first().inputValue();
    expect(restoredScore).toBe('10');
  });

  // @verifies REQ-11
  test('R-TOURNAMENT-STORE: Loading a legacy save without a round position starts at round 1', async ({ page }) => {
    const organizer = theOrganizer(page);
    page.on('dialog', (dialog) => dialog.dismiss());

    // Given "Spring Cup" is among the saved tournaments, saved before the round
    // position was tracked (no currentRoundIndex field on the saved entry).
    await organizer.attemptsTo(StartTheTournament('Spring Cup'));
    await organizer.attemptsTo(AdvanceToTheNextRound);
    await organizer.attemptsTo(SaveTheTournament);
    await page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem('savedTournaments') || '[]');
      delete saved[0].currentRoundIndex;
      localStorage.setItem('savedTournaments', JSON.stringify(saved));
    });
    await organizer.attemptsTo(StartANewTournament);

    // When the Organizer loads "Spring Cup".
    await organizer.attemptsTo(LoadTheTournamentNamed('Spring Cup'));

    // Then it shall load at round 1 rather than crash or misbehave.
    expect(await organizer.asksFor(TheDisplayedRoundTitle)).toBe('Round 1');
  });

  // @verifies REQ-11
  test('R-TOURNAMENT-STORE: Deleting removes a saved tournament', async ({ page }) => {
    const organizer = theOrganizer(page);
    page.on('dialog', (dialog) => dialog.accept());

    // Given "Spring Cup" is among the saved tournaments.
    await organizer.attemptsTo(StartTheTournament('Spring Cup'));
    await organizer.attemptsTo(SaveTheTournament);
    expect(await organizer.asksFor(SavedTournamentNames)).toContain('Spring Cup');

    // When the Organizer deletes "Spring Cup".
    await organizer.attemptsTo(OpenTheSettings);
    await organizer.attemptsTo(DeleteTheTournament);

    // Then "Spring Cup" shall no longer appear among the saved tournaments.
    expect(await organizer.asksFor(SavedTournamentNames)).not.toContain('Spring Cup');
  });

  // @verifies REQ-11
  test('R-TOURNAMENT-STORE: Starting anew offers to keep the current tournament', async ({ page }) => {
    const organizer = theOrganizer(page);
    const dialogMessages = [];
    // newTournament() raises a confirm dialog, then (regardless of the answer) an
    // informational alert; dismiss every dialog seen and record what they said.
    page.on('dialog', async (dialog) => {
      dialogMessages.push(dialog.message());
      await dialog.dismiss();
    });

    // Given a tournament in progress.
    await organizer.attemptsTo(StartTheTournament('Autumn Cup'));

    // When the Organizer starts a new tournament.
    await organizer.attemptsTo(StartANewTournament);

    // Then the Organizer shall be offered to save the current tournament before it is cleared.
    expect(dialogMessages[0]).toBe('Do you want to save the current tournament before creating a new one?');
  });
});
