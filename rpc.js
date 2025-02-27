const RPC = require('discord-rpc');

const clientId = '1331184169753120778';

// registir client id
RPC.register(clientId);

// create da client
const rpc = new RPC.Client({ transport: 'ipc' });

// track role (innocent by default)
let currentRole = 'Innocent';
let dotCount = 0; // dot tracker (definitely a better way to do this im just dumb)

// set up Rich Presence
function setRichPresence(role = 'Innocent', dots = '') {
  rpc.setActivity({
    details: `mm bot running${dots}`,
    state: `Role: ${role}`,
    startTimestamp: Date.now(),
    instance: false,
    buttons: [
      {
      }
    ],
  });
}

// function to update the role
function updateRole(newRole) {
  if (currentRole !== newRole) {
    currentRole = newRole;
    setRichPresence(currentRole, '.'.repeat(dotCount)); // updates presence with current dots
  }
}

// function to cycle dots
function cycleDots() {
  setInterval(() => {
    dotCount = (dotCount + 1) % 4; // cycles between 0 and 3 dots
    setRichPresence(currentRole, '.'.repeat(dotCount));
  }, 500); // update every half second
}

// event listeners for the RPC client
rpc.on('ready', () => {
  console.log('[Discord RPC] Connected!');
  setRichPresence(currentRole); // set initial presence
  cycleDots(); // begin dot animation
});

rpc.on('disconnected', () => {
  console.log('[Discord RPC] Disconnected. Attempting to reconnect...');
  reconnectRPC();
});

rpc.on('error', (err) => {
  console.error('[Discord RPC] Error occurred:', err);
});

// function to handle reconnection
function reconnectRPC() {
  setTimeout(() => {
    rpc.login({ clientId }).catch(console.error);
  }, 5000); // attempt to reconnect every 5 secs
}

// start rpc
rpc.login({ clientId }).catch((err) => {
  console.error('[Discord RPC] Failed to connect:', err);
  reconnectRPC();
});

// export role updater for other files
module.exports = {
  rpc,
  updateRole,
};
