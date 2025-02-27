// discord rpc
require('./rpc');
const { updateRole } = require('./rpc');
// antibot for murderer (detective doesn't need since its evaluates targets in its own way)
const AntiBot = require('./antiBot');
// view the bot for debugging and idk if ur bored n shit
const mineflayerViewer = require('prismarine-viewer').mineflayer;
// import required libraries
const mineflayer = require('mineflayer')
const pathfinder = require('mineflayer-pathfinder').pathfinder
const Movements = require('mineflayer-pathfinder').Movements
const { GoalNear, GoalBlock } = require('mineflayer-pathfinder').goals
const movement = require('mineflayer-movement')
const minecraftHawkEyePlugin = require('minecrafthawkeye').default || require('minecrafthawkeye')
const {
  StateTransition,
  BotStateMachine,
  NestedStateMachine
} = require('mineflayer-statemachine')

const fs = require('fs');
const path = require('path');

// load map coordinates from JSON file
const mapCoordinatesPath = path.resolve(__dirname, 'mapCoordinates.json');
let mapCoordinates = {};

// load the JSON file into memory
function loadMapCoordinates() {
  try {
    const data = fs.readFileSync(mapCoordinatesPath, 'utf-8');
    mapCoordinates = JSON.parse(data);
    console.log('[MapCoordinates] Loaded map coordinates:', mapCoordinates);
  } catch (err) {
    console.error('[MapCoordinates] Failed to load mapCoordinates.json:', err.message);
    mapCoordinates = {};
  }
}

// call the function to load the data when the script starts
loadMapCoordinates()

