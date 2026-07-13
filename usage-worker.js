const { parentPort } = require('worker_threads');
const { parseTranscript } = require('./usage');

let titles = new Map();

parentPort.on('message', (message) => {
  if (message.type === 'init') {
    titles = new Map(message.titles);
    return;
  }
  if (message.type === 'stop') {
    process.exit(0);
  }
  if (message.type !== 'parse') return;

  try {
    parentPort.postMessage({ file: message.file, session: parseTranscript(message.file, titles) });
  } catch (error) {
    parentPort.postMessage({ file: message.file, error: error instanceof Error ? error.message : String(error) });
  }
});
