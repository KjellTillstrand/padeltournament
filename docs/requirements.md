# Padel Turrar Tournament Manager Requirements

This document outlines the functional and non-functional requirements for the Padel Turrar Tournament Manager application.

## Functional Requirements

### 1. Format and Schedule Selection
- **Format Choice:**  
  - At setup the user chooses the tournament format: **Americano** (the default) or **Mexicano**.
  - Americano plays a preconfigured, rotating-partner schedule. Mexicano has no precomputed schedule: its rounds are generated one at a time, round 1 as a random draw and every later round from the live standings (see §5).
  - The chosen format is saved right away, so it survives a page reload both before and after the tournament starts, and it is stored with every saved tournament. Tournaments saved before formats existed load as Americano.
- **Americano Schedule Choice:**  
  - The user can choose from several preconfigured schedules, one for every player count from 8 to 24.
  - Each schedule is stored as a separate JavaScript file (e.g. `12p11r.js`, `13p13r.js`, etc.) that sets a global table (e.g. `window.schedule12p11r`). Every table is loaded up front by its own `<script>` tag in the page head, so each option in the schedule selector needs a matching script tag; choosing a schedule only looks up the table already loaded.
  - A player count that is a multiple of 4 plays every player every round (N - 1 rounds). Any other count fills floor(N/4) courts and the remaining players rest each round; its schedule runs N rounds, so every player rests the same number of times (N mod 4) and plays the same number of games. Each round shows which players rest.
- **Mexicano Setup:**  
  - The user chooses a player count from 8 to 24 (default 12) and the points per game; there is no schedule to choose.
  - At any count that is not a multiple of 4, floor(N/4) courts play and the remaining players rest each round, shown above the courts as in Americano.
  
### 2. Global Controls
- **Global Total Points:**  
  - The user can select the total points per game (options: 16, 21, 24 or 32; default 24). The selected total governs every match in both formats.
  - With the odd total of 21 a game cannot end level.
  - The total is fixed once the tournament starts and is stored with the tournament.
- **Tournament Name:**  
  - The user must provide a tournament name before starting the tournament.
  - The application will validate that the name is not empty.
  - If the name already exists in saved tournaments, the system will append a hyphen and a number (or increment the number) to ensure uniqueness.
- **State Persistence:**  
  - The state (format, selected schedule or Mexicano player count, points total, current round, scores, tournament name, and custom settings such as court names) is automatically saved to and restored from localStorage so that progress is retained across page reloads or crashes.

### 3. Player Management
- **Player Name Inputs:**  
  - A table or grid of input fields (one per player) is generated dynamically: in Americano from the players of the selected schedule, in Mexicano from the chosen player count.
  - Each player has an input field with a default placeholder (e.g., "P1", "P2", ...).
  - When validating, empty inputs are replaced with their default placeholder values.
  - Player names must be unique; the application will warn the user if duplicates are detected.
  - Changes to player names immediately update the tournament state and match team names.

### 4. Court Customization
- **Custom Court Names:**  
  - There is a dedicated settings section where the user can provide custom names for each court.
  - By default, courts are labeled "Court 1", "Court 2", etc.
  - Custom court names are saved as part of the tournament state and used when rendering the matches.

### 5. Tournament Workflow
- **Start Tournament:**  
  - When starting the tournament, the application validates that a tournament name is provided (and auto-generates a unique name if necessary).
  - Player names are randomized if needed.
  - The settings are disabled and hidden from view once the tournament starts.
- **Round Navigation:**  
  - The interface displays the current round along with navigation controls.
  - The round header includes:
    - A left-aligned element for the round title.
    - A center section featuring "PREVIOUS ROUND" and "NEXT ROUND" buttons (and, in Mexicano, "GENERATE NEXT ROUND" on the latest round).
    - A right-aligned section with buttons for saving the current tournament and starting a new tournament.
- **Score Input:**  
  - Each match has score input fields for each team. When a score is entered for one team, the corresponding team’s score is automatically calculated based on the selected global total.
- **Mexicano Round Lifecycle:**  
  - Rounds are generated one at a time. Round 1 is a random draw, made once when the tournament starts.
  - Every later round is paired from the standings after the latest round (see §6): the fielded players are grouped in fours by rank (1st-4th, 5th-8th, ...), and within each group 1st and 4th play against 2nd and 3rd. Court 1 holds the top group.
  - At a count that is not a multiple of 4, the resting players are chosen before the groups are formed. In round 1 nobody has rested yet, so the players drawn last in the random draw rest. From round 2 on, the players with the fewest rests so far sit the round out; among equally rested players the lowest-ranked rests first.
  - "GENERATE NEXT ROUND" is offered on the latest round and works only once every match in it has a complete, valid score (the two scores sum to the points total). Until then the app names the courts still waiting for a score and marks them.
  - Generating the next round locks the scores of every earlier round: they remain viewable through round navigation but can no longer be edited. A Mexicano tournament stops at 128 rounds: once the 128th round is reached, no further round can be generated.
  - Americano is unaffected: every round's scores stay editable.
- **Tournament Control Functions:**  
  - The user can save, load, and delete tournaments via provided controls.
  - The "New Tournament" function offers an option to save the current tournament before clearing the state for a new setup.

### 6. Standings and Tiebreak
- The standings after each round rank players by total points, highest first.
- When exactly two players are level on points, the one who scored more points across the games where they were on opposing teams ranks higher.
- Two level players who never opposed each other, or whose mutual games are also level, share the same placement. A tie between three or more players is always shared.
- Shared placements follow standard competition ranking: players sharing a placement repeat it and the next placement is skipped (1, 1, 3).
- Mexicano pairs each new round by these same standings.

## Non-Functional Requirements

### 1. Client-Side Deployment
- The application is implemented entirely with HTML, CSS, and JavaScript.
- It should run directly in the browser and be deployable to GitHub Pages without requiring a server.

### 2. State Robustness
- The application auto-saves state (e.g., before unload) so that in the event of a reload or crash, the tournament can be resumed without data loss.
- All user-entered configurations (format, points total, tournament name, player names, court names, scores) must be persistently stored in the browser.
- If an auto-save fails, a warning stays visible at the top of the page until a later auto-save succeeds; that save stores the whole state, including the changes made in the meantime.

### 3. Responsiveness and Adaptability
- The layout adapts dynamically:
  - The number of courts is determined based on the number of players: floor(N/4) courts (e.g., 20 players require 5 courts so that every player can compete simultaneously; 22 players also use 5 courts, and 2 players rest each round).
  - The UI supports dynamic reordering and resizing of components.
- The design prioritizes readability:
  - Player names are displayed in large input fields (or within a table/grid) to maximize legibility.
  - The scoreboard’s points column is constrained to a fixed width (e.g., 5 characters wide).

### 4. Visual Design and User Experience
- **Navigation Elements:**  
  - Round navigation buttons appear above the courts, centered.
- **Scoreboard:**  
  - The scoreboard displays player rankings with colored rows, by each player's placement after the tiebreak (§6), not by row position:
    - Gold for placement 1, silver for placement 2, bronze (or a bronze-like color) for placement 3, and light grey for every other placement.
    - Players sharing a placement share its color, and the next placement is skipped: two players sharing first are both gold, and the next player is bronze (placement 3), with no silver row.
- **Customizability:**  
  - Users can customize the appearance of the courts and other elements (e.g., by providing custom court names).

## Additional Considerations
- The project should include automated tests (e.g., using Playwright) to verify functionality such as state persistence, score calculation, and UI responsiveness.
- Requirements are maintained under version control in the repository to keep documentation up-to-date with code changes.

---