function createBot() {
  const bot = mineflayer.createBot({
    // host: 'mc.hypixel.net', // server name
    host: 'localhost',
    username: 'clockwork', // doesn't matter
    auth: 'microsoft', // mfa
    version: '1.8.9', // force version or else it will auto recognize
  });

  bot.setMaxListeners(20);

  bot.loadPlugin(pathfinder);
  bot.loadPlugin(movement.plugin);
  bot.loadPlugin(minecraftHawkEyePlugin);

  // tracking state
  bot.currentRole = 'Innocent'; // default
  bot.awaitingLocrawResponse = false; // track status of locraw
  bot.isInGame = false; // tracks if bot in match
  bot.hasInvitedToParty = false; // tracks if party invite sent (play with bot)
  bot.commandQueue = []; // command queue to manage execution
  bot.isProcessingQueue = false; // tracks if queue being processed

  // add a guard variable to ensure state machine is only created once
  bot._stateMachineInitialized = false;

  bot.addCommandToQueue = function (command, delay = 3000) {
    bot.commandQueue.push({ command, delay });
    bot.processCommandQueue();
  };

  bot.processCommandQueue = function () {
    if (bot.isProcessingQueue || bot.commandQueue.length === 0) return;
    bot.isProcessingQueue = true;

    const { command, delay } = bot.commandQueue.shift(); // get next command
    bot.chat(command); // exec
    console.log(`[CommandQueue] Executed: ${command}`);
    setTimeout(() => {
      bot.isProcessingQueue = false; // allow next to process
      bot.processCommandQueue(); // process the next cmd
    }, delay); // wait for the specified delay before processing the next cmd
  };

  // handles bot spawn
  function handleSpawn() {
    console.log('[Bot] Spawned! Running post-spawn tasks...');
    bot.currentRole = 'Innocent';
    bot.awaitingLocrawResponse = true;

  // init pathfinder movements
  const mcData = require('minecraft-data')(bot.version);
  const defaultMove = new Movements(bot, mcData);

  // mark all blocks as unbreakable
  for (const blockId in mcData.blocks) {
    defaultMove.blocksCantBreak.add(parseInt(blockId));
  }  

  // set the updated movements to the pathfinder
  bot.pathfinder.setMovements(defaultMove);
  bot.defaultMove = defaultMove;

    // init mineflayer-movement if available
    if (bot.movement) {
      const { Default } = bot.movement.goals;
      bot.movement.setGoal(Default);

      // add 'proximity' heuristic if supported
      if (bot.movement.heuristic && typeof bot.movement.heuristic.add === 'function') {
        bot.movement.heuristic.add('proximity', {
          label: 'proximity',
          weight: 1, // adjust weight
          calculate: (position) => {
            const target = getNearestPlayer();
            if (!target) return Infinity; // no valid targets
            return target.position.distanceTo(position); // distance-based heuristic
          },
        });
        console.log('[Bot] Added "proximity" heuristic.');
      } else {
        console.warn('[Bot] Heuristic system is not available or supported.');
      }
    } else {
      console.warn('[Bot] mineflayer-movement plugin is not initialized.');
    }

    console.log('[Pathfinder] Configured movements and heuristics.');

    // CREATE AND INIT STATE MACHINE ONLY ONCE
    if (!bot._stateMachineInitialized) {
      const antiBot = new AntiBot(bot); // create antiBot instance
      createMainStateMachine(defaultMove, antiBot);
      bot._stateMachineInitialized = true;
    }

   // always run /locraw each time we spawn
  bot.addCommandToQueue('/locraw', 3000);

  if (!bot._didFirstJoin) {
    bot._didFirstJoin = true;
//    bot.addCommandToQueue('/party invite ALT_ACCOUNT_USERNAME', 3000);
    bot.addCommandToQueue('/play murder_classic', 5000);
    bot.isInGame = true;
  }

  }

  // anti-afk on warning
  function handleAFKWarning(jsonMessage) {
    const messageText = jsonMessage.toString().trim();

    if (messageText.includes('You will be afk-ed in 10 seconds!')) {
      console.log('[Bot] AFK warning detected. Performing anti-AFK actions...');
      const originalPosition = bot.entity.position.clone();

      bot.setControlState('jump', true);
      bot.setControlState('forward', true);
      bot.setControlState('left', true);
      setTimeout(() => bot.swingArm(), 500);
      setTimeout(() => bot.swingArm(), 1500);
      setTimeout(() => {
        const nearestEntity = bot.nearestEntity();
        if (nearestEntity) bot.attack(nearestEntity);
      }, 2000);
      const randomYaw = Math.random() * Math.PI * 2; // random yaw (360 degrees)
      const randomPitch = (Math.random() - 0.5) * Math.PI / 4; // random pitch (-22.5 to 22.5 degrees)
      bot.look(randomYaw, randomPitch, true);

      // stop movement and return to the original position
      setTimeout(() => {
        bot.setControlState('jump', false);
        bot.setControlState('forward', false);
        bot.setControlState('left', false);
        bot.pathfinder.setGoal(new GoalNear(originalPosition.x, originalPosition.y, originalPosition.z, 1));
      }, 3000);

      console.log('[Bot] Anti-AFK actions completed.');
    }
  }

  // handle `/locraw` response
  function handleLocrawResponse(jsonMessage) {
    if (!bot.awaitingLocrawResponse) return;

    const messageText = jsonMessage.toString().trim();
    if (messageText.startsWith('{') && messageText.endsWith('}')) {
      try {
        const data = JSON.parse(messageText);
        if (data.map) {
          console.log(`[Bot] Map detected: ${data.map}`);
          bot.currentMap = data.map;
          bot.awaitingLocrawResponse = false; // stop awaiting locraw response

          // start pathfinding to the map's hiding spot
          const hidingSpot = mapCoordinates[data.map];
          if (hidingSpot) {
            console.log(`[TravelHiding] Found hiding spot: ${JSON.stringify(hidingSpot)}`);
            bot.pathfinder.setMovements(bot.defaultMove);
            const goal = new GoalNear(hidingSpot.x, hidingSpot.y, hidingSpot.z, 0.25); // allow quarter block radius
            bot.pathfinder.setGoal(goal, true);
            bot.once('goal_reached', () => {
              console.log('[TravelHiding] Reached hiding spot!');
            });
          } else {
            console.log(`[TravelHiding] No hiding spot found for map: ${data.map}`);
          }
        }
      } catch (err) {
        console.error('[Bot] Failed to parse /locraw response:', err.message);
      }
    }
  }

  // handle game messages (e.g., requeue after death or win)
  function handleGameMessages(jsonMessage) {
    const messageText = jsonMessage.toString().trim();

    // check if the message is NOT from a player
    const isSystemMessage = !jsonMessage.translate || jsonMessage.translate !== 'chat.type.text';

    if (isSystemMessage) {
      if (messageText.includes('YOU DIED!') || messageText.includes('Winner: ')) {
        console.log('[Bot] Game ended. Queueing next match...');
        bot.isInGame = false; // Reset game status
        bot.addCommandToQueue('/play murder_classic', 5000);
      }
    }
  }

  // reconnect on disconnect
  function handleDisconnect() {
    console.log('[Bot] Disconnected. Reconnecting in 5 seconds...');
    setTimeout(createBot, 5000);
  }

  // attach listeners (remove duplicates first if any)
  bot.removeAllListeners('spawn');
  bot.on('spawn', handleSpawn);

  bot.removeAllListeners('message');
  bot.on('message', handleAFKWarning);
  bot.on('message', handleLocrawResponse);
  bot.on('message', handleGameMessages);

  bot.removeAllListeners('end');
  bot.on('end', handleDisconnect);

  return bot;
}

