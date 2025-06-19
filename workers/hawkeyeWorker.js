const { parentPort } = require('worker_threads');

function getYawPitch(botPos, targetPos) {
  const dx = targetPos.x - botPos.x;
  const dy = targetPos.y - botPos.y;
  const dz = targetPos.z - botPos.z;
  const dist = Math.sqrt(dx*dx + dz*dz);
  const yaw = Math.atan2(-dx, -dz);
  const pitch = -Math.atan2(dy, dist);
  return { yaw, pitch };
}

parentPort.on('message', ({ botPos, targetPos }) => {
  parentPort.postMessage(getYawPitch(botPos, targetPos));
}); 