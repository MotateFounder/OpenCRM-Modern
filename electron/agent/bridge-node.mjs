// Node-mode entry of the MCP bridge (run by OpenCRM.exe with ELECTRON_RUN_AS_NODE=1 and inherited stdio,
// because the Electron app process on Windows has no usable stdin).
import { runBridge } from './bridge.js';

const launch = JSON.parse(process.env.OPENCRM_BRIDGE_LAUNCH || '{}');
delete process.env.OPENCRM_BRIDGE_LAUNCH;
await runBridge({
  userData: process.env.OPENCRM_BRIDGE_USERDATA,
  version: process.env.OPENCRM_BRIDGE_VERSION || '2.0.0',
  launchCommand: () => launch,
});