// utility functions
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function findInventoryItem(nameIncludes) {
  return bot.inventory.items().find(item =>
    item.name.toLowerCase().includes(nameIncludes.toLowerCase())
  );
}

function hasSword() {
  return !!findInventoryItem('sword');
}

function hasBow() {
  return !!findInventoryItem('bow');
}

// finds nearest player and uses my antibot to ensure they are real
function getNearestPlayer() {
  let closest = null;
  let closestDistance = Infinity;

  for (const id in bot.entities) {
    const entity = bot.entities[id];

    if (
      entity.type === 'player' && // must be a player
      entity.username !== bot.username && // exclude the bot itself
      entity.position // ensure the entity has a position
      // we do NOT check antiBot here because the usage in SwordAttack does that
    ) {
      const dist = bot.entity.position.distanceTo(entity.position);
      if (dist < closestDistance) {
        closestDistance = dist;
        closest = entity;
      }
    }
  }

  return closest;
}

// CheckInventory – decides which behavior to use
class BehaviorCheckInventory {
  constructor(bot) { this.bot = bot }
  async run() {
    if (hasSword()) return 'SwordAttack'
    else if (hasBow()) return 'BowAttack'
    else return 'TravelHiding'
  }
}

// hideSword - hides sword when not near victim
function hideSword() {
  const heldItem = bot.heldItem;
  if (heldItem && heldItem.name.toLowerCase().includes('sword')) {
    // ensure slot 2 (index 1) is empty
    const hotbarSlot = 1; // hotbar slot 2 corresponds to index 1
    const destinationSlot = bot.inventory.slots[hotbarSlot];

    if (!destinationSlot) {
      // slot 2 is empty; proceed to unequip
      bot.unequip('hand', hotbarSlot)
    } else {
      console.error('[hideSword] Cannot unequip: Hotbar slot 2 is not empty.');
    }
  }
}

class BehaviorSwordAttack {
  constructor(bot, antiBot) {
    this.bot = bot;
    this.antiBot = antiBot;
    this.tickListener = null;

    this.lastAttackTime = 0;
    this.attackCooldown = 1000 + Math.random() * 1000; // 1–2s

    // for stuck detection
    this.lastPosition = null;
    this.stuckTimer = null;
    this.stuckThreshold = 5000;
    this.lastStuckCheck = Date.now();

    // pathfinding mode
    this.isPathfinding = false;
    this.pathfindingTimeout = null;
    this.pathfindingTimeoutDuration = 12000;
  }

