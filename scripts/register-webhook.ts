// Subscribes the PayPal app to PrizeDesk's events: npm run webhook:register -- https://your-app.onrender.com
// Prints the webhook id to put in PAYPAL_WEBHOOK_ID.
import { paypal } from '../src/paypal/client.js';
import { WEBHOOK_EVENTS } from '../src/paypal/webhooks.js';

const base = process.argv[2];
if (!base?.startsWith('https://')) throw new Error('usage: npm run webhook:register -- https://your-app.example.com');
const res = await paypal<{ id: string; url: string }>('POST', '/v1/notifications/webhooks', {
  url: `${base.replace(/\/$/, '')}/api/webhooks/paypal`,
  event_types: WEBHOOK_EVENTS.map((name) => ({ name })),
});
console.log(`webhook ${res.id} -> ${res.url}\nSet PAYPAL_WEBHOOK_ID=${res.id}`);
