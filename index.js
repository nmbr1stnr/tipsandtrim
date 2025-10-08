require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
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

// Path for mapping Stripe accounts to Glide Row IDs
const mappingsPath = '/data/mappings.json';

// Body parser — skip for raw webhook requests
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook') {
    next();
  } else {
    bodyParser.json()(req, res, next);
  }
});

// Ensure the mappings file exists
if (!fs.existsSync(mappingsPath)) {
  fs.writeFileSync(mappingsPath, '{}');
  console.log('✅ Created mappings.json on first run.');
}

// 🔧 Create Stripe Connected Account
app.post('/create-connected-account', async (req, res) => {
  let data;

  // Try parsing from body.body (Glide), or fallback to body, or query
  try {
    if (typeof req.body.body === 'string') {
      data = JSON.parse(req.body.body);
    } else if (typeof req.body.body === 'object') {
      data = req.body.body;
    } else if (typeof req.body === 'object' && Object.keys(req.body).length > 0) {
      data = req.body;
    } else {
      data = req.query;
    }
  } catch (err) {
    console.error('❌ Failed to parse body:', err.message);
    return res.status(400).json({ error: 'Invalid JSON format in request body' });
  }

  const {
    employee_row_id,
    name,
    email,
    employer_email = '',
    type = 'express',
    business_type = 'individual'
  } = data;

  if (!employee_row_id || !email) {
    return res.status(400).json({ error: 'Missing required fields: employee_row_id or email' });
  }

  try {
    // Create Stripe connected account
    const account = await stripe.accounts.create({
      type,
      country: 'US',
      email,
      business_type,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true }
      },
      business_profile: {
        url: 'https://tipsandtrim.com'
      }
    });

    // Save the mapping
    const mappings = JSON.parse(fs.readFileSync(mappingsPath, 'utf8') || '{}');
    mappings[employee_row_id] = account.id;
    fs.writeFileSync(mappingsPath, JSON.stringify(mappings, null, 2));

    // Create onboarding link
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: 'https://tipsandtrim.com/reauth',
      return_url: 'https://tipsandtrim.com/return',
      type: 'account_onboarding'
    });

    res.json({ onboarding_url: accountLink.url });
  } catch (err) {
    console.error('❌ Stripe error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ✅ Webhook to detect completed onboarding
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
      const employee_row_id = Object.keys(mappings).find(key => mappings[key] === account.id);

      if (!employee_row_id) {
        console.warn(`⚠️ No matching row ID for account ID: ${account.id}`);
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
            is_onboarded: true
          })
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
app.get('/', (req, res) => {
  res.send('Tips & Trim API is live!');
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
