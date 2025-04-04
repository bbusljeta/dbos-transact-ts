import { DBOS, WorkflowQueue } from '../src';
import { generateDBOSTestConfig, Event, queueEntriesAreCleanedUp } from '../tests/helpers';

// Extract worker arguments from command-line input
const workerId = process.env.DBOS__VMID;
if (!workerId) {
  console.error('Worker ID not provided');
  process.exit(1);
}
const localConcurrencyLimit = parseInt(process.argv[2] || '0', 10);
if (localConcurrencyLimit === 0) {
  console.error('Local concurrency limit not provided');
  process.exit(1);
}
const globalConcurrencyLimit = parseInt(process.argv[3] || '0', 10);
if (globalConcurrencyLimit === 0) {
  console.error('Global concurrency limit not provided');
  process.exit(1);
}
const parentWorkflowID = process.argv[4];
if (!parentWorkflowID) {
  console.error('Parent workflow ID not provided');
  process.exit(1);
}
const queueName = process.argv[5];
if (!queueName) {
  console.error('Queue name not provided');
  process.exit(1);
}
console.log(
  `Worker ID: ${workerId}, Global Concurrency Limit: ${globalConcurrencyLimit}, Local Concurrency Limit: ${localConcurrencyLimit}, Parent Workflow ID: ${parentWorkflowID}, Queue Name: ${queueName}`,
);

// Declare worker queue with controlled concurrency
new WorkflowQueue(queueName, {
  workerConcurrency: localConcurrencyLimit,
  concurrency: globalConcurrencyLimit,
});

class InterProcessWorkflowTask {
  // Create a bunch of re-usable events. Increase the length if needed.
  static start_events = Array.from({ length: 20 }, () => new Event());
  static end_event = new Event();

  @DBOS.workflow()
  static async task(i: number) {
    InterProcessWorkflowTask.start_events[i].set();
    console.log(`${workerId} started task ${i}`);
    await InterProcessWorkflowTask.end_event.wait();
    return Promise.resolve();
  }
}

async function main() {
  const config = generateDBOSTestConfig();
  DBOS.setConfig(config);
  await DBOS.launch();

  // Wait to dequeue as many tasks as we can locally
  for (let i = 0; i < localConcurrencyLimit; i++) {
    await InterProcessWorkflowTask.start_events[i].wait();
    // Notify the main process this worker has dequeued a task
    await DBOS.send<string>(parentWorkflowID, 'worker_dequeue', 'worker_dequeue', `${workerId?.toString()}-task-${i}`);
  }
  console.log(`${workerId} dequeued ${localConcurrencyLimit} tasks`);

  // Wait for a resume signal from the main process
  const can_resume = await DBOS.getEvent(parentWorkflowID, 'worker_resume');
  if (!can_resume) {
    console.error(`${workerId} did not receive resume signal`);
    process.exit(1);
  }

  // Complete the tasks. 1 set should unlock them all.
  InterProcessWorkflowTask.end_event.set();

  const success = await queueEntriesAreCleanedUp();
  if (!success) {
    console.error(`${workerId} detected unhandled workflow queue entries`);
    process.exit(1);
  }

  await DBOS.shutdown();
  process.exit(0);
}

// Run the worker if executed as a standalone script
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
