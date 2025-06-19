const { parentPort } = require('worker_threads');
const fs = require('fs');

parentPort.on('message', (filePath) => {
  fs.readFile(filePath, 'utf-8', (err, data) => {
    if (err) {
      parentPort.postMessage({ error: err.message });
      return;
    }
    try {
      const parsed = JSON.parse(data);
      parentPort.postMessage({ data: parsed });
    } catch (e) {
      parentPort.postMessage({ error: e.message });
    }
  });
}); 