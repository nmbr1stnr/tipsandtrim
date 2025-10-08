require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY_1, {
  apiVersion: '2025-09-30.preview',
});

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());

const mappingsPath = '/data/mappings.json';

// Ensure mappings file exists
if (!fs.existsSync(mappingsPath)) {
  fs.writeFileSync(mappingsPath, '{}');
  console.log('✅ Created mappings.json on first run.');
}

// Disable bodyParser globally; handle raw reads manually
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook' || req.originalUrl === '/create-connected-account') {
    next(); // Skip default JSON parsing
  } else {
    express.json()(req, res, next);
  }
});

// 🧠 Helper: read raw body data safely
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => (body += chunk.toString()));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// 🔧 Create Stripe Connected Account
app.post('/create-connected-account', async (req, res) => {
  let rawBody = '';
  let data = {};

  try {
    rawBody = await readRawBody(req);
    if (!rawBody) throw new Error('Empty body');

    // Handle cases like ""employee_row_id": "abc"..."
    let fixed = rawBody.trim();

    // If Glide wraps JSON inside another "body" field
    if (fixed.startsWith('{') && fixed.includes('"body":')) {
      const parsed = JSON.parse(fixed);
      fixed = typeof parsed.body === 'string' ? parsed.body : JSON.stringify(parsed.body);
    }

    // Ensure braces
    if (!fixed.startsWith('{')) fixed = '{' + fixed;
    if (!fixed.endsWith('}')) fixed = fixed + '}';

    data = JSON.parse(fixed);
  } catch (err) {
    console.error('❌ Failed to parse incoming body:', rawBody);
    return res.status(400).json({ error: 'Invalid or malformed JSON body' });
  }

  const {
    employee_row_id,
    name,
    email,
    employer_email = '',
    type = 'express',
    business_type = 'individual',
  } = data;

  if (!employee_row_id || !email) {
    return res.status(400).json({ error: 'Missing required fields: employee_row_id or email' });
  }

  try {
    // 1️⃣ Create Stripe connected account
    const account = await stripe.accounts.create({
      type,
      country: 'US',
      email,
      business_type,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_profile: { url: 'https://tipsandtrim.com' },
    });

    // 2️⃣ Save the mapping
    const mappings = JSON.parse(fs.readFileSync(mappingsPath, 'utf8') || '{}');
    mappings[employee_row_id] = account.id;
    fs.writeFileSync(mappingsPath, JSON.stringify(mappings, null, 2));

    // 3️⃣ Create onboarding link
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: 'https://tipsandtrim.com/reauth',
      return_url: 'https://tipsandtrim.com/return',
      type: 'account_onboarding',
    });

    res.json({ onboarding_url: accountLink.url });
  } catch (err) {
    console.error('❌ Stripe account creation error:', err);
    res.status(500).json({ error: 'Something went wrong while creating the account.' });
  }
});

// ✅ Webhook for onboarding completion
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (err) {
    console.error('❌ Webhook parse error:', err.message);
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  if (event.type === 'account.updated') {
    const account = event.data.object;
    if (account.charges_enabled && account.payouts_enabled && account.details_submitted) {
      console.log(`✅ Onboarding complete for account ${account.id}`);

      const mappings = JSON.parse(fs.readFileSync(mappingsPath, 'utf8') || '{}');
      const employee_row_id = Object.keys(mappings).find(k => mappings[k] === account.id);
      if (!employee_row_id) {
        console.warn(`⚠️ No mapping found for ${account.id}`);
        return res.sendStatus(200);
      }

      try {
        const loginLink = await stripe.accounts.createLoginLink(account.id);

        await fetch('https://go.glideapps.com/api/container/plugin/webhook-trigger/BDkkdHH3iqEDpVk1nljo/450f83fd-40a3-4b95-b0c5-9ab87cad56cb-webhook-url.com', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            employee_row_id,
            stripe_dashboard_url: loginLink.url,
            is_onboarded: true,
          }),
        });

        console.log(`📨 Sent login link to Glide for row ${employee_row_id}`);
      } catch (err) {
        console.error('❌ Failed to notify Glide:', err.message);
      }
    }
  }
  res.sendStatus(200);
});

// 🌐 Health check route
app.get('/', (req, res) => res.send('Tips & Trim API is live!'));
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

// 🔁 Retrieve Stripe Remediation (Onboarding) Link
app.get('/get-remediation-link', async (req, res) => {
  const { employee_row_id } = req.query;

  if (!employee_row_id) {
    return res.status(400).json({ error: 'Missing employee_row_id in query' });
  }

  try {
    const mappings = JSON.parse(fs.readFileSync(mappingsPath, 'utf8') || '{}');
    const accountId = mappings[employee_row_id];

    if (!accountId) {
      return res.status(404).json({ error: `No Stripe account found for row ID ${employee_row_id}` });
    }

    const remediationLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: 'https://tipsandtrim.com/reauth',
      return_url: 'https://tipsandtrim.com/return',
      type: 'account_onboarding',
    });

    res.json({
      employee_row_id,
      remediation_url: remediationLink.url,
    });
  } catch (err) {
    console.error('❌ Failed to get remediation link:', err.message);
    res.status(500).json({ error: 'Unable to fetch remediation link' });
  }
});
