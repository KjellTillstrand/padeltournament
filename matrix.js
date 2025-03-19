// matrix.js
const schedule = {
    "playerCount": 12,
    "totalRounds": 11,
    "players": [
      "P1",
      "P2",
      "P3",
      "P4",
      "P5",
      "P6",
      "P7",
      "P8",
      "P9",
      "P10",
      "P11",
      "P12"
    ],
    "rounds": [
      {
        "roundNumber": 1,
        "matches": [
          {
            "court": 1,
            "teams": [
              [
                "P1",
                "P2"
              ],
              [
                "P3",
                "P4"
              ]
            ]
          },
          {
            "court": 2,
            "teams": [
              [
                "P5",
                "P6"
              ],
              [
                "P7",
                "P8"
              ]
            ]
          },
          {
            "court": 3,
            "teams": [
              [
                "P9",
                "P10"
              ],
              [
                "P11",
                "P12"
              ]
            ]
          }
        ]
      },
      {
        "roundNumber": 2,
        "matches": [
          {
            "court": 1,
            "teams": [
              [
                "P1",
                "P3"
              ],
              [
                "P5",
                "P7"
              ]
            ]
          },
          {
            "court": 2,
            "teams": [
              [
                "P2",
                "P4"
              ],
              [
                "P9",
                "P11"
              ]
            ]
          },
          {
            "court": 3,
            "teams": [
              [
                "P6",
                "P8"
              ],
              [
                "P10",
                "P12"
              ]
            ]
          }
        ]
      },
      {
        "roundNumber": 3,
        "matches": [
          {
            "court": 1,
            "teams": [
              [
                "P1",
                "P4"
              ],
              [
                "P5",
                "P8"
              ]
            ]
          },
          {
            "court": 2,
            "teams": [
              [
                "P2",
                "P3"
              ],
              [
                "P9",
                "P12"
              ]
            ]
          },
          {
            "court": 3,
            "teams": [
              [
                "P6",
                "P7"
              ],
              [
                "P10",
                "P11"
              ]
            ]
          }
        ]
      },
      {
        "roundNumber": 4,
        "matches": [
          {
            "court": 1,
            "teams": [
              [
                "P1",
                "P5"
              ],
              [
                "P2",
                "P6"
              ]
            ]
          },
          {
            "court": 2,
            "teams": [
              [
                "P3",
                "P9"
              ],
              [
                "P4",
                "P10"
              ]
            ]
          },
          {
            "court": 3,
            "teams": [
              [
                "P7",
                "P11"
              ],
              [
                "P8",
                "P12"
              ]
            ]
          }
        ]
      },
      {
        "roundNumber": 5,
        "matches": [
          {
            "court": 1,
            "teams": [
              [
                "P1",
                "P6"
              ],
              [
                "P4",
                "P9"
              ]
            ]
          },
          {
            "court": 2,
            "teams": [
              [
                "P2",
                "P5"
              ],
              [
                "P7",
                "P12"
              ]
            ]
          },
          {
            "court": 3,
            "teams": [
              [
                "P3",
                "P10"
              ],
              [
                "P8",
                "P11"
              ]
            ]
          }
        ]
      },
      {
        "roundNumber": 6,
        "matches": [
          {
            "court": 1,
            "teams": [
              [
                "P1",
                "P7"
              ],
              [
                "P4",
                "P12"
              ]
            ]
          },
          {
            "court": 2,
            "teams": [
              [
                "P2",
                "P8"
              ],
              [
                "P6",
                "P10"
              ]
            ]
          },
          {
            "court": 3,
            "teams": [
              [
                "P3",
                "P11"
              ],
              [
                "P5",
                "P9"
              ]
            ]
          }
        ]
      },
      {
        "roundNumber": 7,
        "matches": [
          {
            "court": 1,
            "teams": [
              [
                "P1",
                "P8"
              ],
              [
                "P2",
                "P7"
              ]
            ]
          },
          {
            "court": 2,
            "teams": [
              [
                "P3",
                "P12"
              ],
              [
                "P4",
                "P11"
              ]
            ]
          },
          {
            "court": 3,
            "teams": [
              [
                "P5",
                "P10"
              ],
              [
                "P6",
                "P9"
              ]
            ]
          }
        ]
      },
      {
        "roundNumber": 8,
        "matches": [
          {
            "court": 1,
            "teams": [
              [
                "P1",
                "P9"
              ],
              [
                "P6",
                "P12"
              ]
            ]
          },
          {
            "court": 2,
            "teams": [
              [
                "P2",
                "P10"
              ],
              [
                "P3",
                "P7"
              ]
            ]
          },
          {
            "court": 3,
            "teams": [
              [
                "P4",
                "P8"
              ],
              [
                "P5",
                "P11"
              ]
            ]
          }
        ]
      },
      {
        "roundNumber": 9,
        "matches": [
          {
            "court": 1,
            "teams": [
              [
                "P1",
                "P10"
              ],
              [
                "P5",
                "P12"
              ]
            ]
          },
          {
            "court": 2,
            "teams": [
              [
                "P2",
                "P9"
              ],
              [
                "P3",
                "P8"
              ]
            ]
          },
          {
            "court": 3,
            "teams": [
              [
                "P4",
                "P7"
              ],
              [
                "P6",
                "P11"
              ]
            ]
          }
        ]
      },
      {
        "roundNumber": 10,
        "matches": [
          {
            "court": 1,
            "teams": [
              [
                "P1",
                "P11"
              ],
              [
                "P8",
                "P10"
              ]
            ]
          },
          {
            "court": 2,
            "teams": [
              [
                "P2",
                "P12"
              ],
              [
                "P4",
                "P6"
              ]
            ]
          },
          {
            "court": 3,
            "teams": [
              [
                "P3",
                "P5"
              ],
              [
                "P7",
                "P9"
              ]
            ]
          }
        ]
      },
      {
        "roundNumber": 11,
        "matches": [
          {
            "court": 1,
            "teams": [
              [
                "P1",
                "P12"
              ],
              [
                "P8",
                "P9"
              ]
            ]
          },
          {
            "court": 2,
            "teams": [
              [
                "P2",
                "P11"
              ],
              [
                "P3",
                "P6"
              ]
            ]
          },
          {
            "court": 3,
            "teams": [
              [
                "P4",
                "P5"
              ],
              [
                "P7",
                "P10"
              ]
            ]
          }
        ]
      }
    ]
  };

  function createHeadToHeadMatrix(schedule) {
    const matrix = {};
    schedule.players.forEach(p => {
      matrix[p] = {};
      schedule.players.forEach(o => {
        matrix[p][o] = 0;
      });
    });
    schedule.rounds.forEach(r => {
      r.matches.forEach(m => {
        const [teamA, teamB] = m.teams;
        teamA.forEach(a => {
          teamB.forEach(b => {
            matrix[a][b] += 1;
            matrix[b][a] += 1;
          });
        });
      });
    });
    return matrix;
  }
  
  function verifyAllPairsTwice(matrix) {
    const players = Object.keys(matrix);
    for (let i = 0; i < players.length; i++) {
      for (let j = i+1; j < players.length; j++) {
        const p1 = players[i], p2 = players[j];
        const count = matrix[p1][p2];
        if (count !== 2) {
          console.log("Mismatch:", p1, p2, "=", count);
          return false;
        }
      }
    }
    return true;
  }
  
  const h2h = createHeadToHeadMatrix(schedule);
  console.log( verifyAllPairsTwice(h2h) ? "OK - every pair is 2" : "Mismatch found" );
  
  function createHeadToHeadMatrix(schedule) {
    const matrix = {};
    schedule.players.forEach(player => {
      matrix[player] = {};
      schedule.players.forEach(opponent => {
        matrix[player][opponent] = 0;
      });
    });
    schedule.rounds.forEach(round => {
      round.matches.forEach(match => {
        const team0 = match.teams[0];
        const team1 = match.teams[1];
        team0.forEach(playerA => {
          team1.forEach(playerB => {
            matrix[playerA][playerB] += 1;
            matrix[playerB][playerA] += 1;
          });
        });
      });
    });
    return matrix;
  }
  
  function matrixToCSV(matrix) {
    const players = Object.keys(matrix);
    let csv = "Player," + players.join(",") + "\n";
    players.forEach(player => {
      const row = [player];
      players.forEach(opponent => {
        row.push(matrix[player][opponent]);
      });
      csv += row.join(",") + "\n";
    });
    return csv;
  }
  
  const headToHeadMatrix = createHeadToHeadMatrix(schedule);
  const csvOutput = matrixToCSV(headToHeadMatrix);
  console.log(csvOutput);
  