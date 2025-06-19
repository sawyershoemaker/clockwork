# Clockwork Murder Mystery Bot

Clockwork is a [Mineflayer](https://github.com/PrismarineJS/mineflayer) bot that automatically joins Hypixel's Murder Mystery (or your local server) and performs in-game tasks based on its role:

- **Murderer**: Locates and attacks nearby real players using anti-bot checks, hides its sword while approaching, and uses pathfinding if stuck.
- **Detective**: Searches for the murderer, maintains a target list, and uses a bow with precise aiming.
- **Innocent**: Travels to a hiding spot using map coordinates, executes `/locraw` to detect the map, and navigates to the designated spot.
- **Queueing**: Rejoins Murder Mystery after each game ends, detects system chat, and can invite a designated player to a party for testing.

## Features

- **Event-based Command Queue**: Prevents command spam by queuing commands.
- **Anti-AFK**: Detects inactivity warnings and moves/attacks to stay active.
- **State Machine & Pathfinding**: Uses [mineflayer-statemachine](https://github.com/PrismarineJS/mineflayer-statemachine) and [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) for multi-state behavior and navigation.
- **Map Coordinates**: Loads hiding spots for maps from `settings/mapCoordinates.json`.
- **Bot Configuration**: Uses `settings/botConfig.json` for server, username, version, and authentication settings.
- **Win/Loss Chat**: Says a random message from `settings/winChats.txt` or `settings/lossChats.txt` after each game, before requeueing.
- **mineflayer-movement**: Adds heuristic-based movement refinements.
- **awkEye**: Provides precise aiming for archery.
- **Movement/Pathfinding**: The bot never builds or places blocks, avoids ladders, ignores fall damage, and can do basic parkour (jump 1-block gaps).

## Requirements

- **Node.js** (v14 or newer)
- **Minecraft: Java Edition** account with Microsoft authentication
- **Server compatibility** (e.g., Hypixel or a local server running 1.8.9)

> Using bots on public servers can violate their terms. Use responsibly and at your own risk.

## Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/sawyershoemaker/clockwork
   cd clockwork
   ```
2. **Install dependencies**:
   ```bash
   npm install
   ```
3. **Configure settings**:
   - Edit `settings/botConfig.json` to set your server, username, auth, and version:
     ```json
     {
       "host": "localhost",
       "username": "clockwork",
       "auth": "microsoft",
       "version": "1.8.9"
     }
     ```
   - Edit `settings/mapCoordinates.json` with key/value pairs for each map:
     ```json
     {
       "Library": { "x": 10, "y": 70, "z": -5 },
       "Archives": { "x": 60, "y": 5, "z": 130 }
     }
     ```
   - Add post-game chat messages to `settings/winChats.txt` and `settings/lossChats.txt` (one message per line). The bot will say a random line from the appropriate file after each win or loss.
4. **Run the bot**:
   ```bash
   node index.js
   ```
- Adjust the host and account in `settings/botConfig.json` as needed (e.g., to use mc.hypixel.net).

## Usage

- On first spawn, the bot sends `/play murder_classic` and `/locraw`.
- On "YOU DIED!" or "Winner:" messages, the bot says a random message from the appropriate chat file, then requeues with `/play murder_classic`.
- If the bot detects "You will be afk-ed in 10 seconds!" it moves, jumps, and attacks to avoid inactivity.
- The bot never builds or places blocks, avoids ladders, ignores fall damage, and can do basic parkour (jump 1-block gaps).

## License

This project is licensed under the [MIT License](https://opensource.org/licenses/MIT). See the [LICENSE](LICENSE) file for more details.