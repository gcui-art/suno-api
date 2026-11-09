import { startSunoCreateRun, finishSunoCreateRun, getRecentSunoCreateRuns } from '../src/lib/sunoCreateRunStore';

async function test() {
  try {
    console.log('Testing startSunoCreateRun and finishSunoCreateRun...');
    
    const id1 = await startSunoCreateRun('acc-1', 'email1@example.com');
    console.log('Run 1 started. ID returned:', id1);

    const id2 = await startSunoCreateRun('acc-2', 'email2@example.com');
    console.log('Run 2 started. ID returned:', id2);

    console.log('Finishing run 1 as success...');
    await finishSunoCreateRun(id1, 'success', 'Music generated successfully');

    console.log('Finishing run 2 as failed...');
    await finishSunoCreateRun(id2, 'failed', 'Timeout waiting for response');

    const runs = await getRecentSunoCreateRuns(5);
    console.log('Recent 5 runs in DB:', JSON.stringify(runs, null, 2));

  } catch (e) {
    console.error('Test failed with error:', e);
  }
}

test();
