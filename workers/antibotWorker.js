const { parentPort } = require('worker_threads');

parentPort.on('message', (entity) => {
  let isBot = false;
  if (!entity || entity.type !== 'player') isBot = false;
  else if (entity.username && entity.username.startsWith('§c')) isBot = true;
  else if (entity.displayName && entity.displayName.includes('[NPC]')) isBot = true;
  // add more checks as needed
  parentPort.postMessage(isBot);
}); 