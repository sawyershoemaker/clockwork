// shoutout raven and its opensourced modules for this, couldnt find much online about how antibot's work and
// refactoring the module into this was an awesome learning experience and im super proud of myself but 
// couldn't have done it without that base so s/o raven client (open-sourced goat)

const { EventEmitter } = require('events');
const { builtinModules } = require('module')

class AntiBot extends EventEmitter {
  constructor(bot) {
    super();
    this.bot = bot;
    this.newEntities = new Map(); // to store new entities
    this.ms = 4000; // time in ms to keep track of entities
    this.waitTicks = false;

    bot.on('entitySpawn', this.onEntitySpawn.bind(this));
    bot.on('physicTick', this.update.bind(this));
  }

  // handle entity spawn
  onEntitySpawn(entity) {
    if (this.waitTicks && entity.type === 'player' && entity.username !== this.bot.username) {
      this.newEntities.set(entity.uuid, Date.now());
    }
  }

  // update method to remove old entities
  update() {
    if (this.waitTicks && this.newEntities.size > 0) {
      const now = Date.now();
      for (const [uuid, timestamp] of this.newEntities) {
        if (now - timestamp > this.ms) {
          this.newEntities.delete(uuid);
        }
      }
    }
  }

  // check if an entity is a bot
  isBot(entity) {
    if (!entity || entity.type !== 'player') return false;

    // example checks
    if (entity.username.startsWith('§c')) return true;
    if (this.newEntities.has(entity.uuid)) return true;

    const displayName = entity.displayName?.toString() || '';
    if (displayName.includes('[NPC]')) return true;

    return false;
  }
}

module.exports = AntiBot;