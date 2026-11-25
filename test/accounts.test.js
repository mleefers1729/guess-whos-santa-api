import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSendGridMailer } from '../src/accounts.js';

test('SendGrid sends the browser-bound code using the authenticated sender', async (t) => {
  const request = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 202 }));
  const send = createSendGridMailer({ apiKey: 'test-key', sender: 'signin@guesswhossanta.com' });
  await send({ email: 'recipient@example.com', code: '001234' });
  const [url, options] = request.mock.calls[0].arguments;
  assert.equal(url, 'https://api.sendgrid.com/v3/mail/send');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.Authorization, 'Bearer test-key');
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.ok(options.signal instanceof AbortSignal);
  const body = JSON.parse(options.body);
  assert.deepEqual(body.personalizations, [{ to: [{ email: 'recipient@example.com' }] }]);
  assert.deepEqual(body.from, { email: 'signin@guesswhossanta.com', name: "Guess Who's Santa" });
  assert.equal(body.content[0].type, 'text/plain');
  assert.match(body.content[0].value, /001234/);
  assert.match(body.content[0].value, /10 minutes.*browser/);
});

test('SendGrid failures propagate without exposing provider responses or credentials', async (t) => {
  const request = t.mock.method(globalThis, 'fetch');
  const send = createSendGridMailer({ apiKey: 'test-key', sender: 'signin@guesswhossanta.com' });
  for (const status of [200, 400, 401, 403, 429, 500]) {
    request.mock.mockImplementation(async () => new Response('sensitive provider response', { status }));
    await assert.rejects(send({ email: 'recipient@example.com', code: '123456' }), (error) => {
      assert.equal(error.status, status);
      assert.equal(error.name, 'SendGridDeliveryError');
      assert.doesNotMatch(error.message, /sensitive|test-key|123456|recipient/);
      return true;
    });
  }
  for (const error of [new TypeError('Network failure'), new DOMException('Timed out', 'TimeoutError')]) {
    request.mock.mockImplementation(async () => { throw error; });
    await assert.rejects(send({ email: 'recipient@example.com', code: '123456' }), error);
  }
});

test('incomplete email configuration disables delivery explicitly', () => {
  assert.equal(createSendGridMailer({ sender: 'signin@guesswhossanta.com' }), undefined);
  assert.equal(createSendGridMailer({ apiKey: 'test-key' }), undefined);
});
