Feature: Padel Turrar Tournament Manager

  Background:
    Given the tournament manager application is loaded

  # Scenario 1: Default Schedule Loading
  Scenario: Default schedule is loaded when no saved state exists
    Given localStorage is clear
    When I reload the page
    Then the player inputs should display 12 entries
    And the default schedule is loaded
    And the tournament title is "Tournament Title"

  # Scenario 2: Tournament Name Requirement and Uniqueness
  Scenario: Tournament name must be provided and be unique on start
    Given I clear localStorage
    And I enter an empty tournament name
    When I click "Start Tournament"
    Then I should see an alert "Tournament name must not be empty."
    And the tournament should not start

  Scenario: Auto-generate a unique saved tournament name on duplicate
    Given a tournament with the name "Test Tournament" is already saved
    When I enter "Test Tournament" as the tournament name and click "Start Tournament"
    Then the tournament starts with the tournament name "Test Tournament"
    And when I save the tournament, it is stored with a unique name such as 
      "Test Tournament-1" if a saved tournament with "Test Tournament" already exists

  # Scenario 3: Player Name Validation
  Scenario: Player names must be unique
    Given I load the default schedule
    And I set two player inputs to the same value "Player X"
    When I click "Start Tournament"
    Then I should see an alert "Player names must be unique."
    And the tournament should not start

  # Scenario 4: Score Input Auto-Calculation
  Scenario: Entering a score auto-calculates the opponent's score
    Given a global total of "24" points is selected
    And the tournament is started with a loaded schedule
    When I enter "10" into the left score input of a match
    Then the right score input of that match should display "14"

  # Scenario 5: State Persistence on Reload
  Scenario: Tournament state persists after page reload
    Given I start a tournament with tournament name "Persistent Tournament"
    And I enter a score "10" in the first match's left score input
    When I reload the page
    Then the tournament state should be restored
    And the tournament title should be "Persistent Tournament"
    And the first match's left score input should have the value "10"

