import { inventory, formatInventory } from '../archive/inventory.js';

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case 'inventory': {
    if (!args[0]) { console.error('usage: inventory <archive.zip>'); process.exit(1); }
    console.log(formatInventory(await inventory(args[0])));
    break;
  }
  default:
    console.error(`unknown command: ${cmd ?? '(none)'}`);
    console.error('commands: inventory');
    process.exit(1);
}
