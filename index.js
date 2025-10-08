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

// ✅ Environment Variables
const GLIDE_APP_ID = process.env.GLIDE_APP_ID;
const GLIDE_SECRET = process.env.GLIDE_SECRET;
const EMPLOYEES_TABLE_ID = 'native-table-eb1ef03e-3d89-4ee9-a5df-950f57dfebe5';
const STRIPE_SETUP_COL_ID = 'MTVQD'; // Column ID for 'stripeSetupLink' in Glide

if (!GLIDE_APP_ID || !GLIDE_SECRET || !process.env.STRIPE_SECRET_KEY_1) {
  console.warn('⚠️ One or more environment variables are missing (GLIDE_APP_ID, GLIDE_SECRET, STRIPE_SECRET_KEY_1)');
}

// 🔧 Middleware: Handle raw body for specific route
app.use((req, res, next) => {
  if (req.originalUrl === '/create-connected-account') {
    next(); // Skip JSON parsing
  } else {
    express.json()(req, res, next);
  }
});

// 📦 Helper: Read raw body safely
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => (body += chunk.toString()));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// ✏️ Helper: Update a Glide row with Stripe onboarding URL
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
          rowID: employeeRowId,
          columnValues: {
            [STRIPE_SETUP_COL_ID]: setupUrl,
          },
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`❌ Glide update failed: ${errorText}`);
  }

  return true;
}

// 🚀 Create Stripe Connected Account & Send Link to Glide
app.post('/create-connected-account', async (req, res) => {
  let rawBody = '';
  let data = {};

  try {
    rawBody = await readRawBody(req);

    if (rawBody && rawBody.trim()) {
      let fixed = rawBody.trim();

      // Handle if Glide wraps body inside "body"
      if (fixed.startsWith('{') && fixed.includes('"body":')) {
        const parsed = JSON.parse(fixed);
        fixed = typeof parsed.body === 'string' ? parsed.body : JSON.stringify(parsed.body);
      }

      // Ensure valid JSON structure
      if (!fixed.startsWith('{')) fixed = '{' + fixed;
      if (!fixed.endsWith('}')) fixed = fixed + '}';

      data = JSON.parse(fixed);
    } else {
      // 🌐 Fallback: Read from query string
      data = {
        name: req.query['Employee Name']?.value || '',
        email: req.query['Email']?.value || '',
        employee_row_id: req.query['🔒 Row ID']?.value || '',
      };
    }
  } catch (err) {
    console.error('❌ Body parse error:', err.message);
    return res.status(400).json({ error: 'Invalid or malformed JSON or query string' });
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
    return res.status(400).json({ error: 'Missing required: employee_row_id or email' });
  }

  try {
    // 1️⃣ Create connected Stripe account
    const account = await stripe.accounts.create({
      type,
      country: 'US',
      email,
      business_type,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_profile: {
        url: 'https://tipsandtrim.com',
      },
      metadata: {
        employee_row_id: String(employee_row_id),
      },
    });

    // 2️⃣ Create onboarding link
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: 'https://tipsandtrim.com/reauth',
      return_url: 'https://tipsandtrim.com/return',
      type: 'account_onboarding',
    });

    // 3️⃣ Push link to Glide
    await updateGlideStripeLink(employee_row_id, accountLink.url);

    // ✅ All done
    res.json({
      onboarding_url: accountLink.url,
      message: `Stripe account created and onboarding URL sent to Glide row ${employee_row_id}`,
    });
  } catch (err) {
    console.error('❌ Stripe account creation failed:', err.message);
    res.status(500).json({ error: 'Failed to create Stripe account or update Glide' });
  }
});

// ✅ Health Check
app.get('/', (req, res) => res.send('Tips & Trim API is live!'));
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
