const { parentPort, workerData } = require('worker_threads');

parentPort.on('message', ({ entities, position }) => {
  let closest = null;
  let closestDistance = Infinity;
  for (const entity of entities) {
    if (!entity.position) continue;
    const dx = entity.position.x - position.x;
    const dy = entity.position.y - position.y;
    const dz = entity.position.z - position.z;
    const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
    if (dist < closestDistance) {
      closestDistance = dist;
      closest = entity;
    }
  }
  parentPort.postMessage({ closest, closestDistance });
}); 