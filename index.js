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
const { Worker } = require('worker_threads');
const Vec3 = require('vec3');

// load bot config from settings/botConfig.json
const botConfig = require('./settings/botConfig.json');
const fileWorker = new Worker('./workers/fileWorker.js');
const mapCoordinatesPath = path.resolve(__dirname, 'settings', 'mapCoordinates.json');
let mapCoordinates = {};

function loadMapCoordinatesAsync() {
  return new Promise((resolve, reject) => {
    fileWorker.once('message', (msg) => {
      if (msg.error) {
        console.error('[MapCoordinates] Failed to load mapCoordinates.json:', msg.error);
        mapCoordinates = {};
        reject(msg.error);
      } else {
        mapCoordinates = msg.data;
        console.log('[MapCoordinates] Loaded map coordinates:', mapCoordinates);
        resolve(mapCoordinates);
      }
    });
    fileWorker.postMessage(mapCoordinatesPath);
  });
}

// call the function to load the data when the script starts
loadMapCoordinatesAsync();

// offload distance calc
function getNearestPlayerAsync(bot) {
  return new Promise((resolve) => {
    const distanceWorker = new Worker('./workers/distanceWorker.js');
    const entities = Object.values(bot.entities).filter(e => e.type === 'player' && e.username !== bot.username);
    const position = bot.entity.position;
    distanceWorker.once('message', ({ closest }) => {
      resolve(closest);
      distanceWorker.terminate();
    });
    distanceWorker.postMessage({ entities, position });
  });
}

// offload antibot check
function isBotAsync(entity) {
  return new Promise((resolve) => {
    const antibotWorker = new Worker('./workers/antibotWorker.js');
    antibotWorker.once('message', (isBot) => {
      resolve(isBot);
      antibotWorker.terminate();
    });
    antibotWorker.postMessage(entity);
  });
}

// offload aim calc
function getYawPitchAsync(botPos, targetPos) {
  return new Promise((resolve) => {
    const hawkeyeWorker = new Worker('./workers/hawkeyeWorker.js');
    hawkeyeWorker.once('message', (result) => {
      resolve(result);
      hawkeyeWorker.terminate();
    });
    hawkeyeWorker.postMessage({ botPos, targetPos });
  });
}