  async onStateEntered() {
    console.log('[State] Enter SwordAttack');
    this.bot.currentRole = 'Murderer';
    updateRole('Murderer');

    this.lastAttackTime = Date.now() - this.attackCooldown;
    this.lastPosition = this.bot.entity.position.clone();

    // main update loop
    this.tickListener = () => {
      const target = getNearestPlayer(this.antiBot); 
      if (!target) return;

      // skip if AntiBot says it's not real
      if (this.antiBot.isBot(target)) return;

      const dist = this.bot.entity.position.distanceTo(target.position);

      // if currently pathfinding, skip WASD logic
      if (this.isPathfinding) return;

      // check if stuck (every ~1200 ms)
      if (Date.now() - this.lastStuckCheck >= 1200) {
        if (this.isStuck()) {
          console.log('[SwordAttack] Bot is stuck. Switching to pathfinder.');
          this.switchToPathfinder(target);
          return;
        }
        this.lastStuckCheck = Date.now();
      }

      // ladder logic (had issues with disconnecting on ladder previously (incorrect physics?))
      if (this.isOnLadder()) {
        this.handleLadderMovement(target);
        return;
      }

      // move/attack logic
      if (dist > 1.75) {
        // move closer
        this.bot.setControlState('forward', true);
        this.bot.setControlState('sprint', true);
        this.bot.setControlState('jump', true);
        hideSword();
      } else {
        // within melee range, stop movement
        this.bot.setControlState('forward', false);
        this.bot.setControlState('sprint', false);
        this.bot.setControlState('jump', false);

        // attempt attack if cooldown elapsed
        if (Date.now() - this.lastAttackTime >= this.attackCooldown) {
          const sword = findInventoryItem('sword');
          if (sword) {
            this.bot.equip(sword, 'hand')
              .then(() => this.bot.attack(target))
              .then(() => {
                this.lastAttackTime = Date.now();
                this.attackCooldown = 1000 + Math.random() * 1000;
              })
              .catch(err => console.log('[SwordAttack] Equip/Attack error:', err));
          }
        }
      }

      // look AT target
      this.bot.lookAt(target.position.offset(0, target.height / 1.5, 0), true).catch(() => {});
    };

    this.bot.on('physicsTick', this.tickListener);
  }

  async onStateExited() {
    console.log('[State] Exit SwordAttack');
    updateRole('Innocent');
  
    if (this.tickListener) {
      this.bot.removeListener('physicsTick', this.tickListener);
      this.tickListener = null;
    }
    clearTimeout(this.stuckTimer);
    clearTimeout(this.pathfindingTimeout);
  
    // stop WASD
    this.bot.setControlState('forward', false);
    this.bot.setControlState('sprint', false);
    this.bot.setControlState('jump', false);
  
    // stop pathfinder (only if movements are set)
    if (this.bot.pathfinder.movements) {
      this.bot.pathfinder.setGoal(null);
    }
    this.isPathfinding = false;
  }

  isFinished() {
    return !hasSword(); 
  }

  // STUCK DETECTION
  isStuck() {
    const currentPosition = this.bot.entity.position.clone();
    const movedDistance = this.lastPosition.distanceTo(currentPosition);

    if (movedDistance < 0.1) {
      // not moving => might be stuck
      if (!this.stuckTimer) {
        this.stuckTimer = setTimeout(() => {
          console.log('[SwordAttack] Bot has been stuck for too long.');
        }, this.stuckThreshold);
      }
      return true;
    } else {
      // reset if moving
      clearTimeout(this.stuckTimer);
      this.stuckTimer = null;
      this.lastPosition = currentPosition;
      return false;
    }
  }

  // PATHFINDING SWITCH
  switchToPathfinder(target) {
    // clear stuck timer
    clearTimeout(this.stuckTimer);
    this.stuckTimer = null;

    // stop WASD
    this.bot.setControlState('forward', false);
    this.bot.setControlState('sprint', false);
    this.bot.setControlState('jump', false);

    // also stop the mineflayer-movement plugin if it's steering
    if (this.bot.movement) {
      this.bot.movement.setGoal(null);
    }

    // use pathfinder to move to the target’s block
    const mcData = require('minecraft-data')(this.bot.version);
    const movements = new Movements(this.bot, mcData);
    this.bot.pathfinder.setMovements(movements);

    const goal = new GoalBlock(
      Math.floor(target.position.x),
      Math.floor(target.position.y),
      Math.floor(target.position.z)
    );
    this.bot.pathfinder.setGoal(goal);
    this.isPathfinding = true;

    // timeout if pathfinder can't reach in time
    this.pathfindingTimeout = setTimeout(() => {
      console.log('[SwordAttack] Pathfinder timeout. Reverting to manual movement.');
      this.isPathfinding = false;
      this.lastPosition = this.bot.entity.position.clone();
    }, this.pathfindingTimeoutDuration);

    this.bot.once('goal_reached', () => {
      console.log('[SwordAttack] Pathfinder reached target block.');
      clearTimeout(this.pathfindingTimeout);
      this.isPathfinding = false;
      this.lastPosition = this.bot.entity.position.clone();
    });
  }

