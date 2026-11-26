import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSendGridMailer } from '../src/accounts.js';
import { createGuessMailer, createSubmissionMailer } from '../src/notifications.js';

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
  assert.deepEqual(body.from, { email: 'signin@guesswhossanta.com', name: "Santa's Helpers | Guess Who's Santa" });
  assert.match(body.subject, /Santa's helpers.*sign-in code/);
  assert.doesNotMatch(body.subject, /001234/);
  assert.deepEqual(body.content.map((part) => part.type), ['text/plain', 'text/html']);
  for (const { value } of body.content) {
    assert.match(value, /Santa's helpers/);
    assert.match(value, /001234/);
    assert.match(value, /10 minutes/);
    assert.match(value, /only in that browser/);
    assert.match(value, /Never share/);
    assert.match(value, /If you did not request it/);
  }
  const html = body.content[1].value;
  assert.match(html, /<img src="https:\/\/guesswhossanta\.com\/icon-512\.png"[^>]+alt="[^"]+"/);
  assert.match(html, /<p[^>]*>001234<\/p>/);
  assert.doesNotMatch(html, /<script|<form|<svg|data:image/i);
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

test('guessing emails contain private links without click tracking', async (t) => {
  const request = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 202 }));
  const send = createGuessMailer({ apiKey: 'test-key', sender: 'signin@example.com' });
  const link = `https://example.com/p/ABCDEF#access=${'a'.repeat(43)}`;
  await send({ email: 'recipient@example.com', link });
  const body = JSON.parse(request.mock.calls[0].arguments[1].body);
  assert.deepEqual(body.tracking_settings.click_tracking, { enable: false, enable_text: false });
  assert.ok(body.content.every((part) => part.value.includes(link)));
  assert.match(body.content[0].value, /don't share/);
});

test('submission emails identify the player safely and include a private link', async (t) => {
  const request = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 202 }));
  const send = createSubmissionMailer({ apiKey: 'test-key', sender: 'signin@example.com' });
  const link = `https://example.com/p/ABCDEF#access=${'a'.repeat(43)}`;
  await send({ email: 'host@example.com', link, playerName: "A & B's" });
  const body = JSON.parse(request.mock.calls[0].arguments[1].body);
  assert.deepEqual(body.personalizations, [{ to: [{ email: 'host@example.com' }] }]);
  assert.deepEqual(body.tracking_settings.click_tracking, { enable: false, enable_text: false });
  assert.ok(body.content.every((part) => part.value.includes(link)));
  assert.match(body.content[0].value, /A & B's submitted/);
  assert.match(body.content[1].value, /A &amp; B&#39;s submitted/);
  assert.match(body.content[0].value, /don't share/);
  assert.equal(createSubmissionMailer({ sender: 'signin@example.com' }), undefined);
  request.mock.mockImplementation(async () => new Response(null, { status: 503 }));
  await assert.rejects(send({ email: 'host@example.com', link, playerName: 'Alex' }), { name: 'SendGridDeliveryError', status: 503 });
});