function createBot() {
  // use config
  const bot = mineflayer.createBot(botConfig);

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
  defaultMove.entityWidth = 0.95; // make bot avoid tight spaces and walls
  // only avoid ladders and trapdoors
  const avoidBlockNames = [
    'ladder',
    'oak_trapdoor', 'birch_trapdoor', 'spruce_trapdoor', 'jungle_trapdoor', 'dark_oak_trapdoor', 'acacia_trapdoor', 'iron_trapdoor',
    'trapdoor' // generic, for older MC versions
  ];
  for (const name of avoidBlockNames) {
    if (mcData.blocksByName[name]) {
      defaultMove.blocksToAvoid.add(mcData.blocksByName[name].id);
    }
  }

  // prevent breaking blocks in pathfinder
  defaultMove.canDig = false;
  // prevent breaking blocks in mineflayer-movement
  if (bot.movement) {
    bot.movement.canDig = false;
  }

  // forbid ladders: add ladder block ID to blocksToAvoid
  const ladderId = mcData.blocksByName.ladder.id;
  defaultMove.blocksToAvoid.add(ladderId);
  // ignore fall damage
  defaultMove.maxDropDown = 100;
  // allow basic parkour (1-block gap jumps)
  defaultMove.allowParkour = false;
  // forbid any building or block placing
  defaultMove.allow1by1towers = false;
  defaultMove.canPlaceBlocks = false;
// forbid ladders
  if (bot.movement && bot.movement.avoidBlocks) {
    bot.movement.avoidBlocks.add(ladderId);
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
          calculate: async (position) => {
            const target = await getNearestPlayerAsync(bot);
            if (!target) return Infinity; // no valid targets
            const dx = target.position.x - position.x;
            const dy = target.position.y - position.y;
            const dz = target.position.z - position.z;
            return Math.sqrt(dx*dx + dy*dy + dz*dz); // distance-based heuristic
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
      createMainStateMachine(bot, defaultMove, antiBot);
      bot._stateMachineInitialized = true;
    }

   // always run /locraw each time we spawn
  bot.addCommandToQueue('/locraw', 3000);

  if (!bot._didFirstJoin) {
    bot._didFirstJoin = true;
    // Party invite toggle and username from botConfig
    if (botConfig.invitePartyOnFirstJoin && botConfig.partyInviteUsername) {
      bot.addCommandToQueue(`/party invite ${botConfig.partyInviteUsername}`, 3000);
    }
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
        bot.pathfinder.setGoal(new GoalNear(originalPosition.x, originalPosition.y, originalPosition.z, 1.5));
      }, 3000);

      console.log('[Bot] Anti-AFK actions completed.');
    }
  }

  // send a random chat from file (each line is a possible message)
  function sendRandomChatFromFile(bot, filePath) {
    return new Promise((resolve) => {
      fs.readFile(filePath, 'utf-8', (err, data) => {
        if (err) {
          console.warn(`[Bot] Could not read chat file: ${filePath}`);
          return resolve();
        }
        const lines = data.split('\n').map(line => line.trim()).filter(line => line.length > 0);
        if (lines.length === 0) return resolve();
        const msg = lines[Math.floor(Math.random() * lines.length)];
        bot.chat(msg);
        resolve();
      });
    });
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
            const goal = new GoalNear(hidingSpot.x, hidingSpot.y, hidingSpot.z, 0.4); // allow 0.4 block radius for hiding
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

  // in handleGameMessages, send a random win/loss chat before requeueing
  function handleGameMessages(jsonMessage) {
    const messageText = jsonMessage.toString().trim();

    // check if the message is NOT from a player
    const isSystemMessage = !jsonMessage.translate || jsonMessage.translate !== 'chat.type.text';

    if (isSystemMessage) {
      if (messageText.includes('YOU DIED!')) {
        console.log('[Bot] Game ended (loss). Sending loss chat and queueing next match...');
        bot.isInGame = false; // reset game status
        sendRandomChatFromFile(bot, path.resolve(__dirname, 'settings', 'lossChats.txt')).then(() => {
          bot.addCommandToQueue('/play murder_classic', 5000);
        });
      } else if (messageText.includes('Winner: ')) {
        console.log('[Bot] Game ended (win). Sending win chat and queueing next match...');
        bot.isInGame = false; // reset game status
        sendRandomChatFromFile(bot, path.resolve(__dirname, 'settings', 'winChats.txt')).then(() => {
          bot.addCommandToQueue('/play murder_classic', 5000);
        });
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

  // pevent digging with a sword
  function overrideBotDig(bot) {
    const originalDig = bot.dig;
    bot.dig = function(block, ...args) {
      const held = bot.heldItem;
      if (held && held.name && held.name.toLowerCase().includes('sword')) {
        console.warn('[Bot] Attempted to dig with a sword! Digging prevented.');
        return Promise.resolve();
      }
      return originalDig.call(bot, block, ...args);
    };
  }

  overrideBotDig(bot);

  return bot;
}

// utility functions
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function findInventoryItem(bot, nameIncludes) {
  return bot.inventory.items().find(item =>
    item.name.toLowerCase().includes(nameIncludes.toLowerCase())
  );
}

function hasSword(bot) {
  return !!findInventoryItem(bot, 'sword');
}

function hasBow(bot) {
  return !!findInventoryItem(bot, 'bow');
}

// finds nearest player and uses my antibot to ensure they are real
function getNearestPlayer(bot) {
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
    if (hasSword(this.bot)) return 'SwordAttack'
    else if (hasBow(this.bot)) return 'BowAttack'
    else return 'TravelHiding'
  }
}

// hideSword - hides sword when not near victim
function hideSword(bot) {
  const heldItem = bot.heldItem;
  if (heldItem && heldItem.name.toLowerCase().includes('sword')) {
    // ensure slot 2 (index 1) is empty
    const hotbarSlot = 1; // hotbar slot 2 corresponds to index 1
    const destinationSlot = bot.inventory.slots[hotbarSlot];
    const now = Date.now();
    if (bot.lastSwordAttackTime && now - bot.lastSwordAttackTime < 400) {
      // Too soon to unequip after attack
      return;
    }
    if (!destinationSlot) {
      // slot 2 is empty; proceed to unequip
      bot.unequip('hand', hotbarSlot)
    } else {
      console.error('[hideSword] Cannot unequip: Hotbar slot 2 is not empty.');
    }
  }
}

// human head movement with overshoot for large movements
function lerp(a, b, t) {
  return a + (b - a) * t;
}
function easeOutExpo(t) {
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

async function smoothLookSword(bot, targetPos, duration = 600, steps = 24) {
  if (!bot._lastYaw) bot._lastYaw = bot.entity.yaw;
  if (!bot._lastPitch) bot._lastPitch = bot.entity.pitch;
  const startYaw = bot._lastYaw;
  const startPitch = bot._lastPitch;
  const botEye = bot.entity.position.offset ? bot.entity.position.offset(0, bot.entity.height, 0)
                                            : new Vec3(bot.entity.position.x, bot.entity.position.y + bot.entity.height, bot.entity.position.z);
  let targetEye;
  if (targetPos.offset) {
    targetEye = targetPos.offset(0, (targetPos.height || 1) * 0.5 - 0.2, 0);
  } else {
    targetEye = new Vec3(targetPos.x, targetPos.y + ((targetPos.height || 1) * 0.5) - 0.2, targetPos.z);
  }
  const dx = targetEye.x - botEye.x;
  const dy = targetEye.y - botEye.y;
  const dz = targetEye.z - botEye.z;
  const dist = Math.sqrt(dx * dx + dz * dz);
  const targetYaw = Math.atan2(-dx, -dz);
  const targetPitch = -Math.atan2(-dy, dist);

  // calc angular distance (in radians)
  let angularDistance = Math.abs(targetYaw - startYaw);
  if (angularDistance > Math.PI) angularDistance = 2 * Math.PI - angularDistance;
  const threshold = Math.PI / 9; // 20 degrees in radians
  const doOvershoot = angularDistance > threshold && Math.random() < 0.5; // less frequent

  let overshootYaw = targetYaw;
  let overshootPitch = targetPitch;
  if (doOvershoot) {
    // smaller overshoot
    overshootYaw += (Math.random() - 0.5) * (Math.PI / 90);
    overshootPitch += (Math.random() - 0.5) * (Math.PI / 180);
  }

  // add a small chance to intentionally miss a bit
  const missChance = 0.15;
  let missYaw = 0, missPitch = 0;
  if (Math.random() < missChance) {
    missYaw = (Math.random() - 0.5) * (Math.PI / 60);
    missPitch = (Math.random() - 0.5) * (Math.PI / 90);
  }

  // clamp max yaw change per step
  const maxYawStep = Math.PI / 9;

  for (let i = 1; i <= steps; i++) {
    const t = easeOutExpo(i / steps);
    const jitterYaw = (Math.random() - 0.5) * 0.025; // more jitter
    const jitterPitch = (Math.random() - 0.5) * 0.025;
    let yaw = lerp(startYaw, overshootYaw, t) + jitterYaw + missYaw;
    let pitch = lerp(startPitch, overshootPitch, t) + jitterPitch + missPitch;
    let yawDiff = yaw - bot.entity.yaw;
    if (yawDiff > Math.PI) yawDiff -= 2 * Math.PI;
    if (yawDiff < -Math.PI) yawDiff += 2 * Math.PI;
    if (Math.abs(yawDiff) > maxYawStep) {
      yaw = bot.entity.yaw + Math.sign(yawDiff) * maxYawStep;
    }
    bot.look(yaw, pitch, true);
    bot._lastYaw = yaw;
    bot._lastPitch = pitch;
    await new Promise(res => setTimeout(res, duration / steps));
  }

  if (doOvershoot) {
    for (let i = 1; i <= Math.floor(steps / 2); i++) {
      const t = easeOutExpo(i / (steps / 2));
      const jitterYaw = (Math.random() - 0.5) * 0.025;
      const jitterPitch = (Math.random() - 0.5) * 0.025;
      let yaw = lerp(overshootYaw, targetYaw, t) + jitterYaw + missYaw;
      let pitch = lerp(overshootPitch, targetPitch, t) + jitterPitch + missPitch;
      let yawDiff = yaw - bot.entity.yaw;
      if (yawDiff > Math.PI) yawDiff -= 2 * Math.PI;
      if (yawDiff < -Math.PI) yawDiff += 2 * Math.PI;
      if (Math.abs(yawDiff) > maxYawStep) {
        yaw = bot.entity.yaw + Math.sign(yawDiff) * maxYawStep;
      }
      bot.look(yaw, pitch, true);
      bot._lastYaw = yaw;
      bot._lastPitch = pitch;
      await new Promise(res => setTimeout(res, duration / (steps / 2)));
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
    this.lastPosition = null;
    this.stuckTimer = null;
    this.stuckThreshold = 5000;
    this.lastStuckCheck = Date.now();
    this.isPathfinding = false;
    this.pathfindingTimeout = null;
    this.pathfindingTimeoutDuration = 12000;
    this._lastTickTime = 0; // for throttling
  }

  async onStateEntered() {
    console.log('[State] Enter SwordAttack');
    this.bot.currentRole = 'Murderer';
    updateRole('Murderer');
    this.lastAttackTime = Date.now() - this.attackCooldown;
    this.lastPosition = this.bot.entity.position.clone();
    // main update loop (async, throttled)
    this.tickListener = async () => {
      const now = Date.now();
      // throttle: only run main logic every 150ms
      if (now - this._lastTickTime < 150) return;
      this._lastTickTime = now;
      let tickStart;
      if (botConfig.debugPerformance) tickStart = Date.now();

      // main sword attacj logic
      const target = await getNearestPlayerAsync(this.bot);
      if (!target) return;
      if (await isBotAsync(target)) return;
      const dist = this.bot.entity.position.distanceTo(target.position);
      if (this.isPathfinding) return;
      // if the target is more than 3.5 blocks above, switch to pathfinder
      if (target.position.y - this.bot.entity.position.y > 3.5 && !this.isPathfinding) {
        this.switchToPathfinder(target);
        return;
      }
      // in manual movement logic, stop movement if on a ladder
      const blockBelow = this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0));
      const blockAt = this.bot.blockAt(this.bot.entity.position);
      if ((blockBelow && blockBelow.name.includes('ladder')) || (blockAt && blockAt.name.includes('ladder'))) {
        this.bot.setControlState('forward', false);
        this.bot.setControlState('sprint', false);
        this.bot.setControlState('jump', false);
        return;
      }
      if (dist <= 0.5) {
        this.bot.setControlState('forward', false);
        this.bot.setControlState('sprint', false);
        this.bot.setControlState('jump', false);
        // no smoothLookSword, no stuck detection
        // attack logic below will still run
      } else {
        if (Date.now() - this.lastStuckCheck >= 1200) {
          if (this.isStuck()) {
            console.log('[SwordAttack] Bot is stuck. Switching to pathfinder.');
            this.switchToPathfinder(target);
            return;
          }
          this.lastStuckCheck = Date.now();
        }
        if (this.isOnLadder()) {
          this.handleLadderMovement(target);
          return;
        }
        this.bot.setControlState('forward', true);
        this.bot.setControlState('sprint', true);
        this.bot.setControlState('jump', true);
        hideSword(this.bot);
        // only start a new smooth look if not already running or if target changed significantly
        let lookPos = target.position;
        if (typeof lookPos.offset !== 'function') {
          lookPos = new Vec3(lookPos.x, lookPos.y, lookPos.z);
        }
        const targetLook = lookPos.offset(0, target.height / 1.5, 0);
        const lastLook = this.bot._lastLookTarget || new Vec3(0, 0, 0);
        const yawToTarget = Math.atan2(targetLook.x - this.bot.entity.position.x, targetLook.z - this.bot.entity.position.z);
        const lastYaw = this.bot._lastYaw || this.bot.entity.yaw;
        const yawDiff = Math.abs(yawToTarget - lastYaw);
        if (!this.bot._isLooking || yawDiff > Math.PI / 18) { // 10 degrees
          this.bot._isLooking = true;
          this.bot._lastLookTarget = targetLook.clone();
          smoothLookSword(this.bot, targetLook, 600, 24).catch(() => {}).finally(() => {
            this.bot._isLooking = false;
          });
        }
      }
      // within melee range, stop movement and attack
      if (dist <= 1.75) {
        this.bot.setControlState('forward', false);
        this.bot.setControlState('sprint', false);
        this.bot.setControlState('jump', false);
        if (Date.now() - this.lastAttackTime >= this.attackCooldown) {
          const sword = findInventoryItem(this.bot, 'sword');
          if (sword) {
            this.bot.equip(sword, 'hand')
              .then(() => this.bot.attack(target))
              .then(() => {
                this.lastAttackTime = Date.now();
                this.bot.lastSwordAttackTime = Date.now(); // track last sword attack time
                this.attackCooldown = 1000 + Math.random() * 1000;
              })
              .catch(err => console.log('[SwordAttack] Equip/Attack error:', err));
          }
        }
      }
      if (botConfig.debugPerformance) {
        const tickEnd = Date.now();
        console.log(`[SwordAttack] Tick duration: ${tickEnd - tickStart}ms`);
      }
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
    // stop mineflayer-movement if active
    if (this.bot.movement) {
      this.bot.movement.setGoal(null);
    }
    this.isPathfinding = false;
  }

  isFinished() {
    return !hasSword(this.bot); 
  }

  // STUCK DETECTION
  isStuck() {
    const currentPosition = this.bot.entity.position.clone();
    const movedDistance = this.lastPosition.distanceTo(currentPosition);
    if (movedDistance < 0.1) {
      // not moving --> might be stuck
      if (!this.stuckTimer) {
        this.stuckTimer = setTimeout(() => {
          console.log('[SwordAttack] Bot has been stuck for too long. Attempting recovery.');
          // try to strafe left or right randomly
          const direction = Math.random() < 0.5 ? 'left' : 'right';
          this.bot.setControlState(direction, true);
          setTimeout(() => {
            this.bot.setControlState(direction, false);
            // optionally, back up a little
            this.bot.setControlState('back', true);
            setTimeout(() => {
              this.bot.setControlState('back', false);
            }, 400);
          }, 500);
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

    // use pathfinder to move to the target's block
    const mcData = require('minecraft-data')(this.bot.version);
    const movements = new Movements(this.bot, mcData);
    movements.canDig = false;
    movements.maxDropDown = 100;
    const ladderId = mcData.blocksByName.ladder.id;
    movements.blocksToAvoid.add(ladderId);
    movements.allowParkour = false;
    movements.allow1by1towers = false;
    movements.canPlaceBlocks = false;
    this.bot.pathfinder.setMovements(movements);

    const goal = new GoalNear(
      Math.floor(target.position.x),
      Math.floor(target.position.y),
      Math.floor(target.position.z),
      0.4
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

    // main update loop (async)
    this.tickListener = async () => {
      // 1) refresh target list
      this.updateTargets();

      // 2) choose a target
      const target = this.getClosestTarget();
      if (!target) return;

      // 3) use HawkEye angles to physically aim the bot's head (offloaded)
      let targetCenter;
      if (typeof target.position.offset === 'function') {
        targetCenter = target.position.offset(0, (target.height || 1) * 0.35, 0);
      } else {
        targetCenter = new Vec3(target.position.x, target.position.y + ((target.height || 1) * 0.35), target.position.z);
      }
      try {
        const { yaw, pitch } = await getYawPitchAsync(this.bot.entity.position, targetCenter);
        this.bot.look(yaw, -pitch, true);
      } catch (e) {
        console.log('[BowAttack] getYawPitchAsync error:', e);
      }

      // 4) movement logic (chase/backup)
      const dist = this.bot.entity.position.distanceTo(target.position);
      if (!this.isCharging) {
        if (dist > 13.5) {
          this.resetBackup();
          this.bot.setControlState('forward', true);
          this.bot.setControlState('sprint', true);
          this.bot.setControlState('jump', true);
        } else if (dist < 5.0) {
          this.startBackup(dist);
        } else {
          this.stopMoving();
        }
      } else {
        // If charging, ensure all movement is stopped
        this.stopMoving();
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
    return !hasBow(this.bot);
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
    const bow = findInventoryItem(this.bot, 'bow');
    if (!bow) return;

    this.isCharging = true;
    this.stopMoving();

    // Add a small random delay before starting to charge the bow
    await new Promise(res => setTimeout(res, 100 + Math.random() * 200));

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
      // Add a small random delay after firing before resuming movement
      await new Promise(res => setTimeout(res, 80 + Math.random() * 120));
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
    this.isPathfindingToSpot = false; // throttle pathfinding
    this._travelInterval = null;
  }

  async onStateEntered() {
    console.log('[State] Enter travelHiding');
    this.hasMovedToSpot = false;
    this.isPathfindingToSpot = false;

    if (this.currentRole !== 'Innocent') {
      console.log(`[TravelHiding] Role is "${this.currentRole}". Not hiding.`);
      return;
    }

    await wait(5000);
    this.bot.chat('/locraw');

    // Periodically check if we need to pathfind to the hiding spot
    if (this._travelInterval) clearInterval(this._travelInterval);
    this._travelInterval = setInterval(() => {
      if (!this.currentMapTitle) return;
      const hidingSpot = this.mapCoordinates[this.currentMapTitle];
      if (!hidingSpot) return;
      const botPos = this.bot.entity.position;
      const dist = Math.sqrt(
        Math.pow(botPos.x - hidingSpot.x, 2) +
        Math.pow(botPos.y - hidingSpot.y, 2) +
        Math.pow(botPos.z - hidingSpot.z, 2)
      );
      // Only pathfind if not already close and not already pathfinding
      if (!this.isPathfindingToSpot && dist > 1.5) {
        this.goToHidingSpot(hidingSpot);
      }
    }, 2000); // check every 2 seconds
  }

  async onStateExited() {
    console.log('[State] Exit travelHiding');
    if (this.bot.pathfinder.movements) {
      this.bot.pathfinder.setGoal(null);
    }
    if (this._travelInterval) {
      clearInterval(this._travelInterval);
      this._travelInterval = null;
    }
    this.isPathfindingToSpot = false;
  }

  isFinished() {
    return this.hasMovedToSpot; // finish once moved to hiding spot
  }

  // pathfind to the hiding spot (throttled)
  goToHidingSpot(coordinates) {
    const { x, y, z } = coordinates;
    this.isPathfindingToSpot = true;
    this.bot.pathfinder.setMovements(this.defaultMove);
    const goal = new GoalNear(x, y, z, 0.4); // allow 0.4 block radius for hiding
    console.log(`[TravelHiding] Pathfinding to hiding spot at (${x}, ${y}, ${z})...`);
    this.bot.pathfinder.setGoal(goal, true);
    this.bot.once('goal_reached', () => {
      console.log('[TravelHiding] Reached hiding spot!');
      this.hasMovedToSpot = true;
      this.isPathfindingToSpot = false;
    });
  }
}

// build and start state machine
function createMainStateMachine(bot, defaultMove, antiBot) {
  const checkInv = new BehaviorCheckInventory(bot);
  const swordAttack = new BehaviorSwordAttack(bot, antiBot);
  const bowAttack = new BehaviorBowAttack(bot);
  const travelHide = new BehaviorTravelHiding(bot, defaultMove);

  const t1 = new StateTransition({
    parent: checkInv,
    child: swordAttack,
    shouldTransition: () => hasSword(bot),
    priority: 1
  });
  const t2 = new StateTransition({
    parent: checkInv,
    child: bowAttack,
    shouldTransition: () => hasBow(bot) && !hasSword(bot),
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
    shouldTransition: () => !hasSword(bot),
    priority: 1
  });
  const t5 = new StateTransition({
    parent: bowAttack,
    child: checkInv,
    shouldTransition: () => !hasBow(bot),
    priority: 1
  });
  const t6 = new StateTransition({
    parent: travelHide,
    child: checkInv,
    shouldTransition: () => hasSword(bot) || hasBow(bot),
    priority: 1
  });

  const transitions = [t1, t2, t3, t4, t5, t6];
  const rootLayer = new NestedStateMachine(transitions, checkInv);
  return new BotStateMachine(bot, rootLayer);
}

// run the program
const bot = createBot();