  // LADDER LOGIC (questionable if this is needed, during testing bot had trouble dealing with ladder packets and crashed,
  // might have been flagging on hypixel(???))
  isOnLadder() {
    const blockBelow = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0));
    return blockBelow && blockBelow.name.includes('ladder');
  }

  handleLadderMovement(target) {
    const ty = target.position.y;
    const by = this.bot.entity.position.y;
    // climb up/down the ladder
    if (ty > by + 1) {
      // up
      this.bot.setControlState('jump', false);
      this.bot.setControlState('sneak', false);
      this.bot.setControlState('forward', true);
    } else if (ty < by - 1) {
      // down
      this.bot.setControlState('jump', false);
      this.bot.setControlState('sneak', true);
      this.bot.setControlState('forward', false);
    } else {
      // same level
      this.bot.setControlState('jump', false);
      this.bot.setControlState('sneak', false);
      this.bot.setControlState('forward', false);
    }
  }
}

// BowAttack – chase target until within a safe range, then fire. if target too close: back up.
class BehaviorBowAttack {
  constructor(bot) {
    this.bot = bot;
    this.tickListener = null;

    this.lastAttackTime = 0;
    this.attackCooldown = 1200 + Math.random() * 800; // 1.2–2s
    this.isCharging = false;
    this.isBackingUp = false;
    this.backupTimer = null;

    this.targets = new Set();
  }

  onStateEntered() {
    console.log('[State] Enter BowAttack');
    this.bot.currentRole = 'Detective';
    updateRole('Detective');
    this.lastAttackTime = Date.now() - this.attackCooldown;
    this.targets.clear();

    this.tickListener = () => {
      // 1) refresh target list
      this.updateTargets();

      // 2) choose a target
      const target = this.getClosestTarget();
      if (!target) return;

      // 3) use HawkEye angles to physically aim the bot’s head
      const targetCenter = target.position.offset(0, (target.height || 1) / 2, 0);

      if (this.bot.hawkEye && typeof this.bot.hawkEye.getYawPitch === 'function') {
        try {
          // get recommended yaw/pitch from HawkEye
          const { yaw, pitch } = this.bot.hawkEye.getYawPitch(targetCenter);
          // physically rotate bot's camera
          this.bot.look(yaw, pitch, true);
        } catch (e) {
          console.log('[BowAttack] hawkEye.getYawPitch error:', e);
        }
      } else {
        // fallback: use built-in lookAt if hawkEye not available
        this.bot.lookAt(targetCenter, true).catch(() => {});
      }

      // 4) movement logic (chase/backup)
      const dist = this.bot.entity.position.distanceTo(target.position);
      if (!this.isCharging) {
        if (dist > 13.5) {
          // chase
          this.resetBackup();
          this.bot.setControlState('forward', true);
          this.bot.setControlState('sprint', true);
          this.bot.setControlState('jump', true);
        } else if (dist < 3.5) {
          // back up
          this.startBackup(dist);
        } else {
          // stop so we can shoot
          this.stopMoving();
        }
      }

      // 5) fire bow if in range, cooldown ready, and not currently charging
      const sinceLast = Date.now() - this.lastAttackTime;
      if (!this.isCharging && dist <= 13.5 && dist >= 3.5 && sinceLast >= this.attackCooldown) {
        this.fireBow(target);
      }
    };

    this.bot.on('physicsTick', this.tickListener);
  }

  onStateExited() {
    console.log('[State] Exit BowAttack');
    updateRole('Innocent');

    if (this.tickListener) {
      this.bot.removeListener('physicsTick', this.tickListener);
      this.tickListener = null;
    }
    if (this.backupTimer) {
      clearTimeout(this.backupTimer);
      this.backupTimer = null;
    }
    this.resetBackup();
    this.stopMoving();
    this.targets.clear();

    // hide bow
    this.hideBow();

    // stop HawkEye
    if (this.bot.hawkEye && typeof this.bot.hawkEye.stop === 'function') {
      this.bot.hawkEye.stop();
    }
  }

  isFinished() {
    return !hasBow();
  }

  // --- TARGET LIST LOGIC ---
  updateTargets() {
    for (const id in this.bot.entities) {
      const ent = this.bot.entities[id];
      if (
        ent.type === 'player' &&
        ent.username !== this.bot.username &&
        ent.heldItem &&
        ent.heldItem.name.toLowerCase() === 'iron_sword'
      ) {
        this.targets.add(ent.username);
      }
    }

    if (this.targets.size === 0) {
      this.hideBow();
    }
  }

  getClosestTarget() {
    let best = null;
    let bestDist = Infinity;
    for (const username of this.targets) {
      const entity = this.bot.players[username]?.entity;
      if (!entity) continue;
      const dist = this.bot.entity.position.distanceTo(entity.position);
      if (dist < bestDist) {
        bestDist = dist;
        best = entity;
      }
    }
    return best;
  }

  // --- BOW LOGIC ---
  async fireBow(target) {
    const bow = findInventoryItem('bow');
    if (!bow) return;

    this.isCharging = true;
    this.stopMoving();

    try {
      await this.bot.equip(bow, 'hand');
      // manual full draw
      this.bot.activateItem();
      await this.bot.waitForTicks(20); // ~1 second for full draw
      this.bot.deactivateItem(); // release arrow

      if (this.bot.hawkEye && typeof this.bot.hawkEye.onShotFired === 'function') {
        this.bot.hawkEye.onShotFired(target);
      }

      this.lastAttackTime = Date.now();
      this.attackCooldown = 1200 + Math.random() * 800; 
    } catch (err) {
      console.log('[BowAttack] fireBow error:', err);
    } finally {
      this.isCharging = false;
    }
  }

  hideBow() {
    const held = this.bot.heldItem;
    if (held && held.name.toLowerCase().includes('bow')) {
      this.bot.unequip('hand').catch(() => {});
    }
  }

  // --- MOVEMENT HELPERS ---
  startBackup(dist) {
    if (this.isBackingUp) return;
    this.isBackingUp = true;

    this.bot.setControlState('forward', false);
    this.bot.setControlState('sprint', false);
    this.bot.setControlState('jump', true);
    this.bot.setControlState('back', true);

    const duration = Math.max(700, (4 - dist) * 250 + 500);
    this.backupTimer = setTimeout(() => {
      this.isBackingUp = false;
      this.bot.setControlState('back', false);
      this.bot.setControlState('jump', false);
    }, duration);
  }

  resetBackup() {
    if (this.isBackingUp) {
      this.isBackingUp = false;
      this.bot.setControlState('back', false);
      this.bot.setControlState('jump', false);
    }
  }

  stopMoving() {
    this.bot.setControlState('forward', false);
    this.bot.setControlState('back', false);
    this.bot.setControlState('sprint', false);
    this.bot.setControlState('jump', false);

    if (this.bot.movement) {
      this.bot.movement.setGoal(null);
    }
  }
}

// TravelHiding – uses Pathfinder for navigation
class BehaviorTravelHiding {
  constructor(bot, defaultMove) {
    this.bot = bot;
    this.defaultMove = defaultMove;
    this.mapCoordinates = mapCoordinates; // dynamic JSON-loaded coordinates
    this.currentMapTitle = null; // tracks the current map title
    this.hasMovedToSpot = false; // prevent re-running the same logic
    this.currentRole = 'Innocent'; // default role
  }

