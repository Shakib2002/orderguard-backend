/**
 * Run this script ONCE to convert Firebase service account JSON
 * to a single-line string for Render env var.
 *
 * Usage:
 *   1. Download service account JSON from Firebase Console
 *   2. Save it as: firebase-service-account.json  (in project root)
 *   3. Run: node scripts/stringify-firebase-key.js
 *   4. Copy the output → paste into Render env var
 *   5. DELETE the JSON file (never commit it!)
 */

const fs   = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'firebase-service-account.json');

if (!fs.existsSync(filePath)) {
  console.error('❌ File not found: firebase-service-account.json');
  console.error('   Download it from: Firebase Console → Project Settings → Service Accounts → Generate new private key');
  process.exit(1);
}

try {
  const raw     = fs.readFileSync(filePath, 'utf8');
  const parsed  = JSON.parse(raw);
  const stringified = JSON.stringify(parsed);

  console.log('\n✅ Copy this value into Render env var: FIREBASE_SERVICE_ACCOUNT_JSON\n');
  console.log('━'.repeat(60));
  console.log(stringified);
  console.log('━'.repeat(60));
  console.log('\n⚠️  DELETE firebase-service-account.json now! Never commit it.\n');
  console.log(`   Project ID: ${parsed.project_id}`);
  console.log(`   Client email: ${parsed.client_email}`);
} catch (err) {
  console.error('❌ Failed to parse JSON:', err.message);
}
