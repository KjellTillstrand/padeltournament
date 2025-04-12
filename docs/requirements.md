# Padel Turrar Tournament Manager Requirements

This document outlines the functional and non-functional requirements for the Padel Turrar Tournament Manager application.

## Functional Requirements

### 1. Schedule Selection and Loading
- **Schedule Choice:**  
  - The user can choose from several preconfigured schedules (for 12, 16, 20, or 24 players).
  - Each schedule is stored as a separate JavaScript module (e.g. `12p11r.js`, `16p15r.js`, etc.) and is loaded dynamically.
  
### 2. Global Controls
- **Global Total Points:**  
  - The user can select the total points per game (options: 24 or 32).
- **Tournament Name:**  
  - The user must provide a tournament name before starting the tournament.
  - The application will validate that the name is not empty.
  - If the name already exists in saved tournaments, the system will append a hyphen and a number (or increment the number) to ensure uniqueness.
- **State Persistence:**  
  - The state (selected schedule, current round, scores, tournament name, and custom settings such as court names) is automatically saved to and restored from localStorage so that progress is retained across page reloads or crashes.

### 3. Player Management
- **Player Name Inputs:**  
  - A table or grid of input fields (one per player) is generated dynamically based on the loaded schedule.
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
    - A center section featuring previous and next buttons (displayed as large, bold arrow icons).
    - A right-aligned section with buttons for saving the current tournament and starting a new tournament.
- **Score Input:**  
  - Each match has score input fields for each team. When a score is entered for one team, the corresponding team’s score is automatically calculated based on the selected global total.
- **Tournament Control Functions:**  
  - The user can save, load, and delete tournaments via provided controls.
  - The "New Tournament" function offers an option to save the current tournament before clearing the state for a new setup.

## Non-Functional Requirements

### 1. Client-Side Deployment
- The application is implemented entirely with HTML, CSS, and JavaScript.
- It should run directly in the browser and be deployable to GitHub Pages without requiring a server.

### 2. State Robustness
- The application auto-saves state (e.g., before unload) so that in the event of a reload or crash, the tournament can be resumed without data loss.
- All user-entered configurations (tournament name, player names, court names, scores) must be persistently stored in the browser.

### 3. Responsiveness and Adaptability
- The layout adapts dynamically:
  - The number of courts is determined based on the number of players (e.g., 20 players require 5 courts so that every player can compete simultaneously).
  - The UI supports dynamic reordering and resizing of components.
- The design prioritizes readability:
  - Player names are displayed in large input fields (or within a table/grid) to maximize legibility.
  - The scoreboard’s points column is constrained to a fixed width (e.g., 5 characters wide).

### 4. Visual Design and User Experience
- **Navigation Elements:**  
  - Round navigation buttons appear above the courts, centered, using large and bold arrow icons.
- **Scoreboard:**  
  - The scoreboard displays player rankings with colored rows:
    - Gold for first place, silver for second, bronze (or a bronze-like color) for third, and light grey for the rest.
- **Customizability:**  
  - Users can customize the appearance of the courts and other elements (e.g., by providing custom court names).

## Additional Considerations
- The project should include automated tests (e.g., using Playwright) to verify functionality such as state persistence, score calculation, and UI responsiveness.
- Requirements are maintained under version control in the repository to keep documentation up-to-date with code changes.

---