  async onStateEntered() {
    console.log('[State] Enter travelHiding');

    // reset flag to allow pathfinding
    this.hasMovedToSpot = false;

    // check role before deciding to hide
    if (this.currentRole !== 'Innocent') {
      console.log(`[TravelHiding] Role is "${this.currentRole}". Not hiding.`);
      return;
    }

    wait(5000);
    this.bot.chat('/locraw');

    // create a one-time listener for the `/locraw` response
    const locrawListener = (jsonMessage) => {
      const messageText = jsonMessage.toString().trim();

      // only process messages that look like JSON
      if (messageText.startsWith('{') && messageText.endsWith('}')) {
        try {
          const data = JSON.parse(messageText); // parse JSON response

          if (data.map) {
            console.log(`[TravelHiding] Detected map: ${data.map}`);
            this.currentMapTitle = data.map;

            // find coordinates for this map
            const hidingSpot = this.mapCoordinates[data.map];
            if (hidingSpot) {
              console.log(`[TravelHiding] Found hiding spot: ${JSON.stringify(hidingSpot)}`);
              this.goToHidingSpot(hidingSpot);
            } else {
              console.log(`[TravelHiding] No hiding spot found for map: ${data.map}`);
            }
          }
        } catch (err) {
          console.error('[TravelHiding] Failed to parse /locraw response:', err.message);
        } finally {
          // remove the listener once the response is processed
          this.bot.removeListener('message', locrawListener);
        }
      }
    };

    // attach the listener
    this.bot.on('message', locrawListener);

    // timeout to clean up the listener if no response is received
    setTimeout(() => {
      this.bot.removeListener('message', locrawListener);
    }, 10000); // adjust timeout as needed
  }

 async onStateExited() {
  console.log('[State] Exit travelHiding');
  if (this.bot.pathfinder.movements) {
    this.bot.pathfinder.setGoal(null);
  }
}

  isFinished() {
    return this.hasMovedToSpot; // finish once moved to hiding spot
  }

  // pathfind to the hiding spot
  goToHidingSpot(coordinates) {
    const { x, y, z } = coordinates;

    // set up pathfinding movements
    this.bot.pathfinder.setMovements(this.defaultMove);

    // create a goal for the bot to reach the hiding spot
    const goal = new GoalNear(x, y, z, 0.25); // allowing quarter block radius

    console.log(`[TravelHiding] Pathfinding to hiding spot at (${x}, ${y}, ${z})...`);
    this.bot.pathfinder.setGoal(goal, true);

    // mark as moved once the bot reaches the spot
    this.bot.once('goal_reached', () => {
      console.log('[TravelHiding] Reached hiding spot!');
      this.hasMovedToSpot = true;
    });
  }
}

// build and start state machine
function createMainStateMachine(defaultMove, antiBot) {
  const checkInv = new BehaviorCheckInventory(bot);
  const swordAttack = new BehaviorSwordAttack(bot, antiBot);
  const bowAttack = new BehaviorBowAttack(bot);
  const travelHide = new BehaviorTravelHiding(bot, defaultMove);

  const t1 = new StateTransition({
    parent: checkInv,
    child: swordAttack,
    shouldTransition: () => hasSword(),
    priority: 1
  });
  const t2 = new StateTransition({
    parent: checkInv,
    child: bowAttack,
    shouldTransition: () => hasBow() && !hasSword(),
    priority: 2
  });
  const t3 = new StateTransition({
    parent: checkInv,
    child: travelHide,
    shouldTransition: () => travelHide.currentRole === 'Innocent',
    priority: 3
  });
  const t4 = new StateTransition({
    parent: swordAttack,
    child: checkInv,
    shouldTransition: () => !hasSword(),
    priority: 1
  });
  const t5 = new StateTransition({
    parent: bowAttack,
    child: checkInv,
    shouldTransition: () => !hasBow(),
    priority: 1
  });
  const t6 = new StateTransition({
    parent: travelHide,
    child: checkInv,
    shouldTransition: () => hasSword() || hasBow(),
    priority: 1
  });

  const transitions = [t1, t2, t3, t4, t5, t6];
  const rootLayer = new NestedStateMachine(transitions, checkInv);
  return new BotStateMachine(bot, rootLayer);
}

// run the program
const bot = createBot();