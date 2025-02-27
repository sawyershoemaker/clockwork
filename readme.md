# Clockwork Murder Mystery Bot
Clockwork was a spontaneous pet project that I worked on over the course of about a week. A lot of the code is probably messy and redundant but overall I thoroughly enjoyed learning about how mineflayer worked in-depth. This bot is not intended to provide any unfair advantage and is merely a proof of concept, it will not be updated with any changes made to the Murder Mystery game mode unless I decide to do so.

This repository contains a [Mineflayer](https://github.com/PrismarineJS/mineflayer) bot called **Clockwork**. The bot automatically joins Hypixel’s Murder Mystery (or your local server) and performs different in-game tasks based on its role:

- **Murderer**  
  - Locates and attacks nearby real players using an anti-bot check.  
  - Hides its sword while approaching targets.  
  - Switches to advanced pruning/pathfinding if stuck during movement.

- **Detective**  
  - Searches for the murderer using data received in packets.
  - Maintains and clears a target list of players to eliminate as needed.
  - Uses a bow to shoot murderer, using HawkEye for perfect aiming.

- **Innocent**  
  - Automatically travels to a hiding spot (coordinates pulled from `mapCoordinates.json`).  
  - Executes `/locraw` to detect the current map, then navigates to the designated hiding spot.

- **Queueing**  
  - Rejoins Murder Mystery once the game ends (e.g., on “YOU DIED!” or after winners are declared).
  - Implements a method of detecting whether a chat is player-based or from the System/Server. (not found in most bots)  
  - Optionally, invites a designated player to a party and performs `/play murder_classic` for testing.

## Features

- **Event-based Command Queue**  
  Prevents spamming commands too quickly by lining them up to run sequentially.
- **Anti-AFK**  
  Detects “You will be afk-ed in 10 seconds!” and moves/attacks randomly to stay active.
- **State Machine & Pathfinding**  
  Uses [mineflayer-statemachine](https://github.com/PrismarineJS/mineflayer-statemachine) for multi-state behavior and [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) to navigate.
- **Map Coordinates**  
  Loads custom hiding spots for various Murder Mystery maps from `mapCoordinates.json`.
- **Optional mineflayer-movement**  
  Adds heuristic-based movement refinements.
- **Optional HawkEye**  
  Provides more precise aiming for archery.

## Requirements

1. **Node.js** (v14 or newer)
2. A **Minecraft: Java Edition** account with Microsoft authentication
3. **Server compatibility** (e.g., Hypixel or a local server running 1.8.9)

> Note: Using bots on public servers can violate their terms. Use responsibly and at your own risk. (I am not responsible for bans.)

## Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/sawyershoemaker/clockwork
   cd clockwork

2. **Install dependencies**:
    ```bash
    npm install

3. **Configure mapCoordinates** (if desired):
   - Open or create `mapCoordinates.json`  
   - Populate it with key/value pairs for each map, for example:

     ```json
     {
       "Library": { "x": 10, "y": 70, "z": -5 },
       "Archives": { "x": 60, "y": 5, "z": 130 }
     }
     ```

4. **Run the bot**:
   ```bash
   node index.js

- Adjust the host and account in the createBot() options if needed (for instance, switch localhost to mc.hypixel.net, or change the account).

## Usage

- **Initial Commands**  
  On first spawn, the bot sends `/play murder_classic` and `/locraw`.

- **Death/Win Detection**  
  On “YOU DIED!” or “Winner:” messages, it waits a few seconds, then requeues with `/play murder_classic`.

- **AFK Prevention**  
  If the bot detects “You will be afk-ed in 10 seconds!” it moves, jumps, and attacks to avoid inactivity.

## Troubleshooting

1. **Repeated state logs**  
   Ensure the state machine is only created **once** per bot instance. A guard variable (`bot._stateMachineInitialized`) is included to prevent duplicates.

2. **Authentication errors**  
   Confirm that your Microsoft login credentials are correct and that Mineflayer is configured for Microsoft authentication.

3. **Connection issues**  
   Verify that the `host` is correct, and you're not blocked by a firewall or banned.
