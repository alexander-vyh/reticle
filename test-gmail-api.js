#!/usr/bin/env node
'use strict';

const assert = require('assert');

// --- Mock Gmail client builder ---
function mockGmailClient({ listResults, getResults, modifyResults } = {}) {
  const calls = { list: [], get: [], modify: [] };
  return {
    calls,
    users: {
      messages: {
        list: async (params) => { calls.list.push(params); return listResults || { data: {} }; },
        get: async (params) => { calls.get.push(params); return getResults?.(params) || { data: {} }; },
        modify: async (params) => { calls.modify.push(params); return modifyResults || { data: {} }; }
      }
    }
  };
}

// We'll require the module after writing it — test should fail on missing module first
let gmailApi;
try {
  gmailApi = require('./lib/gmail-api');
} catch (e) {
  console.error('FAIL: lib/gmail-api.js does not exist yet');
  process.exit(1);
}

async function runTests() {
  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL: ${name}`);
      console.error(`    ${err.message}`);
      failed++;
    }
  }

  console.log('test-gmail-api.js');
  console.log('');

  // --- searchRecentUnread ---

  console.log('searchRecentUnread()');

  await test('returns parsed email objects with from, to, cc, subject, date, snippet', async () => {
    const client = mockGmailClient({
      listResults: {
        data: { messages: [{ id: 'msg1', threadId: 'th1' }, { id: 'msg2', threadId: 'th2' }] }
      },
      getResults: (params) => {
        if (params.id === 'msg1') {
          return { data: {
            id: 'msg1', threadId: 'th1', snippet: 'Hello there',
            payload: { headers: [
              { name: 'From', value: '"Alice" <alice@example.com>' },
              { name: 'To', value: 'bob@example.com' },
              { name: 'Cc', value: 'charlie@example.com' },
              { name: 'Subject', value: 'Test email' },
              { name: 'Date', value: 'Thu, 05 Mar 2026 09:00:00 -0600' }
            ]}
          }};
        }
        return { data: {
          id: 'msg2', threadId: 'th2', snippet: 'Second email',
          payload: { headers: [
            { name: 'From', value: 'vendor@spam.com' },
            { name: 'Subject', value: 'Buy now' },
            { name: 'Date', value: 'Thu, 05 Mar 2026 09:05:00 -0600' }
          ]}
        }};
      }
    });

    const emails = await gmailApi.searchRecentUnread(client, { maxResults: 50 });

    assert.strictEqual(emails.length, 2);
    assert.strictEqual(emails[0].id, 'msg1');
    assert.strictEqual(emails[0].threadId, 'th1');
    assert.strictEqual(emails[0].from, '"Alice" <alice@example.com>');
    assert.strictEqual(emails[0].to, 'bob@example.com');
    assert.strictEqual(emails[0].cc, 'charlie@example.com');
    assert.strictEqual(emails[0].subject, 'Test email');
    assert.strictEqual(emails[0].snippet, 'Hello there');
    assert.ok(emails[0].date);

    // Second email has no To/Cc
    assert.strictEqual(emails[1].to, '');
    assert.strictEqual(emails[1].cc, '');
  });

  await test('returns empty array when no messages found', async () => {
    const client = mockGmailClient({ listResults: { data: {} } });
    const emails = await gmailApi.searchRecentUnread(client);
    assert.deepStrictEqual(emails, []);
  });

  await test('passes query and maxResults to messages.list', async () => {
    const client = mockGmailClient({ listResults: { data: {} } });
    await gmailApi.searchRecentUnread(client, { maxResults: 25 });
    assert.strictEqual(client.calls.list.length, 1);
    assert.strictEqual(client.calls.list[0].userId, 'me');
    assert.ok(client.calls.list[0].q.includes('is:unread'));
    assert.strictEqual(client.calls.list[0].maxResults, 25);
  });

  await test('fetches each message with format metadata', async () => {
    const client = mockGmailClient({
      listResults: { data: { messages: [{ id: 'msg1' }] } },
      getResults: () => ({ data: {
        id: 'msg1', threadId: 'th1', snippet: '',
        payload: { headers: [
          { name: 'From', value: 'a@b.com' },
          { name: 'Subject', value: 'hi' },
          { name: 'Date', value: 'Thu, 05 Mar 2026 09:00:00 -0600' }
        ]}
      }})
    });

    await gmailApi.searchRecentUnread(client);
    assert.strictEqual(client.calls.get[0].format, 'metadata');
    assert.deepStrictEqual(client.calls.get[0].metadataHeaders, ['From', 'To', 'Cc', 'Subject', 'Date']);
  });

  // --- archiveMessage ---

  console.log('');
  console.log('archiveMessage()');

  await test('calls modify with removeLabelIds INBOX', async () => {
    const client = mockGmailClient();
    const result = await gmailApi.archiveMessage(client, 'msg123');
    assert.strictEqual(result, true);
    assert.strictEqual(client.calls.modify.length, 1);
    assert.strictEqual(client.calls.modify[0].userId, 'me');
    assert.strictEqual(client.calls.modify[0].id, 'msg123');
    assert.deepStrictEqual(client.calls.modify[0].requestBody.removeLabelIds, ['INBOX']);
  });

  await test('returns false on API error', async () => {
    const client = {
      users: { messages: {
        modify: async () => { throw new Error('API error'); }
      }}
    };
    const result = await gmailApi.archiveMessage(client, 'msg123');
    assert.strictEqual(result, false);
  });

  // --- trashMessage ---

  console.log('');
  console.log('trashMessage()');

  await test('calls modify with addLabelIds TRASH and removeLabelIds INBOX', async () => {
    const client = mockGmailClient();
    const result = await gmailApi.trashMessage(client, 'msg456');
    assert.strictEqual(result, true);
    assert.strictEqual(client.calls.modify.length, 1);
    assert.deepStrictEqual(client.calls.modify[0].requestBody.addLabelIds, ['TRASH']);
    assert.deepStrictEqual(client.calls.modify[0].requestBody.removeLabelIds, ['INBOX']);
  });

  await test('returns false on API error', async () => {
    const client = {
      users: { messages: {
        modify: async () => { throw new Error('API error'); }
      }}
    };
    const result = await gmailApi.trashMessage(client, 'msg456');
    assert.strictEqual(result, false);
  });

  // --- tagMessage ---

  console.log('');
  console.log('tagMessage()');

  await test('calls modify with addLabelIds for the given label', async () => {
    const client = mockGmailClient();
    const result = await gmailApi.tagMessage(client, 'msg789', 'IMPORTANT');
    assert.strictEqual(result, true);
    assert.deepStrictEqual(client.calls.modify[0].requestBody.addLabelIds, ['IMPORTANT']);
  });

  await test('returns false on API error', async () => {
    const client = {
      users: { messages: {
        modify: async () => { throw new Error('API error'); }
      }}
    };
    const result = await gmailApi.tagMessage(client, 'msg789', 'LABEL');
    assert.strictEqual(result, false);
  });

  // --- createFilter ---

  console.log('');
  console.log('createFilter()');

  await test('calls filters.create with correct criteria and action', async () => {
    const createCalls = [];
    const client = {
      users: {
        settings: {
          filters: {
            create: async (params) => { createCalls.push(params); return { data: { id: 'filter1' } }; }
          }
        }
      }
    };

    const result = await gmailApi.createFilter(client, {
      from: 'it@simpli.fi',
      addLabelIds: ['Label_123'],
      removeLabelIds: ['INBOX', 'UNREAD']
    });

    assert.strictEqual(result.id, 'filter1');
    assert.strictEqual(createCalls.length, 1);
    assert.strictEqual(createCalls[0].userId, 'me');
    assert.strictEqual(createCalls[0].requestBody.criteria.from, 'it@simpli.fi');
    assert.deepStrictEqual(createCalls[0].requestBody.action.addLabelIds, ['Label_123']);
    assert.deepStrictEqual(createCalls[0].requestBody.action.removeLabelIds, ['INBOX', 'UNREAD']);
  });

  await test('returns null on API error', async () => {
    const client = {
      users: { settings: { filters: {
        create: async () => { throw new Error('API error'); }
      }}}
    };
    const result = await gmailApi.createFilter(client, { from: 'x@y.com' });
    assert.strictEqual(result, null);
  });

  // --- getGmailClient ---

  console.log('');
  console.log('getGmailClient()');

  await test('is exported as a function', async () => {
    assert.strictEqual(typeof gmailApi.getGmailClient, 'function');
  });

  // --- Summary ---
  console.log('');
  console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
