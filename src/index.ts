import { createServer } from './server.js';
import { ownedChatgptStartupOptions } from './computer/chatgpt-startup.js';

const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== '--chatgpt-desktop')) {
  console.error('Unknown DeckIDE server startup option');
  process.exit(1);
}
createServer(args.length ? ownedChatgptStartupOptions() : {}).catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
