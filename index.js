require('dotenv').config();
const express = require('express');
const fs = require('fs');
const cors = require('cors');
const fetch = require('node-fetch');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY_1, {
  apiVersion: '2025-09-30.preview',
});

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());

// Glide constants from environment
const GLIDE_APP_ID = process.env.GLIDE_APP_ID;
const GLIDE_SECRET = process.env.GLIDE_SECRET;
const EMPLOYEES_TABLE_ID = 'native-table-eb1ef03e-3d89-4ee9-a5df-950f57dfebe5';
const STRIPE_SETUP_COL_ID = 'MTVQD'; // Confirm this stays consistent

// Disable bodyParser globally to handle raw
app.use((req, res, next) => {
  if (req.originalUrl === '/create-connected-account') {
    next(); // raw read only
  } else {
    express.json()(req, res, next);
  }
});

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => (body += chunk.toString()));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function updateGlideStripeLink(employeeRowId, setupUrl) {
  const response = await fetch(`https://api.glideapp.io/api/function/mutate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GLIDE_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      appID: GLIDE_APP_ID,
      mutations: [
        {
          kind: 'set-column-values',
          table: EMPLOYEES_TABLE_ID,
          columnValues: { [STRIPE_SETUP_COL_ID]: setupUrl },
          rowID: employeeRowId,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to update Glide row: ${await response.text()}`);
  }

  return true;
}

app.post('/create-connected-account', async (req, res) => {
  let data = {};
  try {
    const rawBody = await readRawBody(req);
    const parsed = JSON.parse(rawBody.trim());
    data = typeof parsed.body === 'string' ? JSON.parse(parsed.body) : parsed.body || parsed;
  } catch (err) {
    console.error('❌ Body parse error:', err.message);
    return res.status(400).json({ error: 'Malformed request body' });
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
    return res.status(400).json({ error: 'Missing employee_row_id or email' });
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
        transfers: { requested: true },
      },
      business_profile: { url: 'https://tipsandtrim.com' },
      metadata: { employee_row_id },
    });

    // Create onboarding link
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: 'https://tipsandtrim.com/reauth',
      return_url: 'https://tipsandtrim.com/return',
      type: 'account_onboarding',
    });

    // Push onboarding link to Glide row
    await updateGlideStripeLink(employee_row_id, accountLink.url);
    res.json({ onboarding_url: accountLink.url });
  } catch (err) {
    console.error('❌ Stripe account creation failed:', err.message);
    res.status(500).json({ error: 'Could not create Stripe account' });
  }
});

// Health check
app.get('/', (req, res) => res.send('Tips & Trim API is live!'));
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
