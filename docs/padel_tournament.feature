Feature: Padel Turrar Tournament Manager
  Two formats: Americano plays a preconfigured rotating-partner schedule;
  Mexicano generates its rounds one at a time, round 1 as a random draw and
  every later round from the live standings. The board's Requirements
  (R-<TAG> titles) are the acceptance contract; these scenarios summarise them.

  Background:
    Given the tournament manager application is loaded

  # Scenario 1: Default Setup
  Scenario: The default setup is loaded when no saved state exists
    Given localStorage is clear
    When I reload the page
    Then the format is "Americano"
    And the 12-player schedule is selected
    And the player inputs should display 12 entries
    And the tournament title is "Tournament Title"

  # Scenario 2: Format Selection
  Scenario: Choosing Mexicano switches the setup
    Given localStorage is clear
    When I choose the format "Mexicano"
    Then the schedule selector is hidden
    And a player count from 8 to 24 is offered, with 12 selected
    And the points per game can still be chosen

  Scenario Outline: The format survives a reload
    Given a tournament started as <format>
    When I reload the page
    Then the format is "<format>"

    Examples:
      | format    |
      | Americano |
      | Mexicano  |

  # Scenario 3: Americano Schedule Selection
  Scenario Outline: Every player count from 8 to 24 has a schedule
    Given the format is "Americano"
    When I select the <players>-player schedule
    Then a schedule for <players> players is loaded
    And it runs <rounds> rounds
    And <courts> courts are presented
    And <resting> players rest each round

    Examples:
      | players | rounds | courts | resting |
      | 8       | 7      | 2      | 0       |
      | 9       | 9      | 2      | 1       |
      | 10      | 10     | 2      | 2       |
      | 11      | 11     | 2      | 3       |
      | 12      | 11     | 3      | 0       |
      | 13      | 13     | 3      | 1       |
      | 14      | 14     | 3      | 2       |
      | 15      | 15     | 3      | 3       |
      | 16      | 15     | 4      | 0       |
      | 17      | 17     | 4      | 1       |
      | 18      | 18     | 4      | 2       |
      | 19      | 19     | 4      | 3       |
      | 20      | 19     | 5      | 0       |
      | 21      | 21     | 5      | 1       |
      | 22      | 22     | 5      | 2       |
      | 23      | 23     | 5      | 3       |
      | 24      | 23     | 6      | 0       |

  # Scenario 4: Tournament Name Requirement and Uniqueness
  Scenario: Tournament name must be provided on start
    Given I clear localStorage
    And I enter an empty tournament name
    When I click "Start Tournament"
    Then I should see an alert "Tournament name must not be empty."
    And the tournament should not start

  Scenario: A duplicate tournament name is made unique on start
    Given a tournament with the name "Test Tournament" is already saved
    When I enter "Test Tournament" as the tournament name and click "Start Tournament"
    Then the tournament starts with the tournament name "Test Tournament-1"
    And saving it stores it as "Test Tournament-1" beside the saved "Test Tournament"

  # Scenario 5: Player Name Validation
  Scenario Outline: Player names must be unique
    Given the format is "<format>"
    And I set two player inputs to the same value "Player X"
    When I click "Start Tournament"
    Then I should see an alert "Player names must be unique."
    And the tournament should not start

    Examples:
      | format    |
      | Americano |
      | Mexicano  |

  # Scenario 6: Points per Game and Score Input Auto-Calculation
  Scenario Outline: Entering a score auto-calculates the opponent's score
    Given a points total of "<total>" is selected (16, 21, 24 or 32; default 24)
    And the tournament is started
    When I enter "<entered>" into the left score input of a match
    Then the right score input of that match should display "<complement>"

    Examples:
      | total | entered | complement |
      | 24    | 10      | 14         |
      | 32    | 20      | 12         |
      | 21    | 15      | 6          |

  # Scenario 7: Mexicano Rounds
  Scenario: A Mexicano starts with a random draw
    Given the format is "Mexicano" with 10 players
    When I start the tournament
    Then round 1 is drawn at random, with every fielded player in exactly one match
    And 2 players rest, shown above the courts

  Scenario: The next Mexicano round waits for every score
    Given a Mexicano round with a match missing its score
    When I click "GENERATE NEXT ROUND"
    Then no round is generated and no confirmation opens
    And the refusal is announced again, naming and marking the courts still waiting for a valid score
    And the button stays focusable and clickable: it is marked aria-disabled, never disabled

  Scenario: Generating the next Mexicano round asks to confirm, then locks the round
    Given a Mexicano round in which every match has a valid score
    When I click "GENERATE NEXT ROUND"
    Then every match of the round is shown with both teams and their scores
    And no round is generated until I confirm
    When I confirm
    Then the next round is paired from the standings in groups of four by rank
    And within each group 1st and 4th play against 2nd and 3rd
    And the top group plays on court 1
    And the earlier round stays viewable but its scores can no longer be edited

  Scenario: Mexicano rests go to the fewest rested, before rank
    Given a Mexicano with a player count that is not a multiple of 4
    When the next round is generated
    Then the players with the fewest rests so far rest, even a top-ranked one
    And among equally rested players the lowest-ranked rests first
    And among equally rested players who share a placement, the one later in the player list rests first

  Scenario: Americano scores stay editable
    Given an Americano tournament
    When I navigate between rounds
    Then every round's scores remain editable

  # Scenario 8: Standings and Tiebreak
  Scenario: A two-way tie is resolved head-to-head
    Given two players end level on points
    And they opposed each other and one of them scored more points across their mutual games
    When I review the standings
    Then that player ranks higher

  Scenario: A two-way tie level even head-to-head is shared
    Given two players end level on points
    And they opposed each other and their mutual games are level
    When I review the standings
    Then both share the same placement

  Scenario: Other ties share their placement, by competition ranking
    Given two players level on points who never opposed each other
    When I review the standings
    Then both share first place and are gold
    And the next player is placed third and is bronze, with no second place
    And a tie of three or more players is always shared
    And players who share a placement are listed in player-list order

  # Scenario 9: State Persistence on Reload
  Scenario: Tournament state persists after page reload
    Given I start a tournament with tournament name "Persistent Tournament"
    And I enter a score "10" in the first match's left score input
    When I reload the page
    Then the tournament state should be restored
    And the tournament title should be "Persistent Tournament"
    And the first match's left score input should have the value "10"

  # Scenario 10: Saved Tournaments
  Scenario: Save from the round header, load and delete from the settings panel
    Given a tournament in progress named "Spring Cup"
    When I click "Save Tournament" in the round header
    Then "Spring Cup" is listed among the saved tournaments in the settings panel
    And it can be loaded or deleted there with "Load Tournament" and "Delete Tournament"